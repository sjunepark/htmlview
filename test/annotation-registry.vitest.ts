import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it } from "@effect/vitest";
import { Effect, Fiber, Scope } from "effect";
import { TestClock } from "effect/testing";
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
const revision = `sha256:${"0".repeat(64)}`;

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

        yield* registry.stopReadyForSessions(["session1"]);
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

it.effect(
  "keeps deletion retryable across both durable transition failures",
  () =>
    withTemporaryState((paths) =>
      Effect.gen(function* () {
        let attempt = 0;
        let failAt = 1;
        const registry = new AnnotationRegistry(
          paths,
          {
            ...emptyAnnotationState(),
            reviews: [
              {
                id: firstId,
                identity: { root: "/workspace", entry: "/report.html" },
                status: "ready",
                session: "session1",
                drafts: [],
                events: [],
                nextCursor: 1,
                acknowledgedCursor: 0,
                highestDeliveredCursor: 0,
              },
            ],
          },
          1,
          () => {
            attempt += 1;
            return attempt === failAt
              ? Effect.fail(
                  new RuntimeStateError({
                    code: "state.unavailable",
                    message: "test persistence failure",
                  }),
                )
              : Effect.void;
          },
        );
        let closes = 0;
        const close = Effect.sync(() => {
          closes += 1;
        });

        expect(
          (yield* registry
            .deleteReview(firstId, false, close)
            .pipe(Effect.flip)).code,
        ).toBe("state.unavailable");
        expect(registry.summaries()[0]?.status).toBe("ready");
        expect(closes).toBe(0);

        attempt = 0;
        failAt = 2;
        expect(
          (yield* registry
            .deleteReview(firstId, false, close)
            .pipe(Effect.flip)).code,
        ).toBe("state.unavailable");
        expect(registry.summaries()[0]?.status).toBe("stopped");
        expect(closes).toBe(1);

        attempt = 0;
        failAt = Number.POSITIVE_INFINITY;
        expect(yield* registry.deleteReview(firstId, false)).toMatchObject({
          review: firstId,
          deleted: 1,
        });
        expect(registry.summaries()).toEqual([]);
      }),
    ),
);

it.effect("reserves lifecycle headroom at the durable annotation limit", () =>
  withTemporaryState((paths) =>
    Effect.gen(function* () {
      const entry = `/${"\n".repeat(8 * 1024 - 1)}`;
      const registry = new AnnotationRegistry(paths, emptyAnnotationState());
      yield* registry.createReady({
        id: firstId,
        identity: { root: "/workspace", entry },
        session: "session1",
      });

      let limit: RuntimeStateError | { readonly code: string } | undefined;
      let sent = 0;
      for (let index = 0; index < 32; index += 1) {
        const queued = yield* Effect.result(
          registry.queueDraft(firstId, {
            kind: "element",
            comment: "\n".repeat(4 * 1024),
            entry,
            revision,
            anchor: {
              selector: "\n".repeat(2 * 1024),
              domPath: "\n".repeat(4 * 1024),
              tag: "\n".repeat(128),
              text: "\n".repeat(512),
            },
          }),
        );
        if (queued._tag === "Failure") {
          limit = queued.failure;
          break;
        }
        const delivered = yield* Effect.result(
          registry.sendDrafts(firstId, [queued.success.id]),
        );
        if (delivered._tag === "Failure") {
          limit = delivered.failure;
          break;
        }
        sent += 1;
      }

      expect(limit?.code).toBe("review.annotation_limit");
      expect(sent).toBeGreaterThan(0);
      expect((yield* registry.feedback(firstId)).count).toBe(sent);
      yield* registry.stopReadyForSessions(["session1"]);
      const persisted = (yield* loadAnnotationState(paths)).reviews[0];
      expect(persisted?.status).toBe("stopped");
      expect(persisted?.highestDeliveredCursor).toBe(sent);
      expect(persisted?.events).toHaveLength(sent);
    }),
  ),
);

it.effect(
  "delivers ordered feedback with durable duplicate-before-ack semantics",
  () =>
    withTemporaryState((paths) =>
      Effect.gen(function* () {
        const registry = new AnnotationRegistry(paths, emptyAnnotationState());
        yield* registry.createReady({
          id: firstId,
          identity: { root: "/workspace", entry: "/report.html" },
          session: "session1",
        });
        const first = yield* registry.queueDraft(firstId, {
          kind: "element",
          comment: "first",
          entry: "/report.html",
          revision,
          anchor: {
            selector: "#first",
            domPath: "html[0]/body[0]/button[0]",
            tag: "button",
          },
        });
        const second = yield* registry.queueDraft(firstId, {
          kind: "freeform",
          comment: "second",
          entry: "/report.html",
          revision,
        });
        yield* registry.sendDrafts(firstId, [second.id, first.id]);

        const delivered = yield* registry.feedback(firstId);
        expect(delivered.cursor).toBe(2);
        expect(delivered.feedback.map((event) => event.comment)).toEqual([
          "first",
          "second",
        ]);
        const duplicate = yield* registry.feedback(firstId);
        expect(duplicate.feedback.map((event) => event.id)).toEqual(
          delivered.feedback.map((event) => event.id),
        );
        expect(
          (yield* registry.feedback(firstId, { after: 3 }).pipe(Effect.flip))
            .code,
        ).toBe("feedback.cursor_ahead");

        const acknowledged = yield* registry.feedback(firstId, { after: 2 });
        expect(acknowledged).toMatchObject({ cursor: 2, count: 0 });
        const third = yield* registry.queueDraft(firstId, {
          kind: "freeform",
          comment: "third",
          entry: "/report.html",
          revision,
        });
        yield* registry.sendDrafts(firstId, [third.id]);
        const next = yield* registry.feedback(firstId, { after: 2 });
        expect(next.cursor).toBe(3);
        expect(next.feedback.map((event) => event.comment)).toEqual(["third"]);
      }),
    ),
);

it.effect("enforces one cancellable waiter and wakes on stopped state", () =>
  withTemporaryState((paths) =>
    Effect.gen(function* () {
      const registry = new AnnotationRegistry(paths, emptyAnnotationState());
      yield* registry.createReady({
        id: firstId,
        identity: { root: "/workspace", entry: "/report.html" },
        session: "session1",
      });
      const cancelled = yield* registry
        .feedback(firstId, { wait: true })
        .pipe(Effect.forkChild);
      yield* Effect.promise(
        () => new Promise<void>((resolve) => setImmediate(resolve)),
      );
      expect(
        (yield* registry.feedback(firstId, { wait: true }).pipe(Effect.flip))
          .code,
      ).toBe("feedback.consumer_busy");
      yield* Fiber.interrupt(cancelled);

      const waiting = yield* registry
        .feedback(firstId, { wait: true })
        .pipe(Effect.forkChild);
      yield* Effect.promise(
        () => new Promise<void>((resolve) => setImmediate(resolve)),
      );
      yield* registry.stopReadyForSessions(["session1"]);
      expect(yield* Fiber.join(waiting)).toMatchObject({
        review: { id: firstId, status: "stopped" },
        cursor: 0,
        count: 0,
      });
    }),
  ),
);

it.effect(
  "requires explicit discard and replays deletion tombstones for 24 hours",
  () =>
    withTemporaryState((paths) =>
      Effect.gen(function* () {
        yield* TestClock.setTime(0);
        const registry = new AnnotationRegistry(paths, emptyAnnotationState());
        yield* registry.createReady({
          id: firstId,
          identity: { root: "/workspace", entry: "/report.html" },
          session: "session1",
        });
        const first = yield* registry.queueDraft(firstId, {
          kind: "freeform",
          comment: "send",
          entry: "/report.html",
          revision,
        });
        yield* registry.queueDraft(firstId, {
          kind: "freeform",
          comment: "draft",
          entry: "/report.html",
          revision,
        });
        yield* registry.sendDrafts(firstId, [first.id]);
        const pending = yield* registry
          .deleteReview(firstId, false)
          .pipe(Effect.flip);
        expect(pending.code).toBe("review.pending_feedback");
        if (pending._tag !== "ReviewError") throw pending;
        expect(pending.details).toEqual({ drafts: 1, unacknowledged: 1 });

        let closed = 0;
        const deleted = yield* registry.deleteReview(
          firstId,
          true,
          Effect.sync(() => {
            closed += 1;
          }),
        );
        expect(closed).toBe(1);
        expect(deleted).toMatchObject({
          discardedDrafts: 1,
          discardedFeedback: 1,
        });
        expect(yield* registry.deleteReview(firstId, false)).toEqual(deleted);
        expect(closed).toBe(1);

        yield* TestClock.adjust(24 * 60 * 60 * 1000);
        expect(
          (yield* registry.deleteReview(firstId, false).pipe(Effect.flip)).code,
        ).toBe("review.not_found");
      }),
    ),
);

it.effect(
  "ends with a final batch and compacts only after acknowledgement",
  () =>
    withTemporaryState((paths) =>
      Effect.gen(function* () {
        yield* TestClock.setTime(0);
        const registry = new AnnotationRegistry(paths, emptyAnnotationState());
        yield* registry.createReady({
          id: firstId,
          identity: { root: "/workspace", entry: "/report.html" },
          session: "session1",
        });
        const draft = yield* registry.queueDraft(firstId, {
          kind: "freeform",
          comment: "final",
          entry: "/report.html",
          revision,
        });
        yield* registry.queueDraft(firstId, {
          kind: "freeform",
          comment: "explicitly discarded",
          entry: "/report.html",
          revision,
        });
        expect(
          (yield* registry
            .sendDrafts(firstId, [draft.id], { end: true })
            .pipe(Effect.flip)).code,
        ).toBe("review.unsent_drafts");
        expect(
          yield* registry.sendDrafts(firstId, [draft.id], {
            end: true,
            discardRemaining: true,
          }),
        ).toEqual({
          sent: 1,
          discarded: 1,
          status: "ended",
        });
        const delivered = yield* registry.feedback(firstId);
        expect(delivered).toMatchObject({
          review: { status: "ended" },
          cursor: 1,
          count: 1,
        });
        const completed = yield* registry.feedback(firstId, { after: 1 });
        expect(completed).toMatchObject({
          review: { status: "ended" },
          cursor: 1,
          count: 0,
        });
        expect(registry.review(firstId)).toBeUndefined();
        expect(yield* registry.feedback(firstId, { after: 1 })).toEqual(
          completed,
        );
        expect(
          (yield* registry.feedback(firstId, { after: 2 }).pipe(Effect.flip))
            .code,
        ).toBe("feedback.cursor_ahead");
      }),
    ),
);
