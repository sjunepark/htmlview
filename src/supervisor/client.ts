import { spawn } from "node:child_process";
import { realpath } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Result } from "effect";
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
  try {
    await ensurePrivateStateDirectory(paths);
  } catch (cause) {
    throw new RuntimeStateError({
      code: "state.unavailable",
      message: "The private htmlview runtime state directory is unavailable",
      cause,
    });
  }
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

function controlRequest(
  paths: StatePaths,
  method: "GET" | "POST",
  route: string,
  body?: unknown,
  timeoutMilliseconds = controlRequestTimeoutMilliseconds,
): Promise<ControlResponse> {
  return new Promise((resolve, reject) => {
    const payload =
      body === undefined ? undefined : Buffer.from(JSON.stringify(body));
    const operation = httpRequest(
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
        timeout: timeoutMilliseconds,
      },
      (response) => {
        const chunks: Buffer[] = [];
        let size = 0;
        response.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > maximumControlResponseBytes) {
            response.destroy(
              new Error("Supervisor response exceeded the size limit"),
            );
            return;
          }
          chunks.push(chunk);
        });
        response.on("end", () => {
          try {
            resolve({
              status: response.statusCode ?? 0,
              value: JSON.parse(Buffer.concat(chunks).toString("utf8")),
            });
          } catch {
            reject(new Error("Supervisor returned invalid JSON"));
          }
        });
      },
    );
    operation.once("timeout", () =>
      operation.destroy(new Error("Supervisor request timed out")),
    );
    operation.once("error", reject);
    if (payload !== undefined) operation.write(payload);
    operation.end();
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

async function probeOnce(paths: StatePaths): Promise<ProbeResult> {
  let response: ControlResponse;
  try {
    response = await controlRequest(
      paths,
      "GET",
      "/health",
      undefined,
      healthRequestTimeoutMilliseconds,
    );
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return { status: "absent" };
    if (code === "ECONNREFUSED") return { status: "stale" };
    return { status: "unavailable" };
  }
  if (response.status !== 200) return { status: "unavailable" };
  const decoded = decodeSupervisorIdentity(response.value);
  if (Result.isFailure(decoded)) return { status: "unavailable" };
  if (decoded.success.protocol !== supervisorProtocol)
    return { status: "incompatible" };
  if (decoded.success.version !== htmlviewVersion)
    return { status: "version_mismatch", identity: decoded.success };
  return { status: "healthy", identity: decoded.success };
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function probeWithRetries(paths: StatePaths): Promise<ProbeResult> {
  let result = await probeOnce(paths);
  for (
    let attempt = 1;
    result.status === "unavailable" && attempt < healthRetryCount;
    attempt += 1
  ) {
    await delay(healthRetryDelayMilliseconds);
    result = await probeOnce(paths);
  }
  return result;
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
  const result = await probeWithRetries(paths);
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
    const afterLock = await probeWithRetries(paths);
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
      await removeStaleControlSocket(paths);
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
      const started = await probeOnce(paths);
      if (started.status === "healthy") return started.identity;
      if (
        started.status === "version_mismatch" ||
        started.status === "incompatible"
      )
        return incompatible(started);
      await delay(50);
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
  return error instanceof Error && error.message.startsWith("Timed out")
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

async function acquireOwnershipOrObserve(
  paths: StatePaths,
  allowVersionMismatch = false,
): Promise<
  | { readonly kind: "lock"; readonly lock: SupervisorLock }
  | { readonly kind: "identity"; readonly identity: SupervisorIdentity }
> {
  const deadline = Date.now() + supervisorOwnershipWaitMilliseconds;
  while (Date.now() < deadline) {
    try {
      return {
        kind: "lock",
        lock: await acquireSupervisorLock(paths, 100),
      };
    } catch (error) {
      if (!(error instanceof Error) || !error.message.startsWith("Timed out"))
        throw ownershipLockError(error);
    }

    const result = await probeOnce(paths);
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
    await delay(50);
  }
  throw ownershipLockError(
    new Error("Timed out waiting for the supervisor ownership lock"),
  );
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
    const afterLock = await probeWithRetries(paths);
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
    if (afterLock.status === "stale") await removeStaleControlSocket(paths);
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
    response = await controlRequest(paths, method, route, body);
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
    const result = await probeOnce(paths);
    if (
      (result.status === "healthy" || result.status === "version_mismatch") &&
      result.identity.instanceId !== instanceId
    )
      return;
    if (result.status === "absent" || result.status === "stale") {
      let lock;
      try {
        lock = await acquireSupervisorLock(paths, 100);
      } catch {
        await delay(50);
        continue;
      }
      try {
        const settled = await probeOnce(paths);
        if (settled.status === "stale") {
          await removeStaleControlSocket(paths);
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
    await delay(50);
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
