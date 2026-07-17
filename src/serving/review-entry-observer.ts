import { createHash } from "node:crypto";
import {
  watch as nodeWatch,
  type FSWatcher,
  type WatchEventType,
} from "node:fs";
import path from "node:path";
import { Effect, FiberSet, type Scope } from "effect";
import {
  openAuthorizedFile,
  type AuthorizedFileMetadata,
} from "./authorized-file.js";
import { isWithinRoot, type ServingGrant } from "./grant.js";
import type {
  ServedFileDescriptor,
  ServedFileObservation,
  ServedFileSnapshot,
} from "./http.js";
import { maximumInstrumentedEntryBytes } from "./instrumented-entry.js";

export const maximumTrackedReviewAssets = 128;
export const maximumTrackedReviewAssetBytes = 8 * 1024 * 1024;
export const maximumReviewAssetWatchDirectories = 32;

export type ReviewEntryObservation =
  | {
      readonly availability: "available";
      readonly revision: `sha256:${string}`;
      readonly asset_revision?: `sha256:${string}`;
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

interface AvailableAssetState {
  readonly availability: "available";
  readonly metadata: AuthorizedFileMetadata;
  readonly revision: `sha256:${string}`;
}

interface UnavailableAssetState {
  readonly availability: "unavailable";
}

interface UnsupportedAssetState {
  readonly availability: "unsupported";
}

type AssetState =
  AvailableAssetState | UnavailableAssetState | UnsupportedAssetState;

interface TrackedAsset {
  readonly version: number;
  readonly state: AssetState;
}

interface AssetInspection {
  readonly target: string;
  readonly version: number;
  readonly state: AssetState;
}

interface ReviewWatcher {
  on(event: "error", listener: () => void): this;
  close(): void;
}

type ReviewWatchFactory = (
  target: string,
  options: { readonly persistent: false },
  listener: (event: WatchEventType, filename: string | Buffer | null) => void,
) => ReviewWatcher;

export interface ReviewEntryObserverOptions {
  readonly quietMilliseconds?: number;
  readonly pollMilliseconds?: number;
  readonly forcedPollInterval?: number;
  readonly watchFactory?: ReviewWatchFactory;
}

export interface ReviewRefreshObserver {
  beginServedFileObservation(
    file: ServedFileDescriptor,
  ): ServedFileObservation | undefined;
  recordServedFile(file: ServedFileSnapshot): void;
}

const defaultQuietMilliseconds = 100;
const defaultPollMilliseconds = 1_000;
const defaultForcedPollInterval = 30;
const assetInspectionConcurrency = 4;

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
    return (
      left.revision === right.revision &&
      left.asset_revision === right.asset_revision
    );
  if (
    left.availability === "unsupported" &&
    right.availability === "unsupported"
  )
    return left.limitation === right.limitation;
  return true;
}

function publicObservation(
  sample: EntrySample,
  assetRevision?: `sha256:${string}`,
): ReviewEntryObservation | undefined {
  switch (sample.outcome) {
    case "available":
      return {
        availability: "available",
        revision: sample.revision,
        ...(assetRevision === undefined
          ? {}
          : { asset_revision: assetRevision }),
      };
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

function inspectReviewAsset(
  grant: ServingGrant,
  target: string,
  version: number,
  known: AssetState,
  forceRead: boolean,
): Effect.Effect<AssetInspection, never, Scope.Scope> {
  return Effect.gen(function* () {
    const opened = yield* openAuthorizedFile(grant.root, target);
    if (opened.outcome !== "file")
      return { target, version, state: { availability: "unavailable" } };
    if (opened.metadata.size > BigInt(maximumTrackedReviewAssetBytes))
      return { target, version, state: { availability: "unsupported" } };
    if (
      !forceRead &&
      known.availability === "available" &&
      sameMetadata(known.metadata, opened.metadata)
    )
      return { target, version, state: known };
    const stream = yield* opened.openReadStream;
    const revision = yield* readStreamRevision(stream);
    return revision === undefined
      ? { target, version, state: { availability: "unavailable" } }
      : {
          target,
          version,
          state: {
            availability: "available",
            metadata: opened.metadata,
            revision,
          },
        };
  });
}

function aggregateAssetRevision(
  root: string,
  assets: ReadonlyMap<string, TrackedAsset>,
): `sha256:${string}` | undefined {
  if (assets.size === 0) return undefined;
  const hash = createHash("sha256");
  for (const [target, tracked] of [...assets].sort(([left], [right]) =>
    left.localeCompare(right),
  )) {
    const relative = path.relative(root, target);
    hash.update(String(Buffer.byteLength(relative)));
    hash.update(":");
    hash.update(relative);
    hash.update("\0");
    hash.update(tracked.state.availability);
    hash.update("\0");
    if (tracked.state.availability === "available")
      hash.update(tracked.state.revision);
    hash.update("\0");
  }
  return `sha256:${hash.digest("hex")}`;
}

class ReviewEntryObserver implements ReviewRefreshObserver {
  readonly #entryName: string;
  readonly #grant: ServingGrant;
  readonly #publish: (observation: ReviewEntryObservation) => void;
  readonly #run: (effect: Effect.Effect<void>) => void;
  readonly #quietMilliseconds: number;
  readonly #pollMilliseconds: number;
  readonly #forcedPollInterval: number;
  readonly #watchFactory: ReviewWatchFactory;
  #entryWatcher: ReviewWatcher | undefined;
  readonly #assetWatchers = new Map<string, ReviewWatcher>();
  #quietTimer: NodeJS.Timeout | undefined;
  #assetQuietTimer: NodeJS.Timeout | undefined;
  #pollTimer: NodeJS.Timeout | undefined;
  #closed = false;
  #inFlight = false;
  #pending = false;
  #forcePending = false;
  #assetInFlight = false;
  #assetPending = false;
  #assetForcePending = false;
  #assetForceCursor = 0;
  #pollCount = 0;
  #knownMetadata: AuthorizedFileMetadata | undefined;
  #published: ReviewEntryObservation;
  #candidate: ReviewEntryObservation | undefined;
  readonly #assets = new Map<string, TrackedAsset>();
  readonly #assetReservations = new Map<string, number>();
  #nextAssetVersion = 0;
  #assetRevision: `sha256:${string}` | undefined;
  #assetCandidate: `sha256:${string}` | undefined;

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
    this.#watchFactory =
      options.watchFactory ??
      ((target, watchOptions, listener) =>
        nodeWatch(target, watchOptions, listener) as FSWatcher);
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
      this.#entryWatcher = this.#watchFactory(
        path.dirname(this.#grant.routeEntry),
        { persistent: false },
        (_event, filename) => {
          if (filename === null || filename.toString() === this.#entryName)
            this.#scheduleQuietInspection();
        },
      );
      this.#entryWatcher.on("error", () => {
        this.#entryWatcher?.close();
        this.#entryWatcher = undefined;
      });
    } catch {
      this.#entryWatcher = undefined;
    }
    this.#schedulePoll();
  }

  recordServedFile(file: ServedFileSnapshot): void {
    if (
      !this.#canTrackServedFile(file) ||
      (!this.#assets.has(file.target) &&
        this.#assets.size >= maximumTrackedReviewAssets)
    )
      return;
    const previous = this.#assets.get(file.target);
    this.#assets.set(file.target, {
      version: ++this.#nextAssetVersion,
      state: {
        availability: "available",
        metadata: file.metadata,
        revision: file.revision,
      },
    });
    this.#ensureAssetWatcher(path.dirname(file.target));
    const revision = aggregateAssetRevision(this.#grant.root, this.#assets);
    this.#assetCandidate = undefined;
    if (previous === undefined) {
      this.#assetRevision = revision;
      if (this.#published.availability === "available")
        this.#published = {
          availability: "available",
          revision: this.#published.revision,
          ...(revision === undefined ? {} : { asset_revision: revision }),
        };
      return;
    }
    if (revision === this.#assetRevision) return;
    this.#assetRevision = revision;
    if (this.#published.availability === "available")
      this.#published = {
        availability: "available",
        revision: this.#published.revision,
        ...(revision === undefined ? {} : { asset_revision: revision }),
      };
    if (this.#published.availability === "available")
      this.#publish(this.#published);
  }

  beginServedFileObservation(
    file: ServedFileDescriptor,
  ): ServedFileObservation | undefined {
    if (!this.#canTrackServedFile(file)) return undefined;
    if (
      !this.#assets.has(file.target) &&
      !this.#assetReservations.has(file.target) &&
      this.#assets.size + this.#newAssetReservationCount() >=
        maximumTrackedReviewAssets
    )
      return undefined;
    this.#assetReservations.set(
      file.target,
      (this.#assetReservations.get(file.target) ?? 0) + 1,
    );
    let settled = false;
    const release = (): boolean => {
      if (settled) return false;
      settled = true;
      const remaining = (this.#assetReservations.get(file.target) ?? 1) - 1;
      if (remaining === 0) this.#assetReservations.delete(file.target);
      else this.#assetReservations.set(file.target, remaining);
      return true;
    };
    return {
      complete: (revision) => {
        if (!release()) return;
        this.recordServedFile({ ...file, revision });
      },
      cancel: () => {
        release();
      },
    };
  }

  #canTrackServedFile(file: ServedFileDescriptor): boolean {
    return (
      !this.#closed &&
      file.target !== this.#grant.routeEntry &&
      isWithinRoot(this.#grant.root, file.target) &&
      file.metadata.size <= BigInt(maximumTrackedReviewAssetBytes)
    );
  }

  #newAssetReservationCount(): number {
    let count = 0;
    for (const target of this.#assetReservations.keys())
      if (!this.#assets.has(target)) count += 1;
    return count;
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#entryWatcher?.close();
    this.#entryWatcher = undefined;
    for (const watcher of this.#assetWatchers.values()) watcher.close();
    this.#assetWatchers.clear();
    this.#assetReservations.clear();
    if (this.#quietTimer !== undefined) clearTimeout(this.#quietTimer);
    if (this.#assetQuietTimer !== undefined)
      clearTimeout(this.#assetQuietTimer);
    if (this.#pollTimer !== undefined) clearTimeout(this.#pollTimer);
    this.#quietTimer = undefined;
    this.#assetQuietTimer = undefined;
    this.#pollTimer = undefined;
  }

  #ensureAssetWatcher(directory: string): void {
    if (
      this.#assetWatchers.has(directory) ||
      this.#assetWatchers.size >= maximumReviewAssetWatchDirectories
    )
      return;
    try {
      const watcher = this.#watchFactory(
        directory,
        { persistent: false },
        (_event, filename) => {
          if (
            filename === null ||
            this.#assets.has(path.join(directory, filename.toString()))
          )
            this.#scheduleAssetQuietInspection();
        },
      );
      watcher.on("error", () => {
        watcher.close();
        if (this.#assetWatchers.get(directory) === watcher)
          this.#assetWatchers.delete(directory);
      });
      this.#assetWatchers.set(directory, watcher);
    } catch {
      // Polling remains authoritative when native watching is unavailable.
    }
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

  #scheduleAssetQuietInspection(): void {
    if (this.#closed) return;
    if (this.#assetQuietTimer !== undefined)
      clearTimeout(this.#assetQuietTimer);
    this.#assetQuietTimer = setTimeout(() => {
      this.#assetQuietTimer = undefined;
      this.#requestAssetInspection();
    }, this.#quietMilliseconds);
    this.#assetQuietTimer.unref();
  }

  #scheduleAssetConfirmation(): void {
    if (this.#closed) return;
    if (this.#assetQuietTimer !== undefined)
      clearTimeout(this.#assetQuietTimer);
    this.#assetQuietTimer = setTimeout(() => {
      this.#assetQuietTimer = undefined;
      this.#requestAssetInspection();
    }, this.#quietMilliseconds);
    this.#assetQuietTimer.unref();
  }

  #schedulePoll(): void {
    if (this.#closed) return;
    this.#pollTimer = setTimeout(() => {
      this.#pollTimer = undefined;
      this.#pollCount += 1;
      const forceRead = this.#pollCount >= this.#forcedPollInterval;
      if (forceRead) this.#pollCount = 0;
      this.#requestInspection(forceRead);
      this.#requestAssetInspection(true);
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

  #requestAssetInspection(forceNext = false): void {
    if (this.#closed || this.#assets.size === 0) return;
    if (this.#assetInFlight) {
      this.#assetPending = true;
      this.#assetForcePending ||= forceNext;
      return;
    }
    this.#assetInFlight = true;
    const targets = [...this.#assets.keys()];
    const forceTarget = forceNext
      ? targets[this.#assetForceCursor++ % targets.length]
      : undefined;
    const snapshot = [...this.#assets].map(([target, tracked]) => ({
      target,
      version: tracked.version,
      state: tracked.state,
    }));
    this.#run(
      Effect.forEach(
        snapshot,
        ({ target, version, state }) =>
          Effect.scoped(
            inspectReviewAsset(
              this.#grant,
              target,
              version,
              state,
              target === forceTarget,
            ),
          ),
        { concurrency: assetInspectionConcurrency },
      ).pipe(
        Effect.flatMap((inspections) =>
          Effect.sync(() => {
            if (!this.#closed) this.#consumeAssetInspections(inspections);
          }),
        ),
        Effect.ensuring(
          Effect.sync(() => {
            this.#assetInFlight = false;
            if (this.#closed || !this.#assetPending) return;
            const pendingForce = this.#assetForcePending;
            this.#assetPending = false;
            this.#assetForcePending = false;
            this.#requestAssetInspection(pendingForce);
          }),
        ),
      ),
    );
  }

  #consumeAssetInspections(inspections: readonly AssetInspection[]): void {
    for (const inspection of inspections) {
      const current = this.#assets.get(inspection.target);
      if (current?.version !== inspection.version) {
        this.#assetPending = true;
        continue;
      }
      this.#assets.set(inspection.target, {
        version: ++this.#nextAssetVersion,
        state: inspection.state,
      });
    }
    const revision = aggregateAssetRevision(this.#grant.root, this.#assets);
    if (revision === this.#assetRevision) {
      this.#assetCandidate = undefined;
      return;
    }
    if (revision !== this.#assetCandidate) {
      this.#assetCandidate = revision;
      this.#scheduleAssetConfirmation();
      return;
    }
    this.#assetCandidate = undefined;
    this.#assetRevision = revision;
    if (this.#published.availability !== "available") return;
    this.#published = {
      availability: "available",
      revision: this.#published.revision,
      ...(revision === undefined ? {} : { asset_revision: revision }),
    };
    this.#publish(this.#published);
  }

  #consume(sample: EntrySample): void {
    if (
      sample.outcome === "available" ||
      sample.outcome === "unsupported" ||
      sample.outcome === "unchanged"
    )
      this.#knownMetadata = sample.metadata;
    else this.#knownMetadata = undefined;

    const observation = publicObservation(sample, this.#assetRevision);
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
): Effect.Effect<ReviewRefreshObserver, never, Scope.Scope> {
  return Effect.gen(function* () {
    const initial = yield* Effect.scoped(
      inspectReviewEntry(grant, undefined, true),
    );
    const initialObservation = publicObservation(initial) ?? {
      availability: "unavailable" as const,
    };
    publish(initialObservation);
    const run = yield* FiberSet.makeRuntime<never, void, never>();
    return yield* Effect.acquireRelease(
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
