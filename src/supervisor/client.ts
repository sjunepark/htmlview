import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { request as httpRequest } from "node:http";
import {
  acquireStartupLock,
  ensurePrivateStateDirectory,
  readDiscovery,
  removeDiscovery,
  statePaths,
  type StatePaths,
} from "./state.js";
import {
  supervisorProtocol,
  type ControlError,
  type DiscoveryRecord,
  type ServeControlResult,
  type StopControlResult,
  type SupervisorSession,
} from "./protocol.js";

const maximumControlResponseBytes = 256 * 1024;

export class SupervisorClientError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "SupervisorClientError";
  }
}

interface ControlResponse {
  readonly status: number;
  readonly value: unknown;
}

function controlRequest(
  discovery: DiscoveryRecord,
  method: "GET" | "POST",
  route: string,
  body?: unknown,
): Promise<ControlResponse> {
  return new Promise((resolve, reject) => {
    const payload =
      body === undefined ? undefined : Buffer.from(JSON.stringify(body));
    const operation = httpRequest(
      {
        hostname: "127.0.0.1",
        port: discovery.port,
        method,
        path: route,
        headers: {
          host: `127.0.0.1:${discovery.port}`,
          authorization: `Bearer ${discovery.token}`,
          ...(payload === undefined
            ? {}
            : {
                "content-type": "application/json",
                "content-length": String(payload.length),
              }),
        },
        timeout: 2_000,
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

async function healthy(record: DiscoveryRecord): Promise<boolean> {
  try {
    const response = await controlRequest(record, "GET", "/health");
    if (
      response.status !== 200 ||
      typeof response.value !== "object" ||
      response.value === null
    )
      return false;
    const value = response.value as Record<string, unknown>;
    return (
      value.protocol === supervisorProtocol &&
      value.instanceId === record.instanceId &&
      value.pid === record.pid
    );
  } catch {
    return false;
  }
}

async function currentHealthy(
  paths: StatePaths,
): Promise<DiscoveryRecord | undefined> {
  const record = await readDiscovery(paths);
  if (record === undefined) return undefined;
  if (await healthy(record)) return record;
  await removeDiscovery(paths, record.instanceId);
  return undefined;
}

function supervisorEntry(): string {
  return fileURLToPath(new URL("./supervisor-main.js", import.meta.url));
}

async function ensureSupervisor(paths: StatePaths): Promise<DiscoveryRecord> {
  await ensurePrivateStateDirectory(paths);
  const current = await currentHealthy(paths);
  if (current !== undefined) return current;

  const lock = await acquireStartupLock(paths);
  try {
    const afterLock = await currentHealthy(paths);
    if (afterLock !== undefined) return afterLock;
    const child = spawn(process.execPath, [supervisorEntry()], {
      detached: true,
      stdio: "ignore",
      env: { ...process.env, HTMLVIEW_STATE_DIR: paths.directory },
    });
    child.unref();

    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      const started = await currentHealthy(paths);
      if (started !== undefined) return started;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new SupervisorClientError(
      "supervisor.start_failed",
      "The htmlview supervisor did not become ready",
    );
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
    ) {
      return new SupervisorClientError(
        candidate.error.code,
        candidate.error.message,
      );
    }
  }
  return new SupervisorClientError("supervisor.request_failed", fallback);
}

async function requiredRequest<T>(
  discovery: DiscoveryRecord,
  method: "GET" | "POST",
  route: string,
  body?: unknown,
): Promise<T> {
  let response: ControlResponse;
  try {
    response = await controlRequest(discovery, method, route, body);
  } catch {
    throw new SupervisorClientError(
      "supervisor.unavailable",
      "The htmlview supervisor became unavailable",
    );
  }
  if (response.status < 200 || response.status >= 300) {
    throw controlError(
      response.value,
      `Supervisor request failed with HTTP ${response.status}`,
    );
  }
  return response.value as T;
}

export class SupervisorClient {
  readonly #paths: StatePaths;

  constructor(paths: StatePaths = statePaths()) {
    this.#paths = paths;
  }

  async list(): Promise<SupervisorSession[]> {
    await ensurePrivateStateDirectory(this.#paths);
    const discovery = await currentHealthy(this.#paths);
    if (discovery === undefined) return [];
    const result = await requiredRequest<{ sessions: SupervisorSession[] }>(
      discovery,
      "GET",
      "/sessions",
    );
    return result.sessions;
  }

  async serve(entry: string, root: string): Promise<ServeControlResult> {
    const discovery = await ensureSupervisor(this.#paths);
    return requiredRequest<ServeControlResult>(discovery, "POST", "/sessions", {
      entry,
      root,
    });
  }

  async stop(session?: string, all = false): Promise<StopControlResult> {
    await ensurePrivateStateDirectory(this.#paths);
    const discovery = await currentHealthy(this.#paths);
    if (discovery === undefined) return { stopped: 0 };
    return requiredRequest<StopControlResult>(
      discovery,
      "POST",
      "/stop",
      all ? { all: true } : { session },
    );
  }
}
