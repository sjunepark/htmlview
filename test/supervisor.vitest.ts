import { mkdtemp, rm, stat } from "node:fs/promises";
import { request } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it } from "@effect/vitest";
import { Effect, Exit, Fiber, FiberSet, Scope } from "effect";
import { TestClock } from "effect/testing";
import {
  generateReviewId,
  generateSessionId,
  runSupervisor,
  startSupervisor,
} from "../src/supervisor/server.js";
import { controlHost } from "../src/supervisor/protocol.js";
import {
  acquireSupervisorLock,
  ensurePrivateStateDirectory,
  statePaths,
} from "../src/supervisor/state.js";

function exists(pathname: string): Effect.Effect<boolean> {
  return Effect.promise(() =>
    stat(pathname)
      .then(() => true)
      .catch(() => false),
  );
}

function removeTemporaryDirectory(directory: string): Effect.Effect<void> {
  return Effect.promise(() =>
    rm(directory, {
      recursive: true,
      force: true,
      maxRetries: 3,
      retryDelay: 10,
    }),
  );
}

function waitUntilMissing(pathname: string): Effect.Effect<boolean> {
  return Effect.gen(function* () {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      if (!(yield* exists(pathname))) return true;
      yield* Effect.promise(
        () => new Promise<void>((resolve) => setImmediate(resolve)),
      );
    }
    return false;
  });
}

function waitUntilPresent(pathname: string): Effect.Effect<boolean> {
  return Effect.gen(function* () {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (yield* exists(pathname)) return true;
      yield* Effect.promise(
        () => new Promise<void>((resolve) => setImmediate(resolve)),
      );
    }
    return false;
  });
}

function healthStatus(socketPath: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const operation = request(
      {
        socketPath,
        method: "GET",
        path: "/health",
        headers: { host: controlHost },
      },
      (response) => {
        response.resume();
        response.once("end", () => resolve(response.statusCode ?? 0));
      },
    );
    operation.once("error", reject);
    operation.end();
  });
}

it("never returns a session identifier that parses as a flag", () => {
  const candidates = [
    Buffer.from([0xf8, 0, 0, 0, 0, 0]),
    Buffer.from([0, 0, 0, 0, 0, 0]),
  ];
  expect(candidates[0]?.toString("base64url").startsWith("-")).toBe(true);
  const id = generateSessionId(() => candidates.shift() ?? Buffer.alloc(6));
  expect(id).toBe("AAAAAAAA");
  expect(id.startsWith("-")).toBe(false);
});

it("generates stable review locators with 128 random bits", () => {
  const ids = new Set(Array.from({ length: 1_000 }, () => generateReviewId()));
  expect(ids.size).toBe(1_000);
  for (const id of ids) expect(id).toMatch(/^rv_[A-Za-z0-9_-]{22}$/);
});

it.effect("uses the test clock for idle supervisor shutdown", () =>
  Effect.acquireUseRelease(
    Effect.promise(() => mkdtemp(path.join(tmpdir(), "htmlview-idle-clock-"))),
    (parent) =>
      Effect.gen(function* () {
        const paths = statePaths({
          HTMLVIEW_STATE_DIR: path.join(parent, "state"),
        });
        const idleRuntime = yield* FiberSet.makeRuntime<never, void, never>();
        yield* Effect.scoped(
          Effect.gen(function* () {
            const supervisor = yield* Effect.acquireRelease(
              startSupervisor({
                paths,
                idleMilliseconds: 50,
                idleRuntime,
              }),
              (running) => running.close.pipe(Effect.orDie),
            );
            yield* TestClock.adjust(49);
            expect(yield* exists(paths.controlSocket)).toBe(true);
            yield* TestClock.adjust(1);
            expect(yield* waitUntilMissing(paths.controlSocket)).toBe(true);
            yield* supervisor.closed;
          }),
        );
      }),
    removeTemporaryDirectory,
  ),
);

it.effect("closes the supervisor when its root scope is interrupted", () =>
  Effect.acquireUseRelease(
    Effect.promise(() => mkdtemp(path.join(tmpdir(), "htmlview-root-scope-"))),
    (parent) =>
      Effect.gen(function* () {
        const paths = statePaths({
          HTMLVIEW_STATE_DIR: path.join(parent, "state"),
        });
        const fiber = yield* Effect.forkChild(
          Effect.scoped(runSupervisor({ paths })),
        );
        expect(yield* waitUntilPresent(paths.controlSocket)).toBe(true);
        yield* Fiber.interrupt(fiber);
        expect(yield* exists(paths.controlSocket)).toBe(false);
        expect(yield* exists(paths.supervisorLock)).toBe(false);
      }),
    removeTemporaryDirectory,
  ),
);

it.effect(
  "finishes an interrupted acquisition without orphaning supervisor state",
  () =>
    Effect.acquireUseRelease(
      Effect.promise(() => mkdtemp(path.join(tmpdir(), "hv-acquire-int-"))),
      (parent) =>
        Effect.gen(function* () {
          const paths = statePaths({
            HTMLVIEW_STATE_DIR: path.join(parent, "state"),
          });
          yield* ensurePrivateStateDirectory(paths);
          yield* Effect.scoped(
            Effect.gen(function* () {
              const holder = yield* Effect.acquireRelease(
                Scope.make(),
                (scope) => Scope.close(scope, Exit.void),
              );
              yield* Scope.provide(holder)(acquireSupervisorLock(paths));
              const supervisor = yield* Effect.acquireRelease(
                Effect.forkChild(Effect.scoped(runSupervisor({ paths }))),
                (fiber) => Fiber.interrupt(fiber),
              );
              yield* Effect.promise(
                () => new Promise<void>((resolve) => setImmediate(resolve)),
              );
              const interruption = yield* Effect.forkChild(
                Fiber.interrupt(supervisor),
              );
              yield* Scope.close(holder, Exit.void);
              yield* Fiber.join(interruption);
              expect(yield* exists(paths.controlSocket)).toBe(false);
              expect(yield* exists(paths.supervisorLock)).toBe(false);
            }),
          );
        }),
      removeTemporaryDirectory,
    ),
);

it.effect(
  "keeps the supervisor alive when activity wins the idle-close race",
  () =>
    Effect.acquireUseRelease(
      Effect.promise(() => mkdtemp(path.join(tmpdir(), "htmlview-idle-race-"))),
      (parent) =>
        Effect.gen(function* () {
          const paths = statePaths({
            HTMLVIEW_STATE_DIR: path.join(parent, "state"),
          });
          const idleRuntime = yield* FiberSet.makeRuntime<never, void, never>();
          let markHealthStarted = (): void => undefined;
          const healthStarted = new Promise<void>((resolve) => {
            markHealthStarted = resolve;
          });
          let releaseHealth = (): void => undefined;
          const healthReleased = new Promise<void>((resolve) => {
            releaseHealth = resolve;
          });
          let idleClose: (() => void) | undefined;
          yield* Effect.scoped(
            Effect.gen(function* () {
              yield* Effect.acquireRelease(
                startSupervisor({
                  paths,
                  idleMilliseconds: 50,
                  idleRuntime,
                  deferIdleClose: (close) => {
                    idleClose = close;
                  },
                  beforeHealth: async () => {
                    markHealthStarted();
                    await healthReleased;
                  },
                }),
                (supervisor) => supervisor.close.pipe(Effect.orDie),
              );
              yield* TestClock.adjust(49);
              yield* TestClock.adjust(1);

              const health = yield* Effect.forkChild(
                Effect.promise(() => healthStatus(paths.controlSocket)),
              );
              yield* Effect.promise(() => healthStarted);
              expect(idleClose).toBeDefined();
              idleClose?.();
              releaseHealth();
              expect(yield* Fiber.join(health)).toBe(200);
              expect(yield* exists(paths.controlSocket)).toBe(true);
            }),
          );
        }),
      removeTemporaryDirectory,
    ),
);
