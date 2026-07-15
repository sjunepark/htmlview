import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import {
  createServer,
  request as httpRequest,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import {
  resolveServingGrant,
  GrantError,
  type ServingGrant,
} from "../serving/grant.js";
import {
  startStaticServer,
  type StaticSessionServer,
} from "../serving/http.js";
import {
  ensurePrivateStateDirectory,
  removeDiscovery,
  statePaths,
  writePrivateJson,
  type StatePaths,
} from "./state.js";
import {
  supervisorProtocol,
  type DiscoveryRecord,
  type ServeControlResult,
  type StopControlResult,
  type SupervisorSession,
} from "./protocol.js";
import { htmlviewVersion } from "../version.js";

const maximumControlBodyBytes = 64 * 1024;
const defaultIdleMilliseconds = 30_000;
const defaultShutdownGraceMilliseconds = 2_000;

interface LiveSession {
  readonly summary: SupervisorSession;
  readonly server: StaticSessionServer;
}

type StartSessionServer = (grant: ServingGrant) => Promise<StaticSessionServer>;

export interface RunningSupervisor {
  readonly controlAddress: "127.0.0.1";
  readonly discovery: DiscoveryRecord;
  readonly paths: StatePaths;
  close(): Promise<void>;
}

function json(response: ServerResponse, status: number, value: unknown): void {
  const body = Buffer.from(JSON.stringify(value));
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": String(body.length),
    "x-content-type-options": "nosniff",
    "cache-control": "no-store",
  });
  response.end(body);
}

function authorized(
  request: IncomingMessage,
  token: string,
  port: number,
): boolean {
  const supplied = request.headers.authorization?.replace(/^Bearer /, "") ?? "";
  const expectedBuffer = Buffer.from(token);
  const suppliedBuffer = Buffer.from(supplied);
  return (
    request.headers.host === `127.0.0.1:${port}` &&
    expectedBuffer.length === suppliedBuffer.length &&
    timingSafeEqual(expectedBuffer, suppliedBuffer)
  );
}

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  const declared = Number(request.headers["content-length"] ?? 0);
  if (Number.isFinite(declared) && declared > maximumControlBodyBytes)
    throw new Error("control.body_too_large");
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk)
      ? chunk
      : Buffer.from(chunk as Uint8Array);
    size += buffer.length;
    if (size > maximumControlBodyBytes)
      throw new Error("control.body_too_large");
    chunks.push(buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new Error("control.invalid_json");
  }
}

function closeServer(
  server: Server,
  graceMilliseconds = defaultShutdownGraceMilliseconds,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const force = setTimeout(
      () => server.closeAllConnections(),
      graceMilliseconds,
    );
    force.unref();
    server.close((error) => {
      clearTimeout(force);
      if (error === undefined) resolve();
      else reject(error);
    });
    server.closeIdleConnections();
  });
}

function verifyReady(
  session: StaticSessionServer,
  entryUrlPath: string,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const operation = httpRequest(
      {
        hostname: "127.0.0.1",
        port: session.port,
        method: "HEAD",
        path: entryUrlPath,
        headers: { host: `${session.hostname}:${session.port}` },
        timeout: 2_000,
      },
      (response) => {
        response.resume();
        if (response.statusCode === 200) resolve();
        else
          reject(
            new Error(
              `Content readiness returned HTTP ${response.statusCode ?? 0}`,
            ),
          );
      },
    );
    operation.once("timeout", () =>
      operation.destroy(new Error("Content readiness timed out")),
    );
    operation.once("error", reject);
    operation.end();
  });
}

class SessionRegistry {
  readonly #sessions = new Map<string, LiveSession>();
  readonly #identity = new Map<string, string>();
  #mutationTail: Promise<void> = Promise.resolve();
  #closing = false;

  constructor(private readonly startServer: StartSessionServer) {}

  list(): SupervisorSession[] {
    return [...this.#sessions.values()]
      .map(({ summary }) => summary)
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  }

  async serve(grant: ServingGrant): Promise<ServeControlResult> {
    return this.#mutate(async () => {
      if (this.#closing) throw new Error("control.shutting_down");
      const key = `${grant.entry}\0${grant.root}`;
      const existingId = this.#identity.get(key);
      if (existingId !== undefined) {
        const existing = this.#sessions.get(existingId);
        if (existing !== undefined)
          return { session: existing.summary, reused: true };
      }
      const live = await this.#create(grant, key);
      return { session: live.summary, reused: false };
    });
  }

  async #create(grant: ServingGrant, key: string): Promise<LiveSession> {
    let server: StaticSessionServer;
    try {
      server = await this.startServer(grant);
    } catch {
      throw new Error("http.start_failed");
    }
    try {
      await verifyReady(server, grant.entryUrlPath);
    } catch (error) {
      await server.close().catch(() => undefined);
      throw new Error("http.readiness_failed", { cause: error });
    }
    let id: string;
    do id = randomBytes(6).toString("base64url");
    while (this.#sessions.has(id));
    const summary: SupervisorSession = {
      id,
      status: "ready",
      url: server.url,
      entry: grant.entry,
      root: grant.root,
      createdAt: new Date().toISOString(),
    };
    const live = { summary, server };
    this.#sessions.set(id, live);
    this.#identity.set(key, id);
    return live;
  }

  async stop(sessionId: string): Promise<StopControlResult> {
    return this.#mutate(async () => {
      const live = this.#sessions.get(sessionId);
      if (live === undefined) return { stopped: 0 };
      this.#sessions.delete(sessionId);
      this.#identity.delete(`${live.summary.entry}\0${live.summary.root}`);
      await live.server.close();
      return { stopped: 1 };
    });
  }

  async stopAll(): Promise<StopControlResult> {
    return this.#mutate(async () => {
      const sessions = [...this.#sessions.values()];
      this.#sessions.clear();
      this.#identity.clear();
      await Promise.all(sessions.map(({ server }) => server.close()));
      return { stopped: sessions.length };
    });
  }

  get size(): number {
    return this.#sessions.size;
  }

  beginShutdown(): void {
    this.#closing = true;
  }

  async #mutate<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.#mutationTail;
    let release = (): void => undefined;
    this.#mutationTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }
}

export async function startSupervisor(
  options: {
    readonly paths?: StatePaths;
    readonly idleMilliseconds?: number;
    readonly shutdownGraceMilliseconds?: number;
    readonly resolveGrant?: typeof resolveServingGrant;
    readonly startSessionServer?: StartSessionServer;
    readonly version?: string;
  } = {},
): Promise<RunningSupervisor> {
  const paths = options.paths ?? statePaths();
  await ensurePrivateStateDirectory(paths);
  const token = randomBytes(32).toString("base64url");
  const instanceId = randomUUID();
  const sessions = new SessionRegistry(
    options.startSessionServer ?? ((grant) => startStaticServer(grant)),
  );
  const resolveGrant = options.resolveGrant ?? resolveServingGrant;
  const requestedIdleMilliseconds =
    options.idleMilliseconds ??
    Number(process.env.HTMLVIEW_IDLE_MS ?? defaultIdleMilliseconds);
  const idleMilliseconds =
    Number.isFinite(requestedIdleMilliseconds) && requestedIdleMilliseconds > 0
      ? requestedIdleMilliseconds
      : defaultIdleMilliseconds;
  const shutdownGraceMilliseconds =
    options.shutdownGraceMilliseconds !== undefined &&
    Number.isFinite(options.shutdownGraceMilliseconds) &&
    options.shutdownGraceMilliseconds > 0
      ? options.shutdownGraceMilliseconds
      : defaultShutdownGraceMilliseconds;
  let idleTimer: NodeJS.Timeout | undefined;
  let activeHandlers = 0;
  let closing = false;
  let closePromise: Promise<void> | undefined;

  function cancelIdleShutdown(): void {
    if (idleTimer === undefined) return;
    clearTimeout(idleTimer);
    idleTimer = undefined;
  }

  function scheduleIdleShutdown(): void {
    cancelIdleShutdown();
    if (closing || activeHandlers !== 0 || sessions.size !== 0) return;
    idleTimer = setTimeout(() => void close(), idleMilliseconds);
    idleTimer.unref();
  }

  const control = createServer(async (request, response) => {
    const address = control.address() as AddressInfo | null;
    if (address === null || !authorized(request, token, address.port)) {
      json(response, 401, {
        error: {
          code: "control.unauthorized",
          message: "Control authentication failed",
        },
      });
      return;
    }
    if (closing) {
      json(response, 503, {
        error: {
          code: "control.shutting_down",
          message: "Supervisor is shutting down",
        },
      });
      return;
    }
    activeHandlers += 1;
    cancelIdleShutdown();
    try {
      if (request.method === "GET" && request.url === "/health") {
        json(response, 200, {
          protocol: supervisorProtocol,
          instanceId,
          pid: process.pid,
        });
      } else if (request.method === "GET" && request.url === "/sessions") {
        json(response, 200, {
          sessions: sessions.list(),
          count: sessions.size,
        });
      } else if (request.method === "POST" && request.url === "/sessions") {
        const body = await readJsonBody(request);
        if (typeof body !== "object" || body === null)
          throw new Error("control.invalid_request");
        const candidate = body as Record<string, unknown>;
        if (
          typeof candidate.entry !== "string" ||
          typeof candidate.root !== "string"
        )
          throw new Error("control.invalid_request");
        const grant = await resolveGrant(candidate.entry, {
          root: candidate.root,
        });
        json(response, 200, await sessions.serve(grant));
      } else if (request.method === "POST" && request.url === "/stop") {
        const body = await readJsonBody(request);
        if (typeof body !== "object" || body === null)
          throw new Error("control.invalid_request");
        const candidate = body as Record<string, unknown>;
        if (candidate.all === true)
          json(response, 200, await sessions.stopAll());
        else if (typeof candidate.session === "string")
          json(response, 200, await sessions.stop(candidate.session));
        else throw new Error("control.invalid_request");
      } else {
        json(response, 404, {
          error: {
            code: "control.not_found",
            message: "Control route not found",
          },
        });
      }
    } catch (error) {
      if (error instanceof GrantError)
        json(response, 400, {
          error: { code: error.code, message: error.message },
        });
      else {
        const message =
          error instanceof Error ? error.message : "control.internal";
        const status =
          message === "control.body_too_large"
            ? 413
            : message === "control.shutting_down"
              ? 503
              : message.startsWith("control.")
                ? 400
                : 500;
        const exposed =
          message.startsWith("control.") || message.startsWith("http.");
        json(response, status, {
          error: {
            code: exposed ? message : "control.internal",
            message: message.startsWith("control.")
              ? "Invalid control request"
              : message === "http.start_failed"
                ? "The loopback content listener could not start"
                : message === "http.readiness_failed"
                  ? "The content listener did not become ready"
                  : "Supervisor could not complete the request",
          },
        });
      }
    } finally {
      activeHandlers -= 1;
      scheduleIdleShutdown();
    }
  });
  control.maxConnections = 25;
  control.maxHeadersCount = 50;
  control.maxRequestsPerSocket = 100;
  control.headersTimeout = 5_000;
  control.requestTimeout = 10_000;
  control.keepAliveTimeout = 2_000;
  control.setTimeout(10_000, (socket) => socket.destroy());

  await new Promise<void>((resolve, reject) => {
    control.once("error", reject);
    control.listen({ host: "127.0.0.1", port: 0 }, resolve);
  });
  const address = control.address() as AddressInfo;
  const discovery: DiscoveryRecord = {
    protocol: supervisorProtocol,
    instanceId,
    pid: process.pid,
    port: address.port,
    token,
    version: options.version ?? htmlviewVersion,
  };
  try {
    await writePrivateJson(paths.discovery, discovery);
  } catch (error) {
    await closeServer(control);
    throw error;
  }

  function close(): Promise<void> {
    closePromise ??= (async () => {
      closing = true;
      sessions.beginShutdown();
      cancelIdleShutdown();
      await closeServer(control, shutdownGraceMilliseconds);
      await sessions.stopAll();
      await removeDiscovery(paths, instanceId);
    })();
    return closePromise;
  }

  scheduleIdleShutdown();

  return { controlAddress: "127.0.0.1", discovery, paths, close };
}
