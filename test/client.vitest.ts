import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { createServer, type RequestListener, type Server } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it } from "@effect/vitest";
import { Effect, Fiber, Result } from "effect";
import { TestClock } from "effect/testing";
import { RuntimeStateError } from "../src/errors.js";
import {
  makeDetachedSupervisorStarter,
  SupervisorClient,
  type DetachedSupervisorChild,
} from "../src/supervisor/client.js";
import {
  ensurePrivateStateDirectory,
  statePaths,
} from "../src/supervisor/state.js";
import { supervisorProtocol } from "../src/supervisor/protocol.js";
import { htmlviewVersion } from "../src/version.js";

function listen(server: Server, socketPath: string): Effect.Effect<void> {
  return Effect.callback<void>((resume) => {
    const onError = (cause: Error): void => resume(Effect.die(cause));
    server.once("error", onError);
    server.listen(socketPath, () => {
      server.off("error", onError);
      resume(Effect.void);
    });
    return Effect.sync(() => server.off("error", onError));
  });
}

function close(server: Server): Effect.Effect<void> {
  return Effect.callback<void>((resume) => {
    server.close((error) =>
      resume(error === undefined ? Effect.void : Effect.die(error)),
    );
    server.closeAllConnections();
  });
}

function advanceClockSteps(count: number, milliseconds = 50) {
  return Effect.gen(function* () {
    for (let step = 0; step < count; step += 1) {
      yield* TestClock.adjust(milliseconds);
      yield* Effect.promise(
        () => new Promise<void>((resolve) => setImmediate(resolve)),
      );
    }
  });
}

function withControlServer(
  listener: RequestListener,
  use: (client: SupervisorClient) => Effect.Effect<void>,
) {
  return Effect.acquireUseRelease(
    Effect.promise(() => mkdtemp(path.join(tmpdir(), "htmlview-client-"))),
    (parent) =>
      Effect.gen(function* () {
        const paths = statePaths({
          HTMLVIEW_STATE_DIR: path.join(parent, "state"),
        });
        yield* ensurePrivateStateDirectory(paths);
        const server = createServer(listener);
        yield* Effect.acquireUseRelease(
          listen(server, paths.controlSocket),
          () => use(new SupervisorClient(paths)),
          () => close(server),
        );
      }),
    (parent) =>
      Effect.promise(() => rm(parent, { recursive: true, force: true })),
  );
}

class FakeDetachedChild
  extends EventEmitter
  implements DetachedSupervisorChild
{
  exitCode: number | null = null;
  kills = 0;
  unrefs = 0;

  kill(): boolean {
    this.kills += 1;
    return true;
  }

  unref(): void {
    this.unrefs += 1;
  }
}

it.effect(
  "cancels a pending Unix-socket request without late listeners",
  () => {
    let requestStarted = (): void => undefined;
    const started = new Promise<void>((resolve) => {
      requestStarted = resolve;
    });
    let requestClosed = (): void => undefined;
    const closed = new Promise<void>((resolve) => {
      requestClosed = resolve;
    });
    return withControlServer(
      (request) => {
        requestStarted();
        request.once("close", requestClosed);
      },
      (client) =>
        Effect.gen(function* () {
          const fiber = yield* Effect.forkChild(client.list());
          yield* Effect.promise(() => started);
          yield* Fiber.interrupt(fiber);
          expect(
            yield* Effect.promise(() =>
              Promise.race([
                closed.then(() => true),
                new Promise<false>((resolve) =>
                  setTimeout(() => resolve(false), 1_000),
                ),
              ]),
            ),
          ).toBe(true);
        }),
    );
  },
);

it.effect(
  "retries unavailable health exactly twice at 100 millisecond spacing",
  () => {
    let count = 0;
    const observed = Array.from({ length: 3 }, () => {
      let resolve = (): void => undefined;
      const promise = new Promise<void>((resume) => {
        resolve = resume;
      });
      return { promise, resolve };
    });
    return withControlServer(
      (_, response) => {
        count += 1;
        observed[count - 1]?.resolve();
        response.writeHead(503).end("{}");
      },
      (client) =>
        Effect.gen(function* () {
          const fiber = yield* Effect.forkChild(client.list());
          yield* Effect.promise(() => observed[0]!.promise);
          yield* TestClock.adjust(99);
          yield* Effect.promise(
            () => new Promise<void>((resolve) => setImmediate(resolve)),
          );
          expect(count).toBe(1);
          yield* TestClock.adjust(1);
          yield* Effect.promise(() => observed[1]!.promise);
          expect(count).toBe(2);
          yield* TestClock.adjust(100);
          yield* Effect.promise(() => observed[2]!.promise);
          expect(count).toBe(3);
          const result = yield* Effect.result(Fiber.join(fiber));
          expect(Result.isFailure(result)).toBe(true);
        }),
    );
  },
);

it.effect("uses a soft five-second Clock deadline for startup readiness", () =>
  Effect.acquireUseRelease(
    Effect.promise(() => mkdtemp(path.join(tmpdir(), "htmlview-start-clock-"))),
    (parent) =>
      Effect.gen(function* () {
        const paths = statePaths({
          HTMLVIEW_STATE_DIR: path.join(parent, "state"),
        });
        const root = path.join(parent, "root");
        const entry = path.join(root, "report.html");
        yield* Effect.promise(() => mkdir(root));
        yield* Effect.promise(() => writeFile(entry, "<!doctype html>"));
        let markStarted = (): void => undefined;
        const started = new Promise<void>((resolve) => {
          markStarted = resolve;
        });
        const client = new SupervisorClient(paths, () =>
          Effect.sync(markStarted),
        );
        const fiber = yield* Effect.forkChild(client.serve(entry, root));
        yield* Effect.promise(() => started);
        yield* Effect.promise(
          () => new Promise<void>((resolve) => setImmediate(resolve)),
        );

        yield* TestClock.adjust(4_999);
        expect(fiber.pollUnsafe()).toBeUndefined();
        yield* TestClock.adjust(1);
        const result = yield* Effect.result(Fiber.join(fiber));
        expect(Result.isFailure(result)).toBe(true);
        if (Result.isFailure(result))
          expect(result.failure.code).toBe("supervisor.start_failed");
        expect(
          yield* Effect.promise(() =>
            stat(paths.supervisorLock)
              .then(() => true)
              .catch(() => false),
          ),
        ).toBe(false);
      }),
    (parent) =>
      Effect.promise(() => rm(parent, { recursive: true, force: true })),
  ),
);

it.effect(
  "retains detached-child terminal listeners until late handoff settles",
  () =>
    Effect.gen(function* () {
      for (const terminal of ["error", "spawn"] as const) {
        const child = new FakeDetachedChild();
        let markLaunched = (): void => undefined;
        const launched = new Promise<void>((resolve) => {
          markLaunched = resolve;
        });
        const start = makeDetachedSupervisorStarter(() => {
          markLaunched();
          return child;
        });
        const fiber = yield* Effect.forkChild(
          start(
            statePaths({ HTMLVIEW_STATE_DIR: "/tmp/htmlview-launch-test" }),
            "nonce",
          ),
        );
        yield* Effect.promise(() => launched);
        yield* Fiber.interrupt(fiber);
        expect(child.kills).toBe(1);
        expect(child.listenerCount("error")).toBe(1);

        if (terminal === "error")
          child.emit("error", new Error("late spawn failure"));
        else {
          child.emit("spawn");
          child.emit("exit");
          expect(child.kills).toBe(2);
          expect(child.unrefs).toBe(0);
        }
        expect(child.listenerCount("error")).toBe(0);
        expect(child.listenerCount("spawn")).toBe(0);
        expect(child.listenerCount("exit")).toBe(0);
      }
    }),
);

it.effect(
  "keeps the ownership deadline soft for an in-flight lock attempt",
  () =>
    Effect.acquireUseRelease(
      Effect.promise(() =>
        mkdtemp(path.join(tmpdir(), "htmlview-owner-clock-")),
      ),
      (parent) =>
        Effect.gen(function* () {
          const paths = statePaths({
            HTMLVIEW_STATE_DIR: path.join(parent, "state"),
          });
          yield* ensurePrivateStateDirectory(paths);
          let markAttempted = (): void => undefined;
          const attempted = new Promise<void>((resolve) => {
            markAttempted = resolve;
          });
          const fiber = yield* Effect.forkChild(
            new SupervisorClient(paths, undefined, (_, timeout = 100) =>
              Effect.sync(markAttempted).pipe(
                Effect.andThen(Effect.sleep(timeout)),
                Effect.andThen(
                  Effect.fail(
                    new RuntimeStateError({
                      code: "state.unavailable",
                      message: "The ownership lock is held",
                      reason: "ownership_timeout",
                    }),
                  ),
                ),
              ),
            ).list(),
          );
          yield* Effect.promise(() => attempted);

          yield* advanceClockSteps(66, 150);
          expect(fiber.pollUnsafe()).toBeUndefined();
          yield* TestClock.adjust(50);
          expect(fiber.pollUnsafe()).toBeUndefined();
          yield* TestClock.adjust(50);
          expect(fiber.pollUnsafe()).toBeUndefined();
          yield* TestClock.adjust(50);
          const result = yield* Effect.result(Fiber.join(fiber));
          expect(Result.isFailure(result)).toBe(true);
          if (Result.isFailure(result))
            expect(result.failure.code).toBe("supervisor.unavailable");
        }),
      (parent) =>
        Effect.promise(() => rm(parent, { recursive: true, force: true })),
    ),
);

it.effect("uses a five-second Clock deadline for shutdown confirmation", () => {
  const instanceId = randomUUID();
  let markShutdown = (): void => undefined;
  const shutdown = new Promise<void>((resolve) => {
    markShutdown = resolve;
  });
  return withControlServer(
    (request, response) => {
      if (request.url === "/shutdown") {
        markShutdown();
        response.end('{"stopped":0}');
        return;
      }
      response.end(
        JSON.stringify({
          protocol: supervisorProtocol,
          instanceId,
          pid: process.pid,
          version: htmlviewVersion,
        }),
      );
    },
    (client) =>
      Effect.gen(function* () {
        const fiber = yield* Effect.forkChild(client.stopAll());
        yield* Effect.promise(() => shutdown);
        yield* Effect.promise(
          () => new Promise<void>((resolve) => setImmediate(resolve)),
        );
        yield* advanceClockSteps(99);
        expect(fiber.pollUnsafe()).toBeUndefined();
        yield* advanceClockSteps(1);
        const result = yield* Effect.result(Fiber.join(fiber));
        expect(Result.isFailure(result)).toBe(true);
        if (Result.isFailure(result))
          expect(result.failure.code).toBe("supervisor.unavailable");
      }),
  );
});
