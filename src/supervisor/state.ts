import { randomBytes } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  openSync,
  readSync,
  writeSync,
  type BigIntStats,
} from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  rename,
  rm,
  stat,
  unlink,
} from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { Clock, Data, Effect, Schedule, type Scope } from "effect";
import { logDiagnostic } from "../diagnostics.js";
import { RuntimeStateError } from "../errors.js";

const maximumStateFileBytes = 16 * 1024;
const maximumPortableSocketPathBytes = 100;
const malformedOwnerGraceMilliseconds = 10_000;
const lockObservationMilliseconds = 50;

export interface StatePaths {
  readonly directory: string;
  readonly annotationDirectory: string;
  readonly annotationFile: string;
  readonly controlSocket: string;
  readonly supervisorLock: string;
  readonly diagnosticLogDirectory: string;
  readonly diagnosticLogFile: string;
  readonly configurationError?: string;
}

export function statePaths(
  environment: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): StatePaths {
  let directory: string;
  let configurationError: string | undefined;
  if (
    environment.HTMLVIEW_STATE_DIR !== undefined &&
    path.isAbsolute(environment.HTMLVIEW_STATE_DIR)
  ) {
    directory = path.resolve(environment.HTMLVIEW_STATE_DIR);
  } else if (platform === "darwin") {
    if (environment.HTMLVIEW_STATE_DIR !== undefined)
      configurationError = "HTMLVIEW_STATE_DIR must be an absolute path";
    directory = path.join(
      homedir(),
      "Library",
      "Application Support",
      "htmlview",
    );
  } else {
    if (environment.HTMLVIEW_STATE_DIR !== undefined)
      configurationError = "HTMLVIEW_STATE_DIR must be an absolute path";
    const xdgStateHome = environment.XDG_STATE_HOME;
    const stateHome =
      xdgStateHome !== undefined && path.isAbsolute(xdgStateHome)
        ? xdgStateHome
        : path.join(homedir(), ".local", "state");
    directory = path.join(stateHome, "htmlview");
  }
  return {
    directory,
    annotationDirectory: path.join(directory, "annotations"),
    annotationFile: path.join(directory, "annotations", "state.json"),
    controlSocket: path.join(directory, "control.sock"),
    supervisorLock: path.join(directory, "supervisor.lock"),
    diagnosticLogDirectory: path.join(directory, "logs"),
    diagnosticLogFile: path.join(directory, "logs", "supervisor.jsonl"),
    ...(configurationError === undefined ? {} : { configurationError }),
  };
}

function stateFailure(
  cause: unknown,
  options: {
    readonly message?: string;
    readonly reason?: RuntimeStateError["reason"];
  } = {},
): RuntimeStateError {
  return new RuntimeStateError({
    code: "state.unavailable",
    message:
      options.message ??
      "The private htmlview runtime state directory is unavailable",
    reason: options.reason ?? "unavailable",
    cause,
  });
}

function tryStatePromise<A>(
  operation: () => Promise<A>,
  options?: {
    readonly message?: string;
    readonly reason?: RuntimeStateError["reason"];
  },
): Effect.Effect<A, RuntimeStateError> {
  return Effect.tryPromise({
    try: operation,
    catch: (cause) => stateFailure(cause, options),
  });
}

function reportCleanupFailure(): Effect.Effect<void> {
  return logDiagnostic("Error", {
    operation: "state.cleanup",
    code: "state.unavailable",
    failureCount: 1,
  });
}

class IgnoredStateFailure extends Data.TaggedError("IgnoredStateFailure")<{
  readonly cause: unknown;
}> {}

export function ensurePrivateStateDirectory(
  paths: StatePaths,
): Effect.Effect<void, RuntimeStateError> {
  return Effect.gen(function* () {
    if (paths.configurationError !== undefined)
      return yield* stateFailure(new Error(paths.configurationError));
    if (Buffer.byteLength(paths.controlSocket) > maximumPortableSocketPathBytes)
      return yield* stateFailure(
        new Error("The htmlview control-socket path is too long"),
      );
    yield* tryStatePromise(() =>
      mkdir(paths.directory, { recursive: true, mode: 0o700 }).then(
        () => undefined,
      ),
    );
    yield* tryStatePromise(() => chmod(paths.directory, 0o700));
    const metadata = yield* tryStatePromise(() => stat(paths.directory));
    if (!metadata.isDirectory())
      return yield* stateFailure(
        new Error(`State path is not a directory: ${paths.directory}`),
      );
    if (process.getuid !== undefined && metadata.uid !== process.getuid())
      return yield* stateFailure(
        new Error(
          `State directory is not owned by the current user: ${paths.directory}`,
        ),
      );
  });
}

function removeTemporaryFile(file: string): Effect.Effect<void> {
  return Effect.tryPromise({
    try: () => unlink(file),
    catch: (cause) => new IgnoredStateFailure({ cause }),
  }).pipe(
    Effect.catch((failure) =>
      (failure.cause as NodeJS.ErrnoException).code === "ENOENT"
        ? Effect.void
        : reportCleanupFailure(),
    ),
  );
}

export function writePrivateJson(
  file: string,
  value: unknown,
  options: {
    readonly maximumBytes?: number;
    readonly synchronizeDirectory?: boolean;
  } = {},
): Effect.Effect<void, RuntimeStateError> {
  return Effect.gen(function* () {
    const suffix = yield* Effect.try({
      try: () => randomBytes(8).toString("hex"),
      catch: (cause) => stateFailure(cause),
    });
    const temporary = `${file}.${process.pid}.${suffix}.tmp`;
    const operation = Effect.uninterruptible(
      Effect.gen(function* () {
        const body = yield* Effect.try({
          try: () => Buffer.from(JSON.stringify(value)),
          catch: (cause) => stateFailure(cause),
        });
        if (body.length > (options.maximumBytes ?? maximumStateFileBytes))
          return yield* stateFailure(
            new Error("State record exceeds size limit"),
            {
              message: "State record exceeds size limit",
            },
          );
        yield* Effect.acquireUseRelease(
          Effect.try({
            try: () => openSync(temporary, "wx", 0o600),
            catch: (cause) => stateFailure(cause),
          }),
          (descriptor) =>
            Effect.try({
              try: () => {
                let offset = 0;
                while (offset < body.length) {
                  const written = writeSync(
                    descriptor,
                    body,
                    offset,
                    body.length - offset,
                  );
                  if (written === 0)
                    throw new Error("State record write made no progress");
                  offset += written;
                }
                fsyncSync(descriptor);
              },
              catch: (cause) => stateFailure(cause),
            }),
          (descriptor) =>
            Effect.try({
              try: () => closeSync(descriptor),
              catch: (cause) => new IgnoredStateFailure({ cause }),
            }).pipe(Effect.catch(() => reportCleanupFailure())),
        );
        yield* tryStatePromise(() => rename(temporary, file));
        yield* tryStatePromise(() => chmod(file, 0o600));
        if (options.synchronizeDirectory === true)
          yield* Effect.acquireUseRelease(
            Effect.try({
              try: () => openSync(path.dirname(file), constants.O_RDONLY),
              catch: (cause) => stateFailure(cause),
            }),
            (descriptor) =>
              Effect.try({
                try: () => fsyncSync(descriptor),
                catch: (cause) => stateFailure(cause),
              }),
            closeDescriptor,
          );
      }),
    );
    return yield* operation.pipe(
      Effect.ensuring(removeTemporaryFile(temporary)),
    );
  });
}

export function removeStaleControlSocket(
  paths: StatePaths,
): Effect.Effect<void, RuntimeStateError> {
  return Effect.gen(function* () {
    const metadata = yield* Effect.tryPromise({
      try: () => lstat(paths.controlSocket),
      catch: (cause) => new IgnoredStateFailure({ cause }),
    }).pipe(
      Effect.catch((failure) =>
        (failure.cause as NodeJS.ErrnoException).code === "ENOENT"
          ? Effect.void
          : Effect.fail(stateFailure(failure.cause)),
      ),
    );
    if (metadata === undefined) return;
    if (!metadata.isSocket())
      return yield* stateFailure(
        new Error("The htmlview control-socket path is not a socket"),
      );
    yield* tryStatePromise(() => unlink(paths.controlSocket));
  });
}

export interface SupervisorLock {
  readonly nonce: string;
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EPERM") return true;
    return false;
  }
}

interface SupervisorLockOwner {
  readonly pid: number;
  readonly nonce: string;
}

function closeDescriptor(descriptor: number): Effect.Effect<void> {
  return Effect.try({
    try: () => closeSync(descriptor),
    catch: (cause) => new IgnoredStateFailure({ cause }),
  }).pipe(Effect.catch(() => reportCleanupFailure()));
}

function readBoundedRegularFile(file: string): Effect.Effect<string | void> {
  const openDescriptor = Effect.try({
    try: () =>
      openSync(
        file,
        constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW,
      ),
    catch: (cause) => new IgnoredStateFailure({ cause }),
  });
  return Effect.acquireUseRelease(
    openDescriptor,
    (descriptor) =>
      Effect.try({
        try: () => {
          const metadata = fstatSync(descriptor);
          if (!metadata.isFile() || metadata.size > maximumStateFileBytes)
            return undefined;
          const body = Buffer.alloc(metadata.size);
          let offset = 0;
          while (offset < body.length) {
            const count = readSync(
              descriptor,
              body,
              offset,
              body.length - offset,
              offset,
            );
            if (count === 0) break;
            offset += count;
          }
          return body.subarray(0, offset).toString("utf8");
        },
        catch: (cause) => new IgnoredStateFailure({ cause }),
      }).pipe(Effect.catch(() => Effect.void)),
    closeDescriptor,
  ).pipe(Effect.catch(() => Effect.void));
}

function readLockOwner(
  paths: StatePaths,
): Effect.Effect<SupervisorLockOwner | undefined> {
  return Effect.gen(function* () {
    const text = yield* readBoundedRegularFile(
      path.join(paths.supervisorLock, "owner.json"),
    );
    if (typeof text !== "string") return undefined;
    return parseLockOwner(text);
  });
}

function parseLockOwner(text: string): SupervisorLockOwner | undefined {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (typeof value !== "object" || value === null) return undefined;
  const owner = value as Record<string, unknown>;
  if (
    typeof owner.pid !== "number" ||
    !Number.isSafeInteger(owner.pid) ||
    owner.pid <= 0 ||
    typeof owner.nonce !== "string" ||
    owner.nonce.length < 16
  )
    return undefined;
  return { pid: owner.pid, nonce: owner.nonce };
}

interface StaleLockSnapshot {
  readonly device: bigint;
  readonly inode: bigint;
  readonly ownerNonce?: string;
}

function optionalLockMetadata(
  paths: StatePaths,
): Effect.Effect<BigIntStats | void> {
  return Effect.tryPromise({
    try: () => stat(paths.supervisorLock, { bigint: true }),
    catch: (cause) => new IgnoredStateFailure({ cause }),
  }).pipe(Effect.catch(() => Effect.void));
}

function staleLockSnapshot(
  paths: StatePaths,
): Effect.Effect<StaleLockSnapshot | undefined> {
  return Effect.gen(function* () {
    const metadata = yield* optionalLockMetadata(paths);
    if (metadata === undefined) return undefined;
    const owner = yield* readLockOwner(paths);
    if (owner !== undefined && processIsAlive(owner.pid)) return undefined;
    const now = yield* Clock.currentTimeMillis;
    if (
      owner === undefined &&
      now - Number(metadata.mtimeNs / 1_000_000n) <=
        malformedOwnerGraceMilliseconds
    )
      return undefined;
    return {
      device: metadata.dev,
      inode: metadata.ino,
      ...(owner === undefined ? {} : { ownerNonce: owner.nonce }),
    };
  });
}

function removeClaim(pathname: string): Effect.Effect<void> {
  return Effect.tryPromise({
    try: () => rm(pathname, { recursive: true, force: true }),
    catch: (cause) => new IgnoredStateFailure({ cause }),
  }).pipe(Effect.catch(() => reportCleanupFailure()));
}

function reclaimStaleLock(
  paths: StatePaths,
  snapshot: StaleLockSnapshot,
): Effect.Effect<boolean, RuntimeStateError> {
  return Effect.uninterruptible(
    Effect.gen(function* () {
      const claim = path.join(paths.supervisorLock, ".reclaim");
      const claimed = yield* Effect.tryPromise({
        try: () => mkdir(claim, { mode: 0o700 }).then(() => true),
        catch: (cause) => new IgnoredStateFailure({ cause }),
      }).pipe(
        Effect.catch((failure) => {
          const code = (failure.cause as NodeJS.ErrnoException).code;
          return code === "EEXIST" || code === "ENOENT"
            ? Effect.succeed(false)
            : Effect.fail(stateFailure(failure.cause));
        }),
      );
      if (!claimed) return false;

      let reclaimed = false;
      return yield* Effect.gen(function* () {
        const metadata = yield* optionalLockMetadata(paths);
        const owner = yield* readLockOwner(paths);
        if (
          metadata === undefined ||
          metadata.dev !== snapshot.device ||
          metadata.ino !== snapshot.inode ||
          owner?.nonce !== snapshot.ownerNonce
        )
          return false;
        yield* tryStatePromise(() =>
          rm(paths.supervisorLock, { recursive: true, force: true }),
        );
        reclaimed = true;
        return true;
      }).pipe(
        Effect.ensuring(
          Effect.suspend(() => (reclaimed ? Effect.void : removeClaim(claim))),
        ),
      );
    }),
  );
}

class LockContention extends Data.TaggedError("LockContention") {}

function removeLockAfterFailedClaim(paths: StatePaths): Effect.Effect<void> {
  return Effect.tryPromise({
    try: () => rm(paths.supervisorLock, { recursive: true, force: true }),
    catch: (cause) => new IgnoredStateFailure({ cause }),
  }).pipe(Effect.catch(() => reportCleanupFailure()));
}

function claimSupervisorLock(
  paths: StatePaths,
): Effect.Effect<
  SupervisorLock,
  RuntimeStateError | LockContention,
  Scope.Scope
> {
  return Effect.uninterruptible(
    Effect.gen(function* () {
      const created = yield* Effect.tryPromise({
        try: () =>
          mkdir(paths.supervisorLock, { mode: 0o700 }).then(() => true),
        catch: (cause) => new IgnoredStateFailure({ cause }),
      }).pipe(
        Effect.catch((failure) =>
          (failure.cause as NodeJS.ErrnoException).code === "EEXIST"
            ? Effect.succeed(false)
            : Effect.fail(stateFailure(failure.cause)),
        ),
      );
      if (!created) {
        const stale = yield* staleLockSnapshot(paths);
        if (stale !== undefined && (yield* reclaimStaleLock(paths, stale)))
          return yield* claimSupervisorLock(paths);
        return yield* new LockContention();
      }

      const nonce = yield* Effect.gen(function* () {
        const generated = yield* Effect.try({
          try: () => randomBytes(16).toString("hex"),
          catch: (cause) => stateFailure(cause),
        });
        yield* writePrivateJson(path.join(paths.supervisorLock, "owner.json"), {
          pid: process.pid,
          nonce: generated,
        });
        return generated;
      }).pipe(
        Effect.catch((error) =>
          removeLockAfterFailedClaim(paths).pipe(
            Effect.andThen(Effect.fail(error)),
          ),
        ),
      );
      yield* Effect.addFinalizer(() => releaseSupervisorLock(paths, nonce));
      return { nonce };
    }),
  );
}

function releaseSupervisorLock(
  paths: StatePaths,
  nonce: string,
): Effect.Effect<void> {
  return Effect.gen(function* () {
    const owner = yield* readLockOwner(paths);
    if (owner?.nonce !== nonce) return;
    yield* Effect.tryPromise({
      try: () => rm(paths.supervisorLock, { recursive: true, force: true }),
      catch: (cause) => new IgnoredStateFailure({ cause }),
    }).pipe(Effect.catch(() => reportCleanupFailure()));
  });
}

export function acquireSupervisorLock(
  paths: StatePaths,
  timeoutMilliseconds = 10_000,
): Effect.Effect<SupervisorLock, RuntimeStateError, Scope.Scope> {
  const timeoutFailure = () =>
    stateFailure(
      new Error("Timed out waiting for the supervisor ownership lock"),
      {
        message: "The htmlview supervisor ownership lock is unavailable",
        reason: "ownership_timeout",
      },
    );
  const acquire = claimSupervisorLock(paths).pipe(
    Effect.retry({
      schedule: Schedule.spaced(lockObservationMilliseconds),
      while: (error) => error instanceof LockContention,
    }),
    Effect.timeoutOrElse({
      duration: timeoutMilliseconds,
      orElse: () => Effect.fail(timeoutFailure()),
    }),
    Effect.catchTag("LockContention", () => Effect.fail(timeoutFailure())),
  );
  return acquire;
}

export function transferSupervisorLock(
  paths: StatePaths,
  expectedNonce: string,
  owner: { readonly pid: number; readonly instanceId: string },
): Effect.Effect<SupervisorLock, RuntimeStateError, Scope.Scope> {
  const acquire = Effect.uninterruptible(
    Effect.gen(function* () {
      const current = yield* readLockOwner(paths);
      if (current?.nonce !== expectedNonce)
        return yield* stateFailure(
          new Error("The htmlview supervisor ownership lock changed owners"),
          {
            message: "The htmlview supervisor ownership lock is unavailable",
            reason: "ownership_changed",
          },
        );
      const nonce = owner.instanceId;
      yield* writePrivateJson(path.join(paths.supervisorLock, "owner.json"), {
        pid: owner.pid,
        nonce,
      });
      yield* Effect.addFinalizer(() => releaseSupervisorLock(paths, nonce));
      return { nonce };
    }),
  );
  return acquire;
}
