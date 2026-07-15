import { spawn } from "node:child_process";
import { realpath } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { OptionalSessionField, SessionSummary } from "../contracts.js";
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
  maximumControlResponseBytes,
  supervisorProtocol,
  type ControlError,
  type ServeControlResult,
  type SessionListResult,
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

export class SupervisorClientError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "SupervisorClientError";
  }
}

async function prepareState(paths: StatePaths): Promise<void> {
  try {
    await ensurePrivateStateDirectory(paths);
  } catch {
    throw new SupervisorClientError(
      "state.unavailable",
      "The private htmlview runtime state directory is unavailable",
    );
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
  } catch {
    throw new SupervisorClientError(
      "state.unavailable",
      "The private htmlview runtime state directory is unavailable",
    );
  }
  if (root === stateDirectory || isWithinRoot(root, stateDirectory))
    throw new SupervisorClientError(
      "path.root_contains_state",
      "Serving root cannot contain the htmlview runtime state directory",
    );
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

function isIdentity(value: unknown): value is SupervisorIdentity {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.protocol === "string" &&
    typeof candidate.instanceId === "string" &&
    typeof candidate.pid === "number" &&
    Number.isSafeInteger(candidate.pid) &&
    typeof candidate.version === "string"
  );
}

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
  if (response.status !== 200 || !isIdentity(response.value))
    return { status: "unavailable" };
  if (response.value.protocol !== supervisorProtocol)
    return { status: "incompatible" };
  if (response.value.version !== htmlviewVersion)
    return { status: "version_mismatch", identity: response.value };
  return { status: "healthy", identity: response.value };
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
  throw new SupervisorClientError("supervisor.incompatible", message);
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
    throw new SupervisorClientError(
      "supervisor.unavailable",
      "The htmlview supervisor is alive but temporarily unavailable",
    );
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
      throw new SupervisorClientError(
        "supervisor.unavailable",
        "The htmlview supervisor is alive but temporarily unavailable",
      );

    try {
      await removeStaleControlSocket(paths);
      await startProcess(paths, lock.nonce);
    } catch {
      throw new SupervisorClientError(
        "supervisor.start_failed",
        "The htmlview supervisor process could not start",
      );
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
    throw new SupervisorClientError(
      "supervisor.start_failed",
      "The htmlview supervisor did not become ready",
    );
  } finally {
    await lock.release();
  }
}

function ownershipLockError(error: unknown): SupervisorClientError {
  return new SupervisorClientError(
    error instanceof Error && error.message.startsWith("Timed out")
      ? "supervisor.unavailable"
      : "state.unavailable",
    error instanceof Error && error.message.startsWith("Timed out")
      ? "The htmlview supervisor is still releasing its control authority"
      : "The htmlview supervisor ownership lock is unavailable",
  );
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
      throw new SupervisorClientError(
        "supervisor.unavailable",
        "The htmlview supervisor is alive but temporarily unavailable",
      );
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
      throw new SupervisorClientError(
        "supervisor.unavailable",
        "The htmlview supervisor is alive but temporarily unavailable",
      );
    if (afterLock.status === "stale") await removeStaleControlSocket(paths);
    return undefined;
  } finally {
    await lock.release();
  }
}

function controlError(value: unknown, fallback: string): SupervisorClientError {
  if (typeof value === "object" && value !== null) {
    const candidate = value as ControlError;
    if (
      typeof candidate.error?.code === "string" &&
      typeof candidate.error.message === "string"
    )
      return new SupervisorClientError(
        candidate.error.code,
        candidate.error.message,
      );
  }
  return new SupervisorClientError("supervisor.request_failed", fallback);
}

async function requiredRequest<T>(
  paths: StatePaths,
  method: "GET" | "POST",
  route: string,
  body?: unknown,
): Promise<T> {
  let response: ControlResponse;
  try {
    response = await controlRequest(paths, method, route, body);
  } catch {
    throw new SupervisorClientError(
      "supervisor.unavailable",
      "The htmlview supervisor became unavailable",
    );
  }
  if (response.status < 200 || response.status >= 300)
    throw controlError(
      response.value,
      `Supervisor request failed with HTTP ${response.status}`,
    );
  return response.value as T;
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
  throw new SupervisorClientError(
    "supervisor.unavailable",
    "The htmlview supervisor did not finish shutting down",
  );
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
  ): Promise<SessionSummary[]> {
    await prepareState(this.#paths);
    const identity = await existingSupervisor(this.#paths);
    if (identity === undefined) return [];
    const query =
      fields.length === 0
        ? ""
        : `?fields=${encodeURIComponent(fields.join(","))}`;
    const result = await requiredRequest<SessionListResult>(
      this.#paths,
      "GET",
      `/sessions${query}`,
    );
    return result.sessions;
  }

  async serve(entry: string, root: string): Promise<ServeControlResult> {
    await assertStateOutsideRoot(this.#paths, root);
    await ensureSupervisor(this.#paths, this.#startProcess);
    return requiredRequest<ServeControlResult>(
      this.#paths,
      "POST",
      "/sessions",
      { entry, root },
    );
  }

  async stopSession(session: string): Promise<StopControlResult> {
    await prepareState(this.#paths);
    const identity = await existingSupervisor(this.#paths);
    if (identity === undefined) return { stopped: 0 };
    return requiredRequest<StopControlResult>(this.#paths, "POST", "/stop", {
      session,
    });
  }

  async stopAll(): Promise<StopControlResult> {
    await prepareState(this.#paths);
    const identity = await existingSupervisor(this.#paths, true);
    if (identity === undefined) return { stopped: 0 };
    const result = await requiredRequest<StopControlResult>(
      this.#paths,
      "POST",
      "/shutdown",
      {},
    );
    await waitForShutdown(this.#paths, identity.instanceId);
    return result;
  }
}
