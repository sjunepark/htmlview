import { mkdtemp, rm, stat } from "node:fs/promises";
import { request } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it } from "@effect/vitest";
import { Effect, Fiber, FiberSet } from "effect";
import { TestClock } from "effect/testing";
import { startSupervisor } from "../src/supervisor/server.js";
import { controlHost } from "../src/supervisor/protocol.js";
import { statePaths } from "../src/supervisor/state.js";

function exists(pathname: string): Effect.Effect<boolean> {
  return Effect.promise(() =>
    stat(pathname)
      .then(() => true)
      .catch(() => false),
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

it.effect("uses the test clock for idle supervisor shutdown", () =>
  Effect.acquireUseRelease(
    Effect.promise(() => mkdtemp(path.join(tmpdir(), "htmlview-idle-clock-"))),
    (parent) =>
      Effect.gen(function* () {
        const paths = statePaths({
          HTMLVIEW_STATE_DIR: path.join(parent, "state"),
        });
        const idleRuntime = yield* FiberSet.makeRuntime<never, void, never>();
        const supervisor = yield* Effect.promise(() =>
          startSupervisor({
            paths,
            idleMilliseconds: 50,
            idleRuntime,
          }),
        );

        yield* TestClock.adjust(49);
        expect(yield* exists(paths.controlSocket)).toBe(true);
        yield* TestClock.adjust(1);
        expect(yield* waitUntilMissing(paths.controlSocket)).toBe(true);
        yield* Effect.promise(() => supervisor.close());
      }),
    (parent) =>
      Effect.promise(() => rm(parent, { recursive: true, force: true })),
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
          const supervisor = yield* Effect.promise(() =>
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
          yield* Effect.promise(() => supervisor.close());
        }),
      (parent) =>
        Effect.promise(() => rm(parent, { recursive: true, force: true })),
    ),
);
