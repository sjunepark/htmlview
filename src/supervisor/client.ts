import { spawn, type SpawnOptions } from "node:child_process";
import { realpath } from "node:fs/promises";
import {
  request as httpRequest,
  type ClientRequest,
  type IncomingMessage,
} from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Clock, Data, Effect, Result, Schedule, Scope } from "effect";
import {
  operationalError,
  PathError,
  RuntimeStateError,
  SupervisorError,
  type OperationalError,
} from "../errors.js";
import { canonicalTreesOverlap } from "../serving/grant.js";
import { htmlviewVersion } from "../version.js";
import {
  acquireSupervisorLock,
  ensurePrivateStateDirectory,
  removeStaleControlSocket,
  statePaths,
  type SupervisorLock,
  type StatePaths,
} from "./state.js";
import {
  controlHost,
  decodeControlError,
  decodeServeControlResult,
  decodeSessionListResult,
  decodeStopControlResult,
  decodeTargetedStopControlResult,
  decodeSupervisorIdentity,
  encodeCreateSessionRequest,
  encodeShutdownRequest,
  encodeStopSessionRequest,
  maximumControlResponseBytes,
  supervisorProtocol,
  type OptionalSessionField,
  type ServeControlResult,
  type SessionSummary,
  type StopControlResult,
  type SupervisorIdentity,
} from "./protocol.js";

const controlRequestTimeoutMilliseconds = 2_000;
const healthRequestTimeoutMilliseconds = 500;
const healthRetryCount = 3;
const healthRetryDelayMilliseconds = 100;
const supervisorStartTimeoutMilliseconds = 5_000;
const supervisorShutdownTimeoutMilliseconds = 5_000;
const supervisorOwnershipWaitMilliseconds = 10_000;

type AcquireSupervisorLock = (
  paths: StatePaths,
  timeoutMilliseconds?: number,
) => Effect.Effect<SupervisorLock, RuntimeStateError, Scope.Scope>;

class CanonicalPathError extends Data.TaggedError("CanonicalPathError")<{
  readonly cause: unknown;
}> {}

function canonicalPotentialPath(
  candidate: string,
): Effect.Effect<string, CanonicalPathError> {
  const loop = (
    current: string,
    suffix: readonly string[],
  ): Effect.Effect<string, CanonicalPathError> =>
    Effect.tryPromise({
      try: () => realpath(current),
      catch: (cause) => new CanonicalPathError({ cause }),
    }).pipe(
      Effect.map((canonical) => path.join(canonical, ...suffix)),
      Effect.catchTag("CanonicalPathError", (error) => {
        if (
          error.cause instanceof Error &&
          (error.cause as NodeJS.ErrnoException).code === "ENOENT"
        ) {
          const parent = path.dirname(current);
          if (parent !== current)
            return loop(parent, [path.basename(current), ...suffix]);
        }
        return Effect.fail(error);
      }),
    );
  return loop(candidate, []);
}

function assertStateOutsideRoot(
  paths: StatePaths,
  root: string,
): Effect.Effect<void, RuntimeStateError | PathError> {
  return Effect.gen(function* () {
    const stateDirectory = yield* canonicalPotentialPath(paths.directory).pipe(
      Effect.mapError(
        (error) =>
          new RuntimeStateError({
            code: "state.unavailable",
            message:
              "The private htmlview runtime state directory is unavailable",
            cause: error.cause,
          }),
      ),
    );
    if (canonicalTreesOverlap(root, stateDirectory))
      return yield* new PathError({
        code: "path.root_contains_state",
        message:
          "Serving root and htmlview runtime state directory must be disjoint",
      });
  });
}

interface ControlResponse {
  readonly status: number;
  readonly value: unknown;
}

type ControlRequestFailureReason =
  "timeout" | "transport" | "response_too_large" | "invalid_json";

class ControlRequestError extends Data.TaggedError("ControlRequestError")<{
  readonly reason: ControlRequestFailureReason;
  readonly cause: unknown;
  readonly transportCode: string | undefined;
}> {}

function requestFailure(
  reason: ControlRequestFailureReason,
  cause: unknown,
): ControlRequestError {
  return new ControlRequestError({
    reason,
    cause,
    transportCode:
      cause instanceof Error
        ? (cause as NodeJS.ErrnoException).code
        : undefined,
  });
}

function controlRequest(
  paths: StatePaths,
  method: "GET" | "POST",
  route: string,
  body?: unknown,
  timeoutMilliseconds = controlRequestTimeoutMilliseconds,
): Effect.Effect<ControlResponse, ControlRequestError> {
  return Effect.callback<ControlResponse, ControlRequestError>((resume) => {
    const payload =
      body === undefined ? undefined : Buffer.from(JSON.stringify(body));
    let operation: ClientRequest | undefined;
    let response: IncomingMessage | undefined;
    let settled = false;
    const chunks: Buffer[] = [];
    let size = 0;
    const cleanup = (): void => {
      operation?.off("timeout", onTimeout);
      response?.off("data", onData);
      response?.off("end", onEnd);
      response?.off("aborted", onAborted);
    };
    const complete = (
      result: Effect.Effect<ControlResponse, ControlRequestError>,
    ): void => {
      if (settled) return;
      settled = true;
      cleanup();
      resume(result);
    };
    const onTimeout = (): void => {
      complete(
        Effect.fail(
          requestFailure("timeout", new Error("Supervisor request timed out")),
        ),
      );
      operation?.destroy();
    };
    const onRequestError = (cause: Error): void => {
      complete(Effect.fail(requestFailure("transport", cause)));
    };
    const onData = (chunk: Buffer): void => {
      size += chunk.length;
      if (size > maximumControlResponseBytes) {
        complete(
          Effect.fail(
            requestFailure(
              "response_too_large",
              new Error("Supervisor response exceeded the size limit"),
            ),
          ),
        );
        response?.destroy();
        operation?.destroy();
        return;
      }
      chunks.push(chunk);
    };
    const onEnd = (): void => {
      try {
        complete(
          Effect.succeed({
            status: response?.statusCode ?? 0,
            value: JSON.parse(Buffer.concat(chunks).toString("utf8")),
          }),
        );
      } catch (cause) {
        complete(Effect.fail(requestFailure("invalid_json", cause)));
      }
    };
    const onResponseError = (cause: Error): void => {
      complete(Effect.fail(requestFailure("transport", cause)));
    };
    const onAborted = (): void => {
      complete(
        Effect.fail(
          requestFailure("transport", new Error("Supervisor response aborted")),
        ),
      );
    };
    try {
      operation = httpRequest(
        {
          socketPath: paths.controlSocket,
          method,
          path: route,
          headers: {
            host: controlHost,
            ...(payload === undefined
              ? {}
              : {
                  "content-type": "application/json",
                  "content-length": String(payload.length),
                }),
          },
        },
        (incoming) => {
          if (settled) {
            incoming.destroy();
            return;
          }
          response = incoming;
          incoming.on("data", onData);
          incoming.once("end", onEnd);
          incoming.once("error", onResponseError);
          incoming.once("aborted", onAborted);
        },
      );
    } catch (cause) {
      complete(Effect.fail(requestFailure("transport", cause)));
      return;
    }
    operation.setTimeout(timeoutMilliseconds);
    operation.once("timeout", onTimeout);
    operation.once("error", onRequestError);
    if (payload !== undefined) operation.write(payload);
    operation.end();
    return Effect.sync(() => {
      settled = true;
      cleanup();
      response?.destroy();
      operation?.destroy();
    });
  });
}

type ProbeResult =
  | { readonly status: "healthy"; readonly identity: SupervisorIdentity }
  | {
      readonly status: "version_mismatch";
      readonly identity: SupervisorIdentity;
    }
  | { readonly status: "absent" | "stale" | "unavailable" }
  | { readonly status: "incompatible" };

function probeOnce(paths: StatePaths): Effect.Effect<ProbeResult> {
  return controlRequest(
    paths,
    "GET",
    "/health",
    undefined,
    healthRequestTimeoutMilliseconds,
  ).pipe(
    Effect.match({
      onFailure: (error): ProbeResult => {
        if (error.transportCode === "ENOENT") return { status: "absent" };
        if (error.transportCode === "ECONNREFUSED") return { status: "stale" };
        return { status: "unavailable" };
      },
      onSuccess: (response): ProbeResult => {
        if (response.status !== 200) return { status: "unavailable" };
        const decoded = decodeSupervisorIdentity(response.value);
        if (Result.isFailure(decoded)) return { status: "unavailable" };
        if (decoded.success.protocol !== supervisorProtocol)
          return { status: "incompatible" };
        if (decoded.success.version !== htmlviewVersion)
          return { status: "version_mismatch", identity: decoded.success };
        return { status: "healthy", identity: decoded.success };
      },
    }),
  );
}

class UnavailableProbe extends Data.TaggedError("UnavailableProbe")<{
  readonly result: ProbeResult;
}> {}

const healthProbeSchedule = Schedule.max([
  Schedule.spaced(healthRetryDelayMilliseconds),
  Schedule.recurs(healthRetryCount - 1),
]);

function probeWithRetries(paths: StatePaths): Effect.Effect<ProbeResult> {
  return probeOnce(paths).pipe(
    Effect.flatMap((result) =>
      result.status === "unavailable"
        ? Effect.fail(new UnavailableProbe({ result }))
        : Effect.succeed(result),
    ),
    Effect.retry(healthProbeSchedule),
    Effect.catchTag("UnavailableProbe", ({ result }) => Effect.succeed(result)),
  );
}

function incompatibleError(result: ProbeResult): SupervisorError {
  const message =
    result.status === "version_mismatch"
      ? `The running htmlview supervisor uses version ${result.identity.version}; stop it before using ${htmlviewVersion}`
      : "The running htmlview supervisor uses an incompatible control protocol";
  return new SupervisorError({ code: "supervisor.incompatible", message });
}

function currentSupervisor(
  paths: StatePaths,
  allowVersionMismatch = false,
): Effect.Effect<SupervisorIdentity | undefined, SupervisorError> {
  return Effect.gen(function* () {
    const result = yield* probeWithRetries(paths);
    if (result.status === "healthy") return result.identity;
    if (result.status === "version_mismatch" && allowVersionMismatch)
      return result.identity;
    if (
      result.status === "version_mismatch" ||
      result.status === "incompatible"
    )
      return yield* incompatibleError(result);
    if (result.status === "unavailable")
      return yield* new SupervisorError({
        code: "supervisor.unavailable",
        message: "The htmlview supervisor is alive but temporarily unavailable",
      });
    return undefined;
  });
}

function supervisorEntry(): string {
  return fileURLToPath(new URL("./supervisor-main.js", import.meta.url));
}

export class ProcessStartError extends Data.TaggedError("ProcessStartError")<{
  readonly cause: unknown;
}> {}

export type StartSupervisorProcess = (
  paths: StatePaths,
  ownershipNonce: string,
) => Effect.Effect<void, ProcessStartError>;

export interface DetachedSupervisorChild {
  readonly exitCode: number | null;
  once(event: "error", listener: (cause: Error) => void): this;
  once(event: "spawn", listener: () => void): this;
  once(event: "exit", listener: () => void): this;
  off(event: "error", listener: (cause: Error) => void): this;
  off(event: "spawn", listener: () => void): this;
  off(event: "exit", listener: () => void): this;
  kill(): boolean;
  unref(): void;
}

export type SpawnDetachedSupervisor = (
  command: string,
  arguments_: readonly string[],
  options: SpawnOptions,
) => DetachedSupervisorChild;

export function makeDetachedSupervisorStarter(
  spawnProcess: SpawnDetachedSupervisor,
): StartSupervisorProcess {
  return (paths, ownershipNonce) =>
    Effect.callback<void, ProcessStartError>((resume) => {
      const controller = new AbortController();
      let child: DetachedSupervisorChild | undefined;
      let settled = false;
      let interrupted = false;
      let handedOff = false;
      const cleanup = (): void => {
        child?.off("error", onError);
        child?.off("spawn", onSpawn);
        child?.off("exit", onExit);
      };
      const onError = (cause: Error): void => {
        if (settled) return;
        settled = true;
        cleanup();
        if (!interrupted) resume(Effect.fail(new ProcessStartError({ cause })));
      };
      const onExit = (): void => {
        if (interrupted) cleanup();
      };
      const onSpawn = (): void => {
        if (settled) return;
        if (interrupted) {
          try {
            child?.kill();
          } catch {
            // The abort signal may have already ended the child.
          }
          return;
        }
        settled = true;
        handedOff = true;
        cleanup();
        child?.unref();
        resume(Effect.void);
      };
      try {
        child = spawnProcess(process.execPath, [supervisorEntry()], {
          detached: true,
          stdio: "ignore",
          signal: controller.signal,
          env: {
            ...process.env,
            HTMLVIEW_STATE_DIR: paths.directory,
            HTMLVIEW_SUPERVISOR_LOCK_NONCE: ownershipNonce,
          },
        });
      } catch (cause) {
        settled = true;
        resume(Effect.fail(new ProcessStartError({ cause })));
        return;
      }
      child.once("error", onError);
      child.once("spawn", onSpawn);
      child.once("exit", onExit);
      return Effect.sync(() => {
        if (handedOff || settled) return;
        interrupted = true;
        controller.abort();
        try {
          child?.kill();
        } catch {
          // A late spawn/error event retains listeners and settles cleanup.
        }
      });
    });
}

const startDetachedSupervisor = makeDetachedSupervisorStarter(
  (command, arguments_, options) => spawn(command, arguments_, options),
);

class StartupPending extends Data.TaggedError("StartupPending") {}

const startupReadinessSchedule = Schedule.spaced(50);

function waitForStartup(
  paths: StatePaths,
): Effect.Effect<SupervisorIdentity, SupervisorError> {
  return Effect.gen(function* () {
    const deadline =
      (yield* Clock.currentTimeMillis) + supervisorStartTimeoutMilliseconds;
    const attempt = Effect.gen(function* () {
      if ((yield* Clock.currentTimeMillis) >= deadline)
        return yield* new SupervisorError({
          code: "supervisor.start_failed",
          message: "The htmlview supervisor did not become ready",
        });
      const started = yield* probeOnce(paths);
      if (started.status === "healthy") return started.identity;
      if (
        started.status === "version_mismatch" ||
        started.status === "incompatible"
      )
        return yield* incompatibleError(started);
      return yield* new StartupPending();
    });
    return yield* attempt.pipe(
      Effect.retry({
        schedule: startupReadinessSchedule,
        while: (error) => error instanceof StartupPending,
      }),
      Effect.catchTag(
        "StartupPending",
        () =>
          new SupervisorError({
            code: "supervisor.start_failed",
            message: "The htmlview supervisor did not become ready",
          }),
      ),
    );
  });
}

function ensureSupervisor(
  paths: StatePaths,
  startProcess: StartSupervisorProcess,
  acquireLock: AcquireSupervisorLock,
): Effect.Effect<SupervisorIdentity, OperationalError> {
  return Effect.scoped(
    Effect.gen(function* () {
      yield* ensurePrivateStateDirectory(paths);
      const current = yield* currentSupervisor(paths);
      if (current !== undefined) return current;

      const ownership = yield* acquireOwnershipOrObserve(
        paths,
        false,
        acquireLock,
      );
      if (ownership.kind === "identity") return ownership.identity;
      const afterLock = yield* probeWithRetries(paths);
      if (afterLock.status === "healthy") return afterLock.identity;
      if (
        afterLock.status === "version_mismatch" ||
        afterLock.status === "incompatible"
      )
        return yield* incompatibleError(afterLock);
      if (afterLock.status === "unavailable")
        return yield* new SupervisorError({
          code: "supervisor.unavailable",
          message:
            "The htmlview supervisor is alive but temporarily unavailable",
        });

      yield* removeStaleControlSocket(paths).pipe(
        Effect.andThen(startProcess(paths, ownership.lock.nonce)),
        Effect.mapError(
          (error) =>
            new SupervisorError({
              code: "supervisor.start_failed",
              message: "The htmlview supervisor process could not start",
              cause: error instanceof ProcessStartError ? error.cause : error,
            }),
        ),
      );
      return yield* waitForStartup(paths);
    }),
  );
}

function ownershipLockError(error: unknown): OperationalError {
  return error instanceof RuntimeStateError &&
    error.reason === "ownership_timeout"
    ? new SupervisorError({
        code: "supervisor.unavailable",
        message:
          "The htmlview supervisor is still releasing its control authority",
        cause: error,
      })
    : new RuntimeStateError({
        code: "state.unavailable",
        message: "The htmlview supervisor ownership lock is unavailable",
        cause: error,
      });
}

function ownershipTimeoutError(): RuntimeStateError {
  return new RuntimeStateError({
    code: "state.unavailable",
    message: "The htmlview supervisor ownership lock is unavailable",
    reason: "ownership_timeout",
    cause: new Error("Timed out waiting for the supervisor ownership lock"),
  });
}

class OwnershipPending extends Data.TaggedError("OwnershipPending") {}

const ownershipObservationSchedule = Schedule.spaced(50);

function acquireOwnershipOrObserve(
  paths: StatePaths,
  allowVersionMismatch: boolean,
  acquireLock: AcquireSupervisorLock,
): Effect.Effect<
  | { readonly kind: "lock"; readonly lock: SupervisorLock }
  | { readonly kind: "identity"; readonly identity: SupervisorIdentity },
  OperationalError,
  Scope.Scope
> {
  return Effect.gen(function* () {
    const deadline =
      (yield* Clock.currentTimeMillis) + supervisorOwnershipWaitMilliseconds;
    const attempt = Effect.gen(function* () {
      if ((yield* Clock.currentTimeMillis) >= deadline)
        return yield* ownershipLockError(ownershipTimeoutError());
      const acquired = yield* Effect.result(acquireLock(paths, 100));
      if (Result.isSuccess(acquired))
        return { kind: "lock" as const, lock: acquired.success };
      if (
        !(acquired.failure instanceof RuntimeStateError) ||
        acquired.failure.reason !== "ownership_timeout"
      )
        return yield* ownershipLockError(acquired.failure);

      const result = yield* probeOnce(paths);
      if (result.status === "healthy")
        return { kind: "identity" as const, identity: result.identity };
      if (result.status === "version_mismatch" && allowVersionMismatch)
        return { kind: "identity" as const, identity: result.identity };
      if (
        result.status === "version_mismatch" ||
        result.status === "incompatible"
      )
        return yield* incompatibleError(result);
      if (result.status === "unavailable")
        return yield* new SupervisorError({
          code: "supervisor.unavailable",
          message:
            "The htmlview supervisor is alive but temporarily unavailable",
        });
      return yield* new OwnershipPending();
    });
    return yield* attempt.pipe(
      Effect.retry({
        schedule: ownershipObservationSchedule,
        while: (error) => error instanceof OwnershipPending,
      }),
      Effect.catchTag("OwnershipPending", () =>
        Effect.fail(ownershipLockError(ownershipTimeoutError())),
      ),
    );
  });
}

function existingSupervisor(
  paths: StatePaths,
  allowVersionMismatch: boolean,
  acquireLock: AcquireSupervisorLock,
): Effect.Effect<SupervisorIdentity | undefined, OperationalError> {
  return Effect.scoped(
    Effect.gen(function* () {
      const current = yield* currentSupervisor(paths, allowVersionMismatch);
      if (current !== undefined) return current;

      const ownership = yield* acquireOwnershipOrObserve(
        paths,
        allowVersionMismatch,
        acquireLock,
      );
      if (ownership.kind === "identity") return ownership.identity;
      const afterLock = yield* probeWithRetries(paths);
      if (afterLock.status === "healthy") return afterLock.identity;
      if (afterLock.status === "version_mismatch" && allowVersionMismatch)
        return afterLock.identity;
      if (
        afterLock.status === "version_mismatch" ||
        afterLock.status === "incompatible"
      )
        return yield* incompatibleError(afterLock);
      if (afterLock.status === "unavailable")
        return yield* new SupervisorError({
          code: "supervisor.unavailable",
          message:
            "The htmlview supervisor is alive but temporarily unavailable",
        });
      if (afterLock.status === "stale") yield* removeStaleControlSocket(paths);
      return undefined;
    }),
  );
}

function controlError(value: unknown, fallback: string): OperationalError {
  const decoded = decodeControlError(value);
  if (Result.isSuccess(decoded)) {
    const error = operationalError(
      decoded.success.error.code,
      decoded.success.error.message,
    );
    if (error !== undefined) return error;
  }
  return new SupervisorError({
    code: "supervisor.request_failed",
    message: fallback,
  });
}

function expectedSessionGrant(
  entry: string,
  root: string,
): Effect.Effect<{ readonly entry: string; readonly root: string }, PathError> {
  return Effect.gen(function* () {
    const canonicalRoot = yield* Effect.tryPromise({
      try: () => realpath(root),
      catch: (cause) => {
        const permissionDenied =
          cause instanceof Error &&
          ((cause as NodeJS.ErrnoException).code === "EACCES" ||
            (cause as NodeJS.ErrnoException).code === "EPERM");
        return new PathError({
          code: permissionDenied
            ? "path.root_unreadable"
            : "path.root_not_found",
          message: permissionDenied
            ? `Serving root is not accessible: ${root}`
            : `Serving root does not exist: ${root}`,
          cause,
        });
      },
    });
    const relativeEntry = path.relative(root, entry);
    return {
      entry:
        relativeEntry !== "" &&
        relativeEntry !== ".." &&
        !relativeEntry.startsWith(`..${path.sep}`) &&
        !path.isAbsolute(relativeEntry)
          ? path.join(canonicalRoot, relativeEntry)
          : entry,
      root: canonicalRoot,
    };
  });
}

class ControlResponseStatusError extends Data.TaggedError(
  "ControlResponseStatusError",
)<{
  readonly status: number;
  readonly value: unknown;
}> {}

class ControlResponseSchemaError extends Data.TaggedError(
  "ControlResponseSchemaError",
)<{
  readonly cause: unknown;
}> {}

function requiredRequest<T>(
  paths: StatePaths,
  method: "GET" | "POST",
  route: string,
  decode: (value: unknown) => Result.Result<T, unknown>,
  body?: unknown,
): Effect.Effect<T, OperationalError> {
  const request = Effect.gen(function* () {
    const response = yield* controlRequest(paths, method, route, body);
    if (response.status < 200 || response.status >= 300)
      return yield* new ControlResponseStatusError({
        status: response.status,
        value: response.value,
      });
    const decoded = decode(response.value);
    if (Result.isSuccess(decoded)) return decoded.success;
    return yield* new ControlResponseSchemaError({ cause: decoded.failure });
  });
  return request.pipe(
    Effect.mapError((error): OperationalError => {
      switch (error._tag) {
        case "ControlRequestError":
          return new SupervisorError({
            code: "supervisor.unavailable",
            message: "The htmlview supervisor became unavailable",
            cause: error,
          });
        case "ControlResponseStatusError":
          return controlError(
            error.value,
            `Supervisor request failed with HTTP ${error.status}`,
          );
        case "ControlResponseSchemaError":
          return new SupervisorError({
            code: "supervisor.request_failed",
            message: "The htmlview supervisor returned an invalid response",
            cause: error,
          });
      }
    }),
  );
}

class ShutdownPending extends Data.TaggedError("ShutdownPending") {}

const shutdownConfirmationSchedule = Schedule.spaced(50);

function waitForShutdown(
  paths: StatePaths,
  instanceId: string,
): Effect.Effect<void, OperationalError> {
  return Effect.gen(function* () {
    const deadline =
      (yield* Clock.currentTimeMillis) + supervisorShutdownTimeoutMilliseconds;
    const attempt = Effect.scoped(
      Effect.gen(function* () {
        if ((yield* Clock.currentTimeMillis) >= deadline)
          return yield* new SupervisorError({
            code: "supervisor.unavailable",
            message: "The htmlview supervisor did not finish shutting down",
          });
        const result = yield* probeOnce(paths);
        if (
          (result.status === "healthy" ||
            result.status === "version_mismatch") &&
          result.identity.instanceId !== instanceId
        )
          return;
        if (result.status === "absent" || result.status === "stale") {
          const acquired = yield* Effect.result(
            acquireSupervisorLock(paths, 100),
          );
          if (Result.isFailure(acquired)) return yield* new ShutdownPending();
          const settled = yield* probeOnce(paths);
          if (settled.status === "stale") {
            yield* removeStaleControlSocket(paths);
            return;
          }
          if (settled.status === "absent") return;
          if (
            (settled.status === "healthy" ||
              settled.status === "version_mismatch") &&
            settled.identity.instanceId !== instanceId
          )
            return;
        }
        return yield* new ShutdownPending();
      }),
    );
    return yield* attempt.pipe(
      Effect.retry({
        schedule: shutdownConfirmationSchedule,
        while: (error) => error instanceof ShutdownPending,
      }),
      Effect.catchTag(
        "ShutdownPending",
        () =>
          new SupervisorError({
            code: "supervisor.unavailable",
            message: "The htmlview supervisor did not finish shutting down",
          }),
      ),
    );
  });
}

export class SupervisorClient {
  readonly #paths: StatePaths;
  readonly #startProcess: StartSupervisorProcess;
  readonly #acquireLock: AcquireSupervisorLock;

  constructor(
    paths: StatePaths = statePaths(),
    startProcess: StartSupervisorProcess = startDetachedSupervisor,
    acquireLock: AcquireSupervisorLock = acquireSupervisorLock,
  ) {
    this.#paths = paths;
    this.#startProcess = startProcess;
    this.#acquireLock = acquireLock;
  }

  list(
    fields: readonly OptionalSessionField[] = [],
  ): Effect.Effect<readonly SessionSummary[], OperationalError> {
    const paths = this.#paths;
    const acquireLock = this.#acquireLock;
    return Effect.gen(function* () {
      yield* ensurePrivateStateDirectory(paths);
      const identity = yield* existingSupervisor(paths, false, acquireLock);
      if (identity === undefined) return [];
      const query =
        fields.length === 0
          ? ""
          : `?fields=${encodeURIComponent(fields.join(","))}`;
      const result = yield* requiredRequest(
        paths,
        "GET",
        `/sessions${query}`,
        (value) => {
          const decoded = decodeSessionListResult(value);
          if (Result.isFailure(decoded)) return decoded;
          const expected = new Set(fields);
          return decoded.success.sessions.every(
            (session) =>
              Object.hasOwn(session, "entry") === expected.has("entry") &&
              Object.hasOwn(session, "root") === expected.has("root"),
          )
            ? decoded
            : Result.fail("Session fields did not match the request");
        },
      );
      return result.sessions;
    });
  }

  serve(
    entry: string,
    root: string,
  ): Effect.Effect<ServeControlResult, OperationalError> {
    const paths = this.#paths;
    const startProcess = this.#startProcess;
    const acquireLock = this.#acquireLock;
    return Effect.gen(function* () {
      const expectedGrant = yield* expectedSessionGrant(entry, root);
      yield* assertStateOutsideRoot(paths, expectedGrant.root);
      yield* ensureSupervisor(paths, startProcess, acquireLock);
      return yield* requiredRequest(
        paths,
        "POST",
        "/sessions",
        (value) => {
          const decoded = decodeServeControlResult(value);
          if (Result.isFailure(decoded)) return decoded;
          return decoded.success.session.entry === expectedGrant.entry &&
            decoded.success.session.root === expectedGrant.root
            ? decoded
            : Result.fail("Session grant did not match the request");
        },
        encodeCreateSessionRequest({ entry, root }),
      );
    });
  }

  stopSession(
    session: string,
  ): Effect.Effect<StopControlResult, OperationalError> {
    const paths = this.#paths;
    const acquireLock = this.#acquireLock;
    return Effect.gen(function* () {
      yield* ensurePrivateStateDirectory(paths);
      const identity = yield* existingSupervisor(paths, false, acquireLock);
      if (identity === undefined) return { stopped: 0 };
      return yield* requiredRequest(
        paths,
        "POST",
        "/stop",
        decodeTargetedStopControlResult,
        encodeStopSessionRequest({ session }),
      );
    });
  }

  stopAll(): Effect.Effect<StopControlResult, OperationalError> {
    const paths = this.#paths;
    const acquireLock = this.#acquireLock;
    return Effect.gen(function* () {
      yield* ensurePrivateStateDirectory(paths);
      const identity = yield* existingSupervisor(paths, true, acquireLock);
      if (identity === undefined) return { stopped: 0 };
      const result = yield* requiredRequest(
        paths,
        "POST",
        "/shutdown",
        decodeStopControlResult,
        encodeShutdownRequest({}),
      );
      yield* waitForShutdown(paths, identity.instanceId);
      return result;
    });
  }
}
