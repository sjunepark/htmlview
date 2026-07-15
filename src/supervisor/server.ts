import { randomBytes, randomUUID } from "node:crypto";
import { chmod, lstat, realpath } from "node:fs/promises";
import {
  createServer,
  request as httpRequest,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { Result } from "effect";
import { ContentListenerError, ControlError, PathError } from "../errors.js";
import {
  resolveServingGrant,
  isWithinRoot,
  type ServingGrant,
} from "../serving/grant.js";
import {
  startStaticServer,
  type StaticSessionServer,
} from "../serving/http.js";
import {
  acquireSupervisorLock,
  ensurePrivateStateDirectory,
  statePaths,
  transferSupervisorLock,
  type SupervisorLock,
  type StatePaths,
} from "./state.js";
import {
  controlHost,
  decodeCreateSessionRequest,
  decodeSessionFieldSelection,
  decodeShutdownRequest,
  decodeStopSessionRequest,
  encodeControlError,
  encodeServeControlResult,
  encodeSessionListResult,
  encodeStopControlResult,
  encodeTargetedStopControlResult,
  encodeSupervisorIdentity,
  makeSupervisorInstanceId,
  maximumControlBodyBytes,
  maximumConcurrentSessions,
  maximumControlResponseBytes,
  supervisorProtocol,
  type CurrentSupervisorIdentity,
  type OptionalSessionField,
  type ServeControlResult,
  type SessionSummary,
  type StopControlResult,
  type SupervisorIdentity,
  type SupervisorSession,
  type TargetedStopControlResult,
} from "./protocol.js";
import { htmlviewVersion } from "../version.js";

const defaultIdleMilliseconds = 30_000;
const defaultShutdownGraceMilliseconds = 2_000;

interface LiveSession {
  readonly summary: SupervisorSession;
  readonly identityKey: string;
  readonly createdAt: string;
  readonly server: StaticSessionServer;
}

type StartSessionServer = (grant: ServingGrant) => Promise<StaticSessionServer>;

export interface RunningSupervisor {
  readonly controlAddress: string;
  readonly identity: SupervisorIdentity;
  readonly paths: StatePaths;
  close(): Promise<void>;
}

function json(response: ServerResponse, status: number, value: unknown): void {
  let body = Buffer.from(JSON.stringify(value));
  if (body.length > maximumControlResponseBytes) {
    status = 500;
    body = Buffer.from(
      JSON.stringify(
        encodeControlError({
          error: {
            code: "control.response_too_large",
            message: "Control response exceeded the supported size",
          },
        }),
      ),
    );
  }
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": String(body.length),
    "x-content-type-options": "nosniff",
    "cache-control": "no-store",
  });
  response.end(body);
}

function authorized(request: IncomingMessage): boolean {
  return request.headers.host === controlHost;
}

type ServerControlError = PathError | ControlError | ContentListenerError;

function invalidControlRequest(): ControlError {
  return new ControlError({
    code: "control.invalid_request",
    message: "Invalid control request",
  });
}

function isServerControlError(error: unknown): error is ServerControlError {
  return (
    error instanceof PathError ||
    error instanceof ControlError ||
    error instanceof ContentListenerError
  );
}

function controlStatus(error: ServerControlError): number {
  switch (error._tag) {
    case "PathError":
      return 400;
    case "ContentListenerError":
      return 500;
    case "ControlError":
      switch (error.code) {
        case "control.unauthorized":
          return 401;
        case "control.body_too_large":
          return 413;
        case "control.session_limit":
          return 409;
        case "control.shutting_down":
          return 503;
        case "control.not_found":
          return 404;
        case "control.response_too_large":
        case "control.internal":
          return 500;
        case "control.invalid_json":
        case "control.invalid_request":
          return 400;
      }
  }
}

function encodedControlError(error: ServerControlError): unknown {
  return encodeControlError({
    error: { code: error.code, message: error.message },
  });
}

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  const declared = Number(request.headers["content-length"] ?? 0);
  if (Number.isFinite(declared) && declared > maximumControlBodyBytes)
    throw new ControlError({
      code: "control.body_too_large",
      message: "Invalid control request",
    });
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk)
      ? chunk
      : Buffer.from(chunk as Uint8Array);
    size += buffer.length;
    if (size > maximumControlBodyBytes)
      throw new ControlError({
        code: "control.body_too_large",
        message: "Invalid control request",
      });
    chunks.push(buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new ControlError({
      code: "control.invalid_json",
      message: "Invalid control request",
    });
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

  constructor(
    private readonly startServer: StartSessionServer,
    private readonly maximumSessions: number,
  ) {}

  list(fields: readonly OptionalSessionField[]): SessionSummary[] {
    return [...this.#sessions.values()]
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
      .map(({ summary }) => ({
        id: summary.id,
        status: summary.status,
        url: summary.url,
        ...(fields.includes("entry") ? { entry: summary.entry } : {}),
        ...(fields.includes("root") ? { root: summary.root } : {}),
      }));
  }

  async serve(grant: ServingGrant): Promise<ServeControlResult> {
    return this.#mutate(async () => {
      if (this.#closing)
        throw new ControlError({
          code: "control.shutting_down",
          message: "Invalid control request",
        });
      const key = `${grant.routeEntry}\0${grant.root}`;
      const existingId = this.#identity.get(key);
      if (existingId !== undefined) {
        const existing = this.#sessions.get(existingId);
        if (existing !== undefined)
          return { session: existing.summary, reused: true };
      }
      if (this.#sessions.size >= this.maximumSessions)
        throw new ControlError({
          code: "control.session_limit",
          message: `Concurrent session limit of ${this.maximumSessions} reached`,
        });
      const live = await this.#create(grant, key);
      return { session: live.summary, reused: false };
    });
  }

  async #create(grant: ServingGrant, key: string): Promise<LiveSession> {
    let server: StaticSessionServer;
    try {
      server = await this.startServer(grant);
    } catch (error) {
      throw new ContentListenerError({
        code: "http.start_failed",
        message: "The loopback content listener could not start",
        cause: error,
      });
    }
    try {
      await verifyReady(server, grant.entryUrlPath);
    } catch (error) {
      await server.close().catch(() => undefined);
      throw new ContentListenerError({
        code: "http.readiness_failed",
        message: "The content listener did not become ready",
        cause: error,
      });
    }
    let id: string;
    do id = randomBytes(6).toString("base64url");
    while (this.#sessions.has(id));
    const summary: SupervisorSession = {
      id,
      status: "ready",
      url: server.url,
      entry: grant.routeEntry,
      root: grant.root,
    };
    const live = {
      summary,
      identityKey: key,
      createdAt: new Date().toISOString(),
      server,
    };
    this.#sessions.set(id, live);
    this.#identity.set(key, id);
    return live;
  }

  async stop(sessionId: string): Promise<TargetedStopControlResult> {
    return this.#mutate(async () => {
      const live = this.#sessions.get(sessionId);
      if (live === undefined) return { stopped: 0 };
      this.#sessions.delete(sessionId);
      this.#identity.delete(live.identityKey);
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
    readonly maximumSessions?: number;
    readonly beforeHealth?: () => Promise<void>;
    readonly ownershipNonce?: string;
  } = {},
): Promise<RunningSupervisor> {
  const paths = options.paths ?? statePaths();
  await ensurePrivateStateDirectory(paths);
  const instanceId = randomUUID();
  const sessions = new SessionRegistry(
    options.startSessionServer ?? ((grant) => startStaticServer(grant)),
    options.maximumSessions ?? maximumConcurrentSessions,
  );
  const resolveGrantBase = options.resolveGrant ?? resolveServingGrant;
  const canonicalStateDirectory = await realpath(paths.directory);
  const resolveGrant: typeof resolveServingGrant = async (...arguments_) => {
    const grant = await resolveGrantBase(...arguments_);
    if (
      grant.root === canonicalStateDirectory ||
      isWithinRoot(grant.root, canonicalStateDirectory)
    )
      throw new PathError({
        code: "path.root_contains_state",
        message:
          "Serving root cannot contain the htmlview runtime state directory",
      });
    return grant;
  };
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
  const identity: CurrentSupervisorIdentity = {
    protocol: supervisorProtocol,
    instanceId: makeSupervisorInstanceId(instanceId),
    pid: process.pid,
    version: options.version ?? htmlviewVersion,
  };

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
    if (!authorized(request)) {
      const error = new ControlError({
        code: "control.unauthorized",
        message: "Control authentication failed",
      });
      json(response, controlStatus(error), encodedControlError(error));
      return;
    }
    if (closing) {
      const error = new ControlError({
        code: "control.shutting_down",
        message: "Supervisor is shutting down",
      });
      json(response, controlStatus(error), encodedControlError(error));
      return;
    }
    activeHandlers += 1;
    cancelIdleShutdown();
    try {
      const requestUrl = new URL(request.url ?? "/", `http://${controlHost}`);
      if (
        request.method === "GET" &&
        requestUrl.pathname === "/health" &&
        requestUrl.search === ""
      ) {
        await options.beforeHealth?.();
        json(response, 200, encodeSupervisorIdentity(identity));
      } else if (
        request.method === "GET" &&
        requestUrl.pathname === "/sessions"
      ) {
        if ([...requestUrl.searchParams.keys()].some((key) => key !== "fields"))
          throw invalidControlRequest();
        const values = requestUrl.searchParams.getAll("fields");
        if (values.length > 1) throw invalidControlRequest();
        const requestedFields =
          values.length === 0 || values[0] === ""
            ? []
            : (values[0]?.split(",") ?? []);
        const fields = decodeSessionFieldSelection(requestedFields);
        if (Result.isFailure(fields)) throw invalidControlRequest();
        json(
          response,
          200,
          encodeSessionListResult({
            sessions: sessions.list(fields.success),
          }),
        );
      } else if (
        request.method === "POST" &&
        requestUrl.pathname === "/sessions" &&
        requestUrl.search === ""
      ) {
        const body = decodeCreateSessionRequest(await readJsonBody(request));
        if (Result.isFailure(body)) throw invalidControlRequest();
        const grant = await resolveGrant(body.success.entry, {
          root: body.success.root,
        });
        json(
          response,
          200,
          encodeServeControlResult(await sessions.serve(grant)),
        );
      } else if (
        request.method === "POST" &&
        requestUrl.pathname === "/stop" &&
        requestUrl.search === ""
      ) {
        const body = decodeStopSessionRequest(await readJsonBody(request));
        if (Result.isFailure(body)) throw invalidControlRequest();
        json(
          response,
          200,
          encodeTargetedStopControlResult(
            await sessions.stop(body.success.session),
          ),
        );
      } else if (
        request.method === "POST" &&
        requestUrl.pathname === "/shutdown" &&
        requestUrl.search === ""
      ) {
        const body = decodeShutdownRequest(await readJsonBody(request));
        if (Result.isFailure(body)) throw invalidControlRequest();
        closing = true;
        sessions.beginShutdown();
        cancelIdleShutdown();
        response.once("finish", () => setImmediate(() => void close()));
        json(response, 200, encodeStopControlResult(await sessions.stopAll()));
      } else {
        const error = new ControlError({
          code: "control.not_found",
          message: "Control route not found",
        });
        json(response, controlStatus(error), encodedControlError(error));
      }
    } catch (error) {
      const exposed = isServerControlError(error)
        ? error
        : new ControlError({
            code: "control.internal",
            message: "Supervisor could not complete the request",
          });
      json(response, controlStatus(exposed), encodedControlError(exposed));
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

  const bootstrapLock =
    options.ownershipNonce === undefined
      ? await acquireSupervisorLock(paths)
      : undefined;
  let ownership: SupervisorLock;
  try {
    ownership = await transferSupervisorLock(
      paths,
      options.ownershipNonce ?? bootstrapLock?.nonce ?? "",
      identity,
    );
  } catch (error) {
    await bootstrapLock?.release();
    throw error;
  }

  await new Promise<void>((resolve, reject) => {
    control.once("error", reject);
    control.listen(paths.controlSocket, resolve);
  }).catch(async (error: unknown) => {
    await ownership.release();
    throw error;
  });
  try {
    await chmod(paths.controlSocket, 0o600);
    const socketMetadata = await lstat(paths.controlSocket);
    if (
      !socketMetadata.isSocket() ||
      (process.getuid !== undefined && socketMetadata.uid !== process.getuid())
    )
      throw new Error("The htmlview control socket is not privately owned");
  } catch (error) {
    await closeServer(control);
    await ownership.release();
    throw error;
  }

  function close(): Promise<void> {
    closePromise ??= (async () => {
      closing = true;
      sessions.beginShutdown();
      cancelIdleShutdown();
      await sessions.stopAll();
      await closeServer(control, shutdownGraceMilliseconds);
      await ownership.release();
    })();
    return closePromise;
  }

  scheduleIdleShutdown();

  return { controlAddress: paths.controlSocket, identity, paths, close };
}
