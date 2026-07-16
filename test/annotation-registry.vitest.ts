import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it } from "@effect/vitest";
import { Effect, Scope } from "effect";
import { AnnotationRegistry } from "../src/annotation/registry.js";
import { emptyAnnotationState } from "../src/annotation/model.js";
import { loadAnnotationState } from "../src/annotation/store.js";
import { RuntimeStateError } from "../src/errors.js";
import {
  ensurePrivateStateDirectory,
  statePaths,
  type StatePaths,
} from "../src/supervisor/state.js";

const firstId = `rv_${"a".repeat(22)}`;
const secondId = `rv_${"b".repeat(22)}`;

function withTemporaryState<A, E>(
  use: (paths: StatePaths) => Effect.Effect<A, E, Scope.Scope>,
): Effect.Effect<A, E | RuntimeStateError, Scope.Scope> {
  return Effect.acquireUseRelease(
    Effect.promise(() => mkdtemp(path.join(tmpdir(), "htmlview-registry-"))),
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

it.effect(
  "commits create, stop, and stable resume before publishing state",
  () =>
    withTemporaryState((paths) =>
      Effect.gen(function* () {
        const registry = new AnnotationRegistry(paths, emptyAnnotationState());
        yield* registry.createReady({
          id: firstId,
          identity: { root: "/workspace", entry: "/report.html" },
          session: "session1",
        });
        expect(registry.summaries()).toEqual([
          {
            id: firstId,
            status: "ready",
            session: "session1",
            drafts: 0,
            unacknowledged: 0,
          },
        ]);

        yield* registry.stopReady([firstId]);
        yield* registry.resumeReady(firstId, "session2");
        expect(
          registry.openReview({
            root: "/workspace",
            entry: "/report.html",
          })?.session,
        ).toBe("session2");
        expect((yield* loadAnnotationState(paths)).reviews[0]?.status).toBe(
          "stopped",
        );
      }),
    ),
);

it.effect("keeps memory unchanged when a durable replacement fails", () =>
  withTemporaryState((paths) =>
    Effect.gen(function* () {
      let fail = true;
      const registry = new AnnotationRegistry(
        paths,
        emptyAnnotationState(),
        1,
        () =>
          fail
            ? Effect.fail(
                new RuntimeStateError({
                  code: "state.unavailable",
                  message: "test persistence failure",
                }),
              )
            : Effect.void,
      );
      expect(
        (yield* registry
          .createReady({
            id: firstId,
            identity: { root: "/workspace", entry: "/report.html" },
            session: "session1",
          })
          .pipe(Effect.flip)).code,
      ).toBe("state.unavailable");
      expect(registry.summaries()).toEqual([]);

      fail = false;
      yield* registry.createReady({
        id: firstId,
        identity: { root: "/workspace", entry: "/report.html" },
        session: "session1",
      });
      expect(
        (yield* registry
          .createReady({
            id: secondId,
            identity: { root: "/other", entry: "/other.html" },
            session: "session2",
          })
          .pipe(Effect.flip)).code,
      ).toBe("review.limit");
      expect(registry.summaries()).toHaveLength(1);
    }),
  ),
);
