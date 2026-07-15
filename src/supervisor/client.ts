import { spawn } from "node:child_process";
import { realpath } from "node:fs/promises";
import {
  request as httpRequest,
  type ClientRequest,
  type IncomingMessage,
} from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Data, Effect, Exit, Result, Schedule, Scope } from "effect";
import {
  operationalError,
  PathError,
  RuntimeStateError,
  SupervisorError,
  type OperationalError,
} from "../errors.js";
import { isWithinRoot } from "../serving/grant.js";
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

async function prepareState(paths: StatePaths): Promise<void> {
  await Effect.runPromise(ensurePrivateStateDirectory(paths));
}

async function canonicalPotentialPath(candidate: string): Promise<string> {
  const suffix: string[] = [];
  let current = candidate;
  while (true) {
    try {
      return path.join(await realpath(current), ...suffix);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const parent = path.dirname(current);
      if (parent === current) throw error;
      suffix.unshift(path.basename(current));
      current = parent;
    }
  }
}

async function assertStateOutsideRoot(
  paths: StatePaths,
  root: string,
): Promise<void> {
  let stateDirectory: string;
  try {
    stateDirectory = await canonicalPotentialPath(paths.directory);
  } catch (cause) {
    throw new RuntimeStateError({
      code: "state.unavailable",
      message: "The private htmlview runtime state directory is unavailable",
      cause,
    });
  }
  if (root === stateDirectory || isWithinRoot(root, stateDirectory))
    throw new PathError({
      code: "path.root_contains_state",
      message:
        "Serving root cannot contain the htmlview runtime state directory",
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

function incompatible(result: ProbeResult): never {
  const message =
    result.status === "version_mismatch"
      ? `The running htmlview supervisor uses version ${result.identity.version}; stop it before using ${htmlviewVersion}`
      : "The running htmlview supervisor uses an incompatible control protocol";
  throw new SupervisorError({ code: "supervisor.incompatible", message });
}

async function currentSupervisor(
  paths: StatePaths,
  allowVersionMismatch = false,
): Promise<SupervisorIdentity | undefined> {
  const result = await Effect.runPromise(probeWithRetries(paths));
  if (result.status === "healthy") return result.identity;
  if (result.status === "version_mismatch" && allowVersionMismatch)
    return result.identity;
  if (result.status === "version_mismatch" || result.status === "incompatible")
    return incompatible(result);
  if (result.status === "unavailable")
    throw new SupervisorError({
      code: "supervisor.unavailable",
      message: "The htmlview supervisor is alive but temporarily unavailable",
    });
  return undefined;
}

function supervisorEntry(): string {
  return fileURLToPath(new URL("./supervisor-main.js", import.meta.url));
}

export type StartSupervisorProcess = (
  paths: StatePaths,
  ownershipNonce: string,
) => Promise<void>;

const startDetachedSupervisor: StartSupervisorProcess = (
  paths,
  ownershipNonce,
) =>
  new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [supervisorEntry()], {
      detached: true,
      stdio: "ignore",
      env: {
        ...process.env,
        HTMLVIEW_STATE_DIR: paths.directory,
        HTMLVIEW_SUPERVISOR_LOCK_NONCE: ownershipNonce,
      },
    });
    child.once("error", reject);
    child.once("spawn", () => {
      child.unref();
      resolve();
    });
  });

interface ScopedSupervisorLock extends SupervisorLock {
  release(): Promise<void>;
}

async function acquireScopedSupervisorLock(
  paths: StatePaths,
  timeoutMilliseconds?: number,
): Promise<ScopedSupervisorLock> {
  const scope = await Effect.runPromise(Scope.make());
  try {
    const lock = await Effect.runPromise(
      Scope.provide(scope)(acquireSupervisorLock(paths, timeoutMilliseconds)),
    );
    let released = false;
    return {
      ...lock,
      release: async () => {
        if (released) return;
        released = true;
        await Effect.runPromise(Scope.close(scope, Exit.void));
      },
    };
  } catch (error) {
    await Effect.runPromise(Scope.close(scope, Exit.void));
    throw error;
  }
}

async function ensureSupervisor(
  paths: StatePaths,
  startProcess: StartSupervisorProcess,
): Promise<SupervisorIdentity> {
  await prepareState(paths);
  const current = await currentSupervisor(paths);
  if (current !== undefined) return current;

  const ownership = await acquireOwnershipOrObserve(paths);
  if (ownership.kind === "identity") return ownership.identity;
  const { lock } = ownership;
  try {
    const afterLock = await Effect.runPromise(probeWithRetries(paths));
    if (afterLock.status === "healthy") return afterLock.identity;
    if (
      afterLock.status === "version_mismatch" ||
      afterLock.status === "incompatible"
    )
      return incompatible(afterLock);
    if (afterLock.status === "unavailable")
      throw new SupervisorError({
        code: "supervisor.unavailable",
        message: "The htmlview supervisor is alive but temporarily unavailable",
      });

    try {
      await Effect.runPromise(removeStaleControlSocket(paths));
      await startProcess(paths, lock.nonce);
    } catch (cause) {
      throw new SupervisorError({
        code: "supervisor.start_failed",
        message: "The htmlview supervisor process could not start",
        cause,
      });
    }

    const deadline = Date.now() + supervisorStartTimeoutMilliseconds;
    while (Date.now() < deadline) {
      const started = await Effect.runPromise(probeOnce(paths));
      if (started.status === "healthy") return started.identity;
      if (
        started.status === "version_mismatch" ||
        started.status === "incompatible"
      )
        return incompatible(started);
      await Effect.runPromise(Effect.sleep(50));
    }
    throw new SupervisorError({
      code: "supervisor.start_failed",
      message: "The htmlview supervisor did not become ready",
    });
  } finally {
    await lock.release();
  }
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

async function acquireOwnershipOrObserve(
  paths: StatePaths,
  allowVersionMismatch = false,
): Promise<
  | { readonly kind: "lock"; readonly lock: ScopedSupervisorLock }
  | { readonly kind: "identity"; readonly identity: SupervisorIdentity }
> {
  const deadline = Date.now() + supervisorOwnershipWaitMilliseconds;
  while (Date.now() < deadline) {
    try {
      return {
        kind: "lock",
        lock: await acquireScopedSupervisorLock(paths, 100),
      };
    } catch (error) {
      if (
        !(error instanceof RuntimeStateError) ||
        error.reason !== "ownership_timeout"
      )
        throw ownershipLockError(error);
    }

    const result = await Effect.runPromise(probeOnce(paths));
    if (result.status === "healthy")
      return { kind: "identity", identity: result.identity };
    if (result.status === "version_mismatch" && allowVersionMismatch)
      return { kind: "identity", identity: result.identity };
    if (
      result.status === "version_mismatch" ||
      result.status === "incompatible"
    )
      return incompatible(result);
    if (result.status === "unavailable")
      throw new SupervisorError({
        code: "supervisor.unavailable",
        message: "The htmlview supervisor is alive but temporarily unavailable",
      });
    await Effect.runPromise(Effect.sleep(50));
  }
  throw ownershipLockError(ownershipTimeoutError());
}

async function existingSupervisor(
  paths: StatePaths,
  allowVersionMismatch = false,
): Promise<SupervisorIdentity | undefined> {
  const current = await currentSupervisor(paths, allowVersionMismatch);
  if (current !== undefined) return current;

  const ownership = await acquireOwnershipOrObserve(
    paths,
    allowVersionMismatch,
  );
  if (ownership.kind === "identity") return ownership.identity;
  const { lock } = ownership;
  try {
    const afterLock = await Effect.runPromise(probeWithRetries(paths));
    if (afterLock.status === "healthy") return afterLock.identity;
    if (afterLock.status === "version_mismatch" && allowVersionMismatch)
      return afterLock.identity;
    if (
      afterLock.status === "version_mismatch" ||
      afterLock.status === "incompatible"
    )
      return incompatible(afterLock);
    if (afterLock.status === "unavailable")
      throw new SupervisorError({
        code: "supervisor.unavailable",
        message: "The htmlview supervisor is alive but temporarily unavailable",
      });
    if (afterLock.status === "stale")
      await Effect.runPromise(removeStaleControlSocket(paths));
    return undefined;
  } finally {
    await lock.release();
  }
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

async function expectedSessionGrant(
  entry: string,
  root: string,
): Promise<{ readonly entry: string; readonly root: string }> {
  let canonicalRoot: string;
  try {
    canonicalRoot = await realpath(root);
  } catch (cause) {
    const permissionDenied =
      (cause as NodeJS.ErrnoException).code === "EACCES" ||
      (cause as NodeJS.ErrnoException).code === "EPERM";
    throw new PathError({
      code: permissionDenied ? "path.root_unreadable" : "path.root_not_found",
      message: permissionDenied
        ? `Serving root is not accessible: ${root}`
        : `Serving root does not exist: ${root}`,
      cause,
    });
  }
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
}

async function requiredRequest<T>(
  paths: StatePaths,
  method: "GET" | "POST",
  route: string,
  decode: (value: unknown) => Result.Result<T, unknown>,
  body?: unknown,
): Promise<T> {
  let response: ControlResponse;
  try {
    response = await Effect.runPromise(
      controlRequest(paths, method, route, body),
    );
  } catch (cause) {
    throw new SupervisorError({
      code: "supervisor.unavailable",
      message: "The htmlview supervisor became unavailable",
      cause,
    });
  }
  if (response.status < 200 || response.status >= 300)
    throw controlError(
      response.value,
      `Supervisor request failed with HTTP ${response.status}`,
    );
  const decoded = decode(response.value);
  if (Result.isSuccess(decoded)) return decoded.success;
  throw new SupervisorError({
    code: "supervisor.request_failed",
    message: "The htmlview supervisor returned an invalid response",
  });
}

async function waitForShutdown(
  paths: StatePaths,
  instanceId: string,
): Promise<void> {
  const deadline = Date.now() + supervisorShutdownTimeoutMilliseconds;
  while (Date.now() < deadline) {
    const result = await Effect.runPromise(probeOnce(paths));
    if (
      (result.status === "healthy" || result.status === "version_mismatch") &&
      result.identity.instanceId !== instanceId
    )
      return;
    if (result.status === "absent" || result.status === "stale") {
      let lock;
      try {
        lock = await acquireScopedSupervisorLock(paths, 100);
      } catch {
        await Effect.runPromise(Effect.sleep(50));
        continue;
      }
      try {
        const settled = await Effect.runPromise(probeOnce(paths));
        if (settled.status === "stale") {
          await Effect.runPromise(removeStaleControlSocket(paths));
          return;
        }
        if (settled.status === "absent") return;
        if (
          (settled.status === "healthy" ||
            settled.status === "version_mismatch") &&
          settled.identity.instanceId !== instanceId
        )
          return;
      } finally {
        await lock.release();
      }
    }
    await Effect.runPromise(Effect.sleep(50));
  }
  throw new SupervisorError({
    code: "supervisor.unavailable",
    message: "The htmlview supervisor did not finish shutting down",
  });
}

export class SupervisorClient {
  readonly #paths: StatePaths;
  readonly #startProcess: StartSupervisorProcess;

  constructor(
    paths: StatePaths = statePaths(),
    startProcess: StartSupervisorProcess = startDetachedSupervisor,
  ) {
    this.#paths = paths;
    this.#startProcess = startProcess;
  }

  async list(
    fields: readonly OptionalSessionField[] = [],
  ): Promise<readonly SessionSummary[]> {
    await prepareState(this.#paths);
    const identity = await existingSupervisor(this.#paths);
    if (identity === undefined) return [];
    const query =
      fields.length === 0
        ? ""
        : `?fields=${encodeURIComponent(fields.join(","))}`;
    const result = await requiredRequest(
      this.#paths,
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
  }

  async serve(entry: string, root: string): Promise<ServeControlResult> {
    await assertStateOutsideRoot(this.#paths, root);
    const expectedGrant = await expectedSessionGrant(entry, root);
    await ensureSupervisor(this.#paths, this.#startProcess);
    return requiredRequest(
      this.#paths,
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
  }

  async stopSession(session: string): Promise<StopControlResult> {
    await prepareState(this.#paths);
    const identity = await existingSupervisor(this.#paths);
    if (identity === undefined) return { stopped: 0 };
    return requiredRequest(
      this.#paths,
      "POST",
      "/stop",
      decodeTargetedStopControlResult,
      encodeStopSessionRequest({ session }),
    );
  }

  async stopAll(): Promise<StopControlResult> {
    await prepareState(this.#paths);
    const identity = await existingSupervisor(this.#paths, true);
    if (identity === undefined) return { stopped: 0 };
    const result = await requiredRequest(
      this.#paths,
      "POST",
      "/shutdown",
      decodeStopControlResult,
      encodeShutdownRequest({}),
    );
    await waitForShutdown(this.#paths, identity.instanceId);
    return result;
  }
}
