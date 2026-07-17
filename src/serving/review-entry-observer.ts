import { createHash } from "node:crypto";
import { watch, type FSWatcher } from "node:fs";
import path from "node:path";
import { Effect, FiberSet, type Scope } from "effect";
import {
  openAuthorizedFile,
  type AuthorizedFileMetadata,
} from "./authorized-file.js";
import type { ServingGrant } from "./grant.js";
import { maximumInstrumentedEntryBytes } from "./instrumented-entry.js";

export type ReviewEntryObservation =
  | {
      readonly availability: "available";
      readonly revision: `sha256:${string}`;
    }
  | { readonly availability: "unavailable" }
  | {
      readonly availability: "unsupported";
      readonly limitation: "entry_too_large";
    };

interface AvailableSample {
  readonly outcome: "available";
  readonly metadata: AuthorizedFileMetadata;
  readonly revision: `sha256:${string}`;
}

interface UnchangedSample {
  readonly outcome: "unchanged";
  readonly metadata: AuthorizedFileMetadata;
}

interface UnavailableSample {
  readonly outcome: "unavailable";
}

interface UnsupportedSample {
  readonly outcome: "unsupported";
  readonly metadata: AuthorizedFileMetadata;
  readonly limitation: "entry_too_large";
}

type EntrySample =
  AvailableSample | UnchangedSample | UnavailableSample | UnsupportedSample;

export interface ReviewEntryObserverOptions {
  readonly quietMilliseconds?: number;
  readonly pollMilliseconds?: number;
  readonly forcedPollInterval?: number;
}

const defaultQuietMilliseconds = 100;
const defaultPollMilliseconds = 1_000;
const defaultForcedPollInterval = 30;

function sameMetadata(
  left: AuthorizedFileMetadata | undefined,
  right: AuthorizedFileMetadata,
): boolean {
  return (
    left !== undefined &&
    left.size === right.size &&
    left.modifiedNanoseconds === right.modifiedNanoseconds &&
    left.inode === right.inode
  );
}

function sameObservation(
  left: ReviewEntryObservation | undefined,
  right: ReviewEntryObservation,
): boolean {
  if (left?.availability !== right.availability) return false;
  if (left.availability === "available" && right.availability === "available")
    return left.revision === right.revision;
  if (
    left.availability === "unsupported" &&
    right.availability === "unsupported"
  )
    return left.limitation === right.limitation;
  return true;
}

function publicObservation(
  sample: EntrySample,
): ReviewEntryObservation | undefined {
  switch (sample.outcome) {
    case "available":
      return { availability: "available", revision: sample.revision };
    case "unavailable":
      return { availability: "unavailable" };
    case "unsupported":
      return {
        availability: "unsupported",
        limitation: sample.limitation,
      };
    case "unchanged":
      return undefined;
  }
}

function readStreamRevision(
  stream: NodeJS.ReadableStream,
): Effect.Effect<`sha256:${string}` | undefined> {
  return Effect.tryPromise({
    try: async () => {
      const hash = createHash("sha256");
      for await (const chunk of stream)
        hash.update(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      return `sha256:${hash.digest("hex")}` as const;
    },
    catch: () => undefined,
  }).pipe(Effect.catch(() => Effect.sync((): undefined => undefined)));
}

function inspectReviewEntry(
  grant: ServingGrant,
  knownMetadata: AuthorizedFileMetadata | undefined,
  forceRead: boolean,
): Effect.Effect<EntrySample, never, Scope.Scope> {
  return Effect.gen(function* () {
    const opened = yield* openAuthorizedFile(grant.root, grant.routeEntry);
    if (opened.outcome !== "file") return { outcome: "unavailable" };
    if (opened.metadata.size > BigInt(maximumInstrumentedEntryBytes))
      return {
        outcome: "unsupported",
        metadata: opened.metadata,
        limitation: "entry_too_large",
      };
    if (!forceRead && sameMetadata(knownMetadata, opened.metadata))
      return { outcome: "unchanged", metadata: opened.metadata };
    const stream = yield* opened.openReadStream;
    const revision = yield* readStreamRevision(stream);
    return revision === undefined
      ? { outcome: "unavailable" }
      : { outcome: "available", metadata: opened.metadata, revision };
  });
}

class ReviewEntryObserver {
  readonly #entryName: string;
  readonly #grant: ServingGrant;
  readonly #publish: (observation: ReviewEntryObservation) => void;
  readonly #run: (effect: Effect.Effect<void>) => void;
  readonly #quietMilliseconds: number;
  readonly #pollMilliseconds: number;
  readonly #forcedPollInterval: number;
  #watcher: FSWatcher | undefined;
  #quietTimer: NodeJS.Timeout | undefined;
  #pollTimer: NodeJS.Timeout | undefined;
  #closed = false;
  #inFlight = false;
  #pending = false;
  #forcePending = false;
  #pollCount = 0;
  #knownMetadata: AuthorizedFileMetadata | undefined;
  #published: ReviewEntryObservation;
  #candidate: ReviewEntryObservation | undefined;

  constructor(
    grant: ServingGrant,
    initial: EntrySample,
    publish: (observation: ReviewEntryObservation) => void,
    run: (effect: Effect.Effect<void>) => void,
    options: ReviewEntryObserverOptions,
  ) {
    this.#entryName = path.basename(grant.routeEntry);
    this.#grant = grant;
    this.#publish = publish;
    this.#run = run;
    this.#quietMilliseconds =
      options.quietMilliseconds ?? defaultQuietMilliseconds;
    this.#pollMilliseconds =
      options.pollMilliseconds ?? defaultPollMilliseconds;
    this.#forcedPollInterval =
      options.forcedPollInterval ?? defaultForcedPollInterval;
    this.#knownMetadata =
      initial.outcome === "available" ||
      initial.outcome === "unsupported" ||
      initial.outcome === "unchanged"
        ? initial.metadata
        : undefined;
    this.#published = publicObservation(initial) ?? {
      availability: "unavailable",
    };
  }

  start(): void {
    try {
      this.#watcher = watch(
        path.dirname(this.#grant.routeEntry),
        { persistent: false },
        (_event, filename) => {
          if (filename === null || filename.toString() === this.#entryName)
            this.#scheduleQuietInspection();
        },
      );
      this.#watcher.on("error", () => {
        this.#watcher?.close();
        this.#watcher = undefined;
      });
    } catch {
      this.#watcher = undefined;
    }
    this.#schedulePoll();
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#watcher?.close();
    this.#watcher = undefined;
    if (this.#quietTimer !== undefined) clearTimeout(this.#quietTimer);
    if (this.#pollTimer !== undefined) clearTimeout(this.#pollTimer);
    this.#quietTimer = undefined;
    this.#pollTimer = undefined;
  }

  #scheduleQuietInspection(): void {
    if (this.#closed) return;
    if (this.#quietTimer !== undefined) clearTimeout(this.#quietTimer);
    this.#quietTimer = setTimeout(() => {
      this.#quietTimer = undefined;
      this.#requestInspection(this.#candidate !== undefined);
    }, this.#quietMilliseconds);
    this.#quietTimer.unref();
  }

  #scheduleConfirmation(): void {
    if (this.#closed) return;
    if (this.#quietTimer !== undefined) clearTimeout(this.#quietTimer);
    this.#quietTimer = setTimeout(() => {
      this.#quietTimer = undefined;
      this.#requestInspection(true);
    }, this.#quietMilliseconds);
    this.#quietTimer.unref();
  }

  #schedulePoll(): void {
    if (this.#closed) return;
    this.#pollTimer = setTimeout(() => {
      this.#pollTimer = undefined;
      this.#pollCount += 1;
      const forceRead = this.#pollCount >= this.#forcedPollInterval;
      if (forceRead) this.#pollCount = 0;
      this.#requestInspection(forceRead);
      this.#schedulePoll();
    }, this.#pollMilliseconds);
    this.#pollTimer.unref();
  }

  #requestInspection(forceRead: boolean): void {
    if (this.#closed) return;
    if (this.#inFlight) {
      this.#pending = true;
      this.#forcePending ||= forceRead;
      return;
    }
    this.#inFlight = true;
    const knownMetadata = this.#knownMetadata;
    this.#run(
      Effect.scoped(
        inspectReviewEntry(this.#grant, knownMetadata, forceRead),
      ).pipe(
        Effect.flatMap((sample) =>
          Effect.sync(() => {
            if (!this.#closed) this.#consume(sample);
          }),
        ),
        Effect.ensuring(
          Effect.sync(() => {
            this.#inFlight = false;
            if (this.#closed || !this.#pending) return;
            const pendingForce = this.#forcePending;
            this.#pending = false;
            this.#forcePending = false;
            this.#requestInspection(pendingForce);
          }),
        ),
      ),
    );
  }

  #consume(sample: EntrySample): void {
    if (
      sample.outcome === "available" ||
      sample.outcome === "unsupported" ||
      sample.outcome === "unchanged"
    )
      this.#knownMetadata = sample.metadata;
    else this.#knownMetadata = undefined;

    const observation = publicObservation(sample);
    if (observation === undefined) return;
    if (sameObservation(this.#published, observation)) {
      this.#candidate = undefined;
      return;
    }
    if (!sameObservation(this.#candidate, observation)) {
      this.#candidate = observation;
      this.#scheduleConfirmation();
      return;
    }
    this.#candidate = undefined;
    this.#published = observation;
    this.#publish(observation);
  }
}

export function startReviewEntryObserver(
  grant: ServingGrant,
  publish: (observation: ReviewEntryObservation) => void,
  options: ReviewEntryObserverOptions = {},
): Effect.Effect<void, never, Scope.Scope> {
  return Effect.gen(function* () {
    const initial = yield* Effect.scoped(
      inspectReviewEntry(grant, undefined, true),
    );
    const initialObservation = publicObservation(initial) ?? {
      availability: "unavailable" as const,
    };
    publish(initialObservation);
    const run = yield* FiberSet.makeRuntime<never, void, never>();
    yield* Effect.acquireRelease(
      Effect.sync(() => {
        const observer = new ReviewEntryObserver(
          grant,
          initial,
          publish,
          (effect) => {
            run(effect);
          },
          options,
        );
        observer.start();
        return observer;
      }),
      (observer) => Effect.sync(() => observer.close()),
    );
  });
}
