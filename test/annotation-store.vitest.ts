import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  truncate,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it } from "@effect/vitest";
import { Effect, Scope } from "effect";
import {
  loadAnnotationState,
  maximumAnnotationStoreBytes,
  saveAnnotationState,
} from "../src/annotation/store.js";
import type { AnnotationState } from "../src/annotation/model.js";
import type { RuntimeStateError } from "../src/errors.js";
import {
  ensurePrivateStateDirectory,
  statePaths,
  type StatePaths,
} from "../src/supervisor/state.js";

const reviewId = `rv_${"r".repeat(22)}`;
const sessionId = "session1";

function state(
  status: "ready" | "stopped" | "ended" = "stopped",
): AnnotationState {
  return {
    version: 1,
    reviews: [
      {
        id: reviewId,
        identity: { root: "/workspace", entry: "/report.html" },
        status,
        session: sessionId,
        drafts: [],
        events: [],
        nextCursor: 1,
        acknowledgedCursor: 0,
        highestDeliveredCursor: 0,
      },
    ],
    tombstones: [],
  };
}

function withTemporaryState<A, E>(
  use: (paths: StatePaths) => Effect.Effect<A, E, Scope.Scope>,
): Effect.Effect<A, E | RuntimeStateError, Scope.Scope> {
  return Effect.acquireUseRelease(
    Effect.promise(() => mkdtemp(path.join(tmpdir(), "htmlview-annotations-"))),
    (parent) => {
      const paths = statePaths({
        HTMLVIEW_STATE_DIR: path.join(parent, "state"),
      });
      return ensurePrivateStateDirectory(paths).pipe(
        Effect.andThen(use(paths)),
      );
    },
    (parent) =>
      Effect.promise(() => rm(parent, { recursive: true, force: true })),
  );
}

it.effect("loads an absent store as empty without inventing a state file", () =>
  withTemporaryState((paths) =>
    Effect.gen(function* () {
      expect(yield* loadAnnotationState(paths)).toEqual({
        version: 1,
        reviews: [],
        tombstones: [],
      });
      const directory = yield* Effect.promise(() =>
        stat(paths.annotationDirectory),
      );
      expect(directory.mode & 0o777).toBe(0o700);
      expect(
        yield* Effect.promise(() =>
          stat(paths.annotationFile)
            .then(() => true)
            .catch(() => false),
        ),
      ).toBe(false);

      const stale = path.join(
        paths.annotationDirectory,
        "state.json.123.0123456789abcdef.tmp",
      );
      const unrelated = path.join(paths.annotationDirectory, "keep.txt");
      yield* Effect.promise(() =>
        Promise.all([writeFile(stale, "stale"), writeFile(unrelated, "keep")]),
      );
      yield* loadAnnotationState(paths);
      expect(
        yield* Effect.promise(() => readdir(paths.annotationDirectory)),
      ).toEqual(["keep.txt"]);
    }),
  ),
);

it.effect("round-trips a private, bounded, versioned snapshot", () =>
  withTemporaryState((paths) =>
    Effect.gen(function* () {
      const expected = state();
      yield* saveAnnotationState(paths, expected);
      expect(yield* loadAnnotationState(paths)).toEqual(expected);
      const metadata = yield* Effect.promise(() => stat(paths.annotationFile));
      expect(metadata.mode & 0o777).toBe(0o600);
      expect(
        JSON.parse(
          yield* Effect.promise(() => readFile(paths.annotationFile, "utf8")),
        ),
      ).toEqual(expected);
    }),
  ),
);

it.effect("durably recovers ready reviews and expires old tombstones", () =>
  withTemporaryState((paths) =>
    Effect.gen(function* () {
      const persisted: AnnotationState = {
        ...state("ready"),
        tombstones: [
          {
            id: `rv_${"t".repeat(22)}`,
            kind: "deleted",
            expiresAt: "2026-07-17T00:00:00.000Z",
            discardedDrafts: 1,
            discardedFeedback: 2,
          },
        ],
      };
      yield* saveAnnotationState(paths, persisted);
      const recovered = yield* loadAnnotationState(
        paths,
        new Date("2026-07-17T00:00:00.000Z"),
      );
      expect(recovered.reviews[0]?.status).toBe("stopped");
      expect(recovered.tombstones).toEqual([]);
      expect(
        JSON.parse(
          yield* Effect.promise(() => readFile(paths.annotationFile, "utf8")),
        ),
      ).toEqual(recovered);
    }),
  ),
);

it.effect("fails closed on corrupt, excess, and inconsistent state", () =>
  withTemporaryState((paths) =>
    Effect.gen(function* () {
      yield* loadAnnotationState(paths);
      for (const value of [
        "{",
        Buffer.from([0xff]),
        JSON.stringify({ ...state(), version: 2 }),
        JSON.stringify({ ...state(), excess: true }),
        JSON.stringify({
          ...state(),
          reviews: [
            {
              ...state().reviews[0],
              acknowledgedCursor: 1,
              highestDeliveredCursor: 0,
            },
          ],
        }),
      ]) {
        yield* Effect.promise(() =>
          writeFile(paths.annotationFile, value, { mode: 0o600 }),
        );
        const failure = yield* loadAnnotationState(paths).pipe(Effect.flip);
        expect(failure.code).toBe("state.unavailable");
        expect(failure.message).toBe(
          "The private htmlview annotation state is unavailable",
        );
      }
    }),
  ),
);

it.effect("rejects unsafe directory and file metadata", () =>
  withTemporaryState((paths) =>
    Effect.gen(function* () {
      yield* Effect.promise(() =>
        mkdir(paths.annotationDirectory, { mode: 0o755 }),
      );
      expect((yield* loadAnnotationState(paths).pipe(Effect.flip)).code).toBe(
        "state.unavailable",
      );

      yield* Effect.promise(() => chmod(paths.annotationDirectory, 0o700));
      yield* Effect.promise(() =>
        writeFile(paths.annotationFile, JSON.stringify(state()), {
          mode: 0o644,
        }),
      );
      expect((yield* loadAnnotationState(paths).pipe(Effect.flip)).code).toBe(
        "state.unavailable",
      );

      yield* Effect.promise(() => rm(paths.annotationFile));
      const target = path.join(paths.directory, "target.json");
      yield* Effect.promise(() => writeFile(target, JSON.stringify(state())));
      yield* Effect.promise(() => symlink(target, paths.annotationFile));
      expect((yield* loadAnnotationState(paths).pipe(Effect.flip)).code).toBe(
        "state.unavailable",
      );

      yield* Effect.promise(() => rm(paths.annotationFile));
      yield* Effect.promise(() =>
        writeFile(paths.annotationFile, "", { mode: 0o600 }),
      );
      yield* Effect.promise(() =>
        truncate(paths.annotationFile, maximumAnnotationStoreBytes + 1),
      );
      expect((yield* loadAnnotationState(paths).pipe(Effect.flip)).code).toBe(
        "state.unavailable",
      );
    }),
  ),
);
