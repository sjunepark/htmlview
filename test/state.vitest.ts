import { mkdir, mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it } from "@effect/vitest";
import { Effect, Exit, Fiber, Scope } from "effect";
import { TestClock } from "effect/testing";
import {
  acquireSupervisorLock,
  ensurePrivateStateDirectory,
  statePaths,
  transferSupervisorLock,
  writePrivateJson,
} from "../src/supervisor/state.js";

function withTemporaryState<A, E>(
  use: (
    paths: ReturnType<typeof statePaths>,
  ) => Effect.Effect<A, E, Scope.Scope>,
): Effect.Effect<A, E, Scope.Scope> {
  return Effect.acquireUseRelease(
    Effect.promise(() =>
      mkdtemp(path.join(tmpdir(), "htmlview-effect-state-")),
    ),
    (parent) =>
      use(statePaths({ HTMLVIEW_STATE_DIR: path.join(parent, "state") })),
    (parent) =>
      Effect.promise(() => rm(parent, { recursive: true, force: true })),
  );
}

function exists(pathname: string): Effect.Effect<boolean> {
  return Effect.promise(() =>
    stat(pathname)
      .then(() => true)
      .catch(() => false),
  );
}

function waitUntilExists(pathname: string): Effect.Effect<boolean> {
  return Effect.gen(function* () {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      if (yield* exists(pathname)) return true;
      yield* Effect.promise(
        () => new Promise<void>((resolve) => setImmediate(resolve)),
      );
    }
    return false;
  });
}

it.effect("uses the test clock for ownership timeout policy", () =>
  withTemporaryState((paths) =>
    Effect.gen(function* () {
      yield* TestClock.setTime(Date.now());
      yield* ensurePrivateStateDirectory(paths);
      yield* Effect.promise(() => mkdir(paths.supervisorLock, { mode: 0o700 }));
      yield* writePrivateJson(path.join(paths.supervisorLock, "owner.json"), {
        pid: process.pid,
        nonce: "a".repeat(32),
      });

      const waiter = yield* Effect.scoped(
        acquireSupervisorLock(paths, 80),
      ).pipe(Effect.flip, Effect.forkChild);
      yield* TestClock.adjust(79);
      expect(waiter.pollUnsafe()).toBeUndefined();
      yield* TestClock.adjust(1);
      const failure = yield* Fiber.join(waiter);
      expect(failure.reason).toBe("ownership_timeout");
    }),
  ),
);

it.effect("protects a fresh malformed owner for ten seconds", () =>
  withTemporaryState((paths) =>
    Effect.gen(function* () {
      yield* ensurePrivateStateDirectory(paths);
      yield* Effect.promise(() => mkdir(paths.supervisorLock, { mode: 0o700 }));
      const created = yield* Effect.promise(() => stat(paths.supervisorLock));
      yield* TestClock.setTime(created.mtimeMs + 9_999);

      const protectedWaiter = yield* Effect.scoped(
        acquireSupervisorLock(paths, 1),
      ).pipe(Effect.flip, Effect.forkChild);
      yield* TestClock.adjust(1);
      expect((yield* Fiber.join(protectedWaiter)).reason).toBe(
        "ownership_timeout",
      );

      yield* TestClock.setTime(created.mtimeMs + 10_001);
      yield* Effect.scoped(acquireSupervisorLock(paths, 1_000));
      expect(yield* exists(paths.supervisorLock)).toBe(false);
    }),
  ),
);

it.effect("releases scoped ownership exactly at scope close", () =>
  withTemporaryState((paths) =>
    Effect.gen(function* () {
      yield* ensurePrivateStateDirectory(paths);
      yield* Effect.scoped(
        Effect.gen(function* () {
          yield* acquireSupervisorLock(paths);
          const lockMetadata = yield* Effect.promise(() =>
            stat(paths.supervisorLock),
          );
          const ownerMetadata = yield* Effect.promise(() =>
            stat(path.join(paths.supervisorLock, "owner.json")),
          );
          expect(lockMetadata.mode & 0o777).toBe(0o700);
          expect(ownerMetadata.mode & 0o777).toBe(0o600);
        }),
      );
      expect(yield* exists(paths.supervisorLock)).toBe(false);
    }),
  ),
);

it.effect("releases ownership on failure and interruption", () =>
  withTemporaryState((paths) =>
    Effect.gen(function* () {
      yield* ensurePrivateStateDirectory(paths);
      yield* Effect.flip(
        Effect.scoped(
          Effect.gen(function* () {
            yield* acquireSupervisorLock(paths);
            return yield* Effect.fail("test failure");
          }),
        ),
      );
      expect(yield* exists(paths.supervisorLock)).toBe(false);

      const holder = yield* Effect.scoped(
        Effect.gen(function* () {
          yield* acquireSupervisorLock(paths);
          return yield* Effect.never;
        }),
      ).pipe(Effect.forkChild);
      expect(yield* waitUntilExists(paths.supervisorLock)).toBe(true);
      yield* Fiber.interrupt(holder);
      expect(yield* exists(paths.supervisorLock)).toBe(false);
      expect(yield* Effect.promise(() => readdir(paths.directory))).toEqual([]);
    }),
  ),
);

it.effect(
  "transfers ownership before the bootstrap finalizer can release it",
  () =>
    withTemporaryState((paths) =>
      Effect.gen(function* () {
        yield* ensurePrivateStateDirectory(paths);
        const bootstrapScope = yield* Scope.make();
        const bootstrap = yield* Scope.provide(bootstrapScope)(
          acquireSupervisorLock(paths),
        );
        const ownershipScope = yield* Scope.make();
        const instanceId = "b".repeat(32);
        yield* Scope.provide(ownershipScope)(
          transferSupervisorLock(paths, bootstrap.nonce, {
            pid: process.pid,
            instanceId,
          }),
        );

        yield* Scope.close(bootstrapScope, Exit.void);
        expect(yield* exists(paths.supervisorLock)).toBe(true);
        const owner = JSON.parse(
          yield* Effect.promise(() =>
            readFile(path.join(paths.supervisorLock, "owner.json"), "utf8"),
          ),
        ) as { readonly nonce: string };
        expect(owner.nonce).toBe(instanceId);

        yield* Scope.close(ownershipScope, Exit.void);
        expect(yield* exists(paths.supervisorLock)).toBe(false);
      }),
    ),
);
