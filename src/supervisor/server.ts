import { randomBytes, randomUUID } from "node:crypto";
import { chmod, lstat, realpath } from "node:fs/promises";
import {
  createServer,
  request as httpRequest,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import {
  Cause,
  Clock,
  Data,
  Effect,
  Exit,
  FiberSet,
  Result,
  Scope,
  Semaphore,
} from "effect";
import type { Fiber as EffectFiber } from "effect/Fiber";
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
  readonly scope: Scope.Closeable;
}

type StartSessionServer = (
  grant: ServingGrant,
) => Effect.Effect<StaticSessionServer, ContentListenerError, Scope.Scope>;

type IdleRuntime = (effect: Effect.Effect<void>) => EffectFiber<void, never>;

class ControlListenError extends Data.TaggedError("ControlListenError")<{
  readonly cause: unknown;
}> {}

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

function readJsonBody(
  request: IncomingMessage,
): Effect.Effect<unknown, ControlError> {
  const declared = Number(request.headers["content-length"] ?? 0);
  if (Number.isFinite(declared) && declared > maximumControlBodyBytes)
    return Effect.fail(
      new ControlError({
        code: "control.body_too_large",
        message: "Invalid control request",
      }),
    );
  return Effect.callback<unknown, ControlError>((resume) => {
    const chunks: Buffer[] = [];
    let size = 0;
    const cleanup = (): void => {
      request.off("data", onData);
      request.off("end", onEnd);
      request.off("error", onError);
    };
    const fail = (error: ControlError): void => {
      cleanup();
      request.resume();
      resume(Effect.fail(error));
    };
    const onData = (chunk: Buffer | Uint8Array): void => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += buffer.length;
      if (size > maximumControlBodyBytes) {
        fail(
          new ControlError({
            code: "control.body_too_large",
            message: "Invalid control request",
          }),
        );
        return;
      }
      chunks.push(buffer);
    };
    const onEnd = (): void => {
      cleanup();
      try {
        resume(
          Effect.succeed(JSON.parse(Buffer.concat(chunks).toString("utf8"))),
        );
      } catch {
        resume(
          Effect.fail(
            new ControlError({
              code: "control.invalid_json",
              message: "Invalid control request",
            }),
          ),
        );
      }
    };
    const onError = (cause: Error): void => {
      cleanup();
      resume(Effect.die(cause));
    };
    request.on("data", onData);
    request.once("end", onEnd);
    request.once("error", onError);
    return Effect.sync(() => {
      cleanup();
      request.destroy();
    });
  });
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
      if (
        error === undefined ||
        (error as NodeJS.ErrnoException).code === "ERR_SERVER_NOT_RUNNING"
      )
        resolve();
      else reject(error);
    });
    server.closeIdleConnections();
  });
}

function listenControlServer(
  server: Server,
  address: string,
): Effect.Effect<void, ControlListenError> {
  return Effect.callback<void, ControlListenError>((resume) => {
    const onError = (cause: Error): void =>
      resume(Effect.fail(new ControlListenError({ cause })));
    server.once("error", onError);
    try {
      server.listen(address, () => {
        server.off("error", onError);
        resume(Effect.void);
      });
    } catch (error) {
      server.off("error", onError);
      resume(Effect.fail(new ControlListenError({ cause: error })));
    }
    return Effect.sync(() => server.off("error", onError));
  });
}

function verifyReady(
  session: StaticSessionServer,
  entryUrlPath: string,
): Effect.Effect<void, ContentListenerError> {
  return Effect.callback<void, ContentListenerError>((resume) => {
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
        if (response.statusCode === 200) resume(Effect.void);
        else
          resume(
            Effect.fail(
              new ContentListenerError({
                code: "http.readiness_failed",
                message: "The content listener did not become ready",
                cause: new Error(
                  `Content readiness returned HTTP ${response.statusCode ?? 0}`,
                ),
              }),
            ),
          );
      },
    );
    operation.once("timeout", () =>
      operation.destroy(new Error("Content readiness timed out")),
    );
    operation.once("error", (cause) =>
      resume(
        Effect.fail(
          new ContentListenerError({
            code: "http.readiness_failed",
            message: "The content listener did not become ready",
            cause,
          }),
        ),
      ),
    );
    operation.end();
    return Effect.sync(() => operation.destroy());
  });
}

class SessionRegistry {
  readonly #sessions = new Map<string, LiveSession>();
  readonly #identity = new Map<string, string>();
  readonly #mutations = Semaphore.makeUnsafe(1);
  readonly #scope = Scope.makeUnsafe("parallel");
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

  serve(
    grant: ServingGrant,
  ): Effect.Effect<ServeControlResult, ControlError | ContentListenerError> {
    return this.#mutations.withPermit(
      Effect.gen({ self: this }, function* () {
        if (this.#closing)
          return yield* new ControlError({
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
          return yield* new ControlError({
            code: "control.session_limit",
            message: `Concurrent session limit of ${this.maximumSessions} reached`,
          });
        const live = yield* this.#create(grant, key);
        return { session: live.summary, reused: false };
      }),
    );
  }

  #create(
    grant: ServingGrant,
    key: string,
  ): Effect.Effect<LiveSession, ContentListenerError> {
    return Effect.gen({ self: this }, function* () {
      const scope = yield* Scope.fork(this.#scope, "parallel");
      const create = Effect.gen({ self: this }, function* () {
        const server = yield* Scope.provide(scope)(this.startServer(grant));
        yield* verifyReady(server, grant.entryUrlPath);
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
          createdAt: new Date(yield* Clock.currentTimeMillis).toISOString(),
          scope,
        };
        this.#sessions.set(id, live);
        this.#identity.set(key, id);
        return live;
      });
      return yield* create.pipe(
        Effect.onExit((exit) =>
          Exit.isSuccess(exit) ? Effect.void : Scope.close(scope, exit),
        ),
      );
    });
  }

  stop(sessionId: string): Effect.Effect<TargetedStopControlResult> {
    return this.#mutations.withPermit(
      Effect.gen({ self: this }, function* () {
        const live = this.#sessions.get(sessionId);
        if (live === undefined) return { stopped: 0 };
        this.#sessions.delete(sessionId);
        this.#identity.delete(live.identityKey);
        yield* Scope.close(live.scope, Exit.void);
        return { stopped: 1 };
      }),
    );
  }

  stopAll(): Effect.Effect<StopControlResult> {
    return Effect.gen({ self: this }, function* () {
      this.#closing = true;
      yield* Scope.close(this.#scope, Exit.void);
      return yield* this.#mutations.withPermit(
        Effect.sync(() => {
          const stopped = this.#sessions.size;
          this.#sessions.clear();
          this.#identity.clear();
          return { stopped };
        }),
      );
    });
  }

  get size(): number {
    return this.#sessions.size;
  }

  beginShutdown(): void {
    this.#closing = true;
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
    readonly idleRuntime?: IdleRuntime;
    readonly deferIdleClose?: (close: () => void) => void;
  } = {},
): Promise<RunningSupervisor> {
  const paths = options.paths ?? statePaths();
  await Effect.runPromise(ensurePrivateStateDirectory(paths));
  const instanceId = randomUUID();
  const sessions = new SessionRegistry(
    options.startSessionServer ?? startStaticServer,
    options.maximumSessions ?? maximumConcurrentSessions,
  );
  const resolveGrantBase = options.resolveGrant ?? resolveServingGrant;
  const canonicalStateDirectory = await realpath(paths.directory);
  const resolveGrant: typeof resolveServingGrant = (...arguments_) =>
    Effect.gen(function* () {
      const grant = yield* resolveGrantBase(...arguments_);
      if (
        grant.root === canonicalStateDirectory ||
        isWithinRoot(grant.root, canonicalStateDirectory)
      )
        return yield* new PathError({
          code: "path.root_contains_state",
          message:
            "Serving root cannot contain the htmlview runtime state directory",
        });
      return grant;
    });
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
  let idleScope: Scope.Closeable | undefined;
  let runIdle: IdleRuntime;
  if (options.idleRuntime !== undefined) runIdle = options.idleRuntime;
  else {
    idleScope = await Effect.runPromise(Scope.make());
    runIdle = await Effect.runPromise(
      Scope.provide(idleScope)(FiberSet.makeRuntime<never, void, never>()),
    );
  }
  let idleFiber: EffectFiber<void, never> | undefined;
  let idleGeneration = 0;
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
    idleGeneration += 1;
    idleFiber?.interruptUnsafe();
    idleFiber = undefined;
  }

  async function closeIdleScope(): Promise<void> {
    if (idleScope !== undefined)
      await Effect.runPromise(Scope.close(idleScope, Exit.void));
  }

  function scheduleIdleShutdown(): void {
    cancelIdleShutdown();
    if (closing || activeHandlers !== 0 || sessions.size !== 0) return;
    const generation = idleGeneration;
    idleFiber = runIdle(
      Effect.sleep(idleMilliseconds).pipe(
        Effect.andThen(
          Effect.sync(() => {
            if (
              generation !== idleGeneration ||
              closing ||
              activeHandlers !== 0 ||
              sessions.size !== 0
            )
              return;
            idleFiber = undefined;
            (options.deferIdleClose ?? setImmediate)(() => {
              if (
                generation === idleGeneration &&
                !closing &&
                activeHandlers === 0 &&
                sessions.size === 0
              )
                void close();
            });
          }),
        ),
      ),
    );
  }

  function routeControlRequest(
    request: IncomingMessage,
    response: ServerResponse,
  ): Effect.Effect<void, ServerControlError> {
    return Effect.gen(function* () {
      const requestUrl = new URL(request.url ?? "/", `http://${controlHost}`);
      if (
        request.method === "GET" &&
        requestUrl.pathname === "/health" &&
        requestUrl.search === ""
      ) {
        if (options.beforeHealth !== undefined)
          yield* Effect.tryPromise({
            try: options.beforeHealth,
            catch: (cause) =>
              new ControlError({
                code: "control.internal",
                message: "Supervisor could not complete the request",
                cause,
              }),
          });
        return yield* Effect.sync(() =>
          json(response, 200, encodeSupervisorIdentity(identity)),
        );
      }
      if (request.method === "GET" && requestUrl.pathname === "/sessions") {
        if ([...requestUrl.searchParams.keys()].some((key) => key !== "fields"))
          return yield* invalidControlRequest();
        const values = requestUrl.searchParams.getAll("fields");
        if (values.length > 1) return yield* invalidControlRequest();
        const requestedFields =
          values.length === 0 || values[0] === ""
            ? []
            : (values[0]?.split(",") ?? []);
        const fields = decodeSessionFieldSelection(requestedFields);
        if (Result.isFailure(fields)) return yield* invalidControlRequest();
        return yield* Effect.sync(() =>
          json(
            response,
            200,
            encodeSessionListResult({
              sessions: sessions.list(fields.success),
            }),
          ),
        );
      }
      if (
        request.method === "POST" &&
        requestUrl.pathname === "/sessions" &&
        requestUrl.search === ""
      ) {
        const body = decodeCreateSessionRequest(yield* readJsonBody(request));
        if (Result.isFailure(body)) return yield* invalidControlRequest();
        const grant = yield* resolveGrant(body.success.entry, {
          root: body.success.root,
        });
        const result = yield* sessions.serve(grant);
        return yield* Effect.sync(() =>
          json(response, 200, encodeServeControlResult(result)),
        );
      }
      if (
        request.method === "POST" &&
        requestUrl.pathname === "/stop" &&
        requestUrl.search === ""
      ) {
        const body = decodeStopSessionRequest(yield* readJsonBody(request));
        if (Result.isFailure(body)) return yield* invalidControlRequest();
        const result = yield* sessions.stop(body.success.session);
        return yield* Effect.sync(() =>
          json(response, 200, encodeTargetedStopControlResult(result)),
        );
      }
      if (
        request.method === "POST" &&
        requestUrl.pathname === "/shutdown" &&
        requestUrl.search === ""
      ) {
        const body = decodeShutdownRequest(yield* readJsonBody(request));
        if (Result.isFailure(body)) return yield* invalidControlRequest();
        closing = true;
        sessions.beginShutdown();
        cancelIdleShutdown();
        response.once("finish", () => setImmediate(() => void close()));
        const result = yield* sessions.stopAll();
        return yield* Effect.sync(() =>
          json(response, 200, encodeStopControlResult(result)),
        );
      }
      return yield* new ControlError({
        code: "control.not_found",
        message: "Control route not found",
      });
    });
  }

  function handleControlRequest(
    request: IncomingMessage,
    response: ServerResponse,
  ): Effect.Effect<void> {
    if (!authorized(request)) {
      const error = new ControlError({
        code: "control.unauthorized",
        message: "Control authentication failed",
      });
      return Effect.sync(() =>
        json(response, controlStatus(error), encodedControlError(error)),
      );
    }
    if (closing) {
      const error = new ControlError({
        code: "control.shutting_down",
        message: "Supervisor is shutting down",
      });
      return Effect.sync(() =>
        json(response, controlStatus(error), encodedControlError(error)),
      );
    }
    return Effect.acquireUseRelease(
      Effect.sync(() => {
        activeHandlers += 1;
        cancelIdleShutdown();
      }),
      () => routeControlRequest(request, response),
      () =>
        Effect.sync(() => {
          activeHandlers -= 1;
          scheduleIdleShutdown();
        }),
    ).pipe(
      Effect.catch((error) =>
        Effect.sync(() =>
          json(response, controlStatus(error), encodedControlError(error)),
        ),
      ),
      Effect.catchCause((cause) =>
        Effect.sync(() => {
          if (response.destroyed) return;
          if (Cause.hasInterruptsOnly(cause)) response.destroy();
          else {
            const error = new ControlError({
              code: "control.internal",
              message: "Supervisor could not complete the request",
            });
            json(response, controlStatus(error), encodedControlError(error));
          }
        }),
      ),
    );
  }

  const controlScope = await Effect.runPromise(Scope.make());
  const runControlRequest = await Effect.runPromise(
    Scope.provide(controlScope)(FiberSet.makeRuntime<never, void, never>()),
  );
  const control = createServer((request, response) => {
    runControlRequest(handleControlRequest(request, response));
  });
  control.maxConnections = 25;
  control.maxHeadersCount = 50;
  control.maxRequestsPerSocket = 100;
  control.headersTimeout = 5_000;
  control.requestTimeout = 10_000;
  control.keepAliveTimeout = 2_000;
  control.setTimeout(10_000, (socket) => socket.destroy());
  await Effect.runPromise(
    Scope.provide(controlScope)(
      Effect.addFinalizer(() =>
        Effect.promise(() => closeServer(control, shutdownGraceMilliseconds)),
      ),
    ),
  );

  async function cleanupStartupResources(
    ownership?: Scope.Closeable,
  ): Promise<unknown[]> {
    const failures: unknown[] = [];
    const cleanupOperations: Array<() => Promise<void>> = [
      closeIdleScope,
      () => Effect.runPromise(Scope.close(controlScope, Exit.void)),
    ];
    if (ownership !== undefined)
      cleanupOperations.push(() =>
        Effect.runPromise(Scope.close(ownership, Exit.void)),
      );
    for (const cleanup of cleanupOperations) {
      try {
        await cleanup();
      } catch (error) {
        failures.push(error);
      }
    }
    return failures;
  }

  function startupFailure(
    error: unknown,
    cleanupFailures: readonly unknown[],
  ): unknown {
    return cleanupFailures.length === 0
      ? error
      : new AggregateError(
          [error, ...cleanupFailures],
          "Supervisor startup cleanup failed",
        );
  }

  let bootstrapScope: Scope.Closeable | undefined;
  let bootstrapLock: SupervisorLock | undefined;
  let ownershipScope: Scope.Closeable;
  try {
    if (options.ownershipNonce === undefined) {
      bootstrapScope = await Effect.runPromise(Scope.make());
      bootstrapLock = await Effect.runPromise(
        Scope.provide(bootstrapScope)(acquireSupervisorLock(paths)),
      );
    }
    const candidateScope = await Effect.runPromise(Scope.make());
    try {
      await Effect.runPromise(
        Scope.provide(candidateScope)(
          transferSupervisorLock(
            paths,
            options.ownershipNonce ?? bootstrapLock?.nonce ?? "",
            identity,
          ),
        ),
      );
      ownershipScope = candidateScope;
    } catch (error) {
      await Effect.runPromise(Scope.close(candidateScope, Exit.void));
      throw error;
    }
  } catch (error) {
    throw startupFailure(error, await cleanupStartupResources());
  } finally {
    if (bootstrapScope !== undefined)
      await Effect.runPromise(Scope.close(bootstrapScope, Exit.void));
  }

  await Effect.runPromise(
    listenControlServer(control, paths.controlSocket),
  ).catch(async (error: unknown) => {
    throw startupFailure(error, await cleanupStartupResources(ownershipScope));
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
    throw startupFailure(error, await cleanupStartupResources(ownershipScope));
  }

  function close(): Promise<void> {
    closePromise ??= (async () => {
      closing = true;
      sessions.beginShutdown();
      cancelIdleShutdown();
      const failures: unknown[] = [];
      try {
        await closeIdleScope();
      } catch (error) {
        failures.push(error);
      }
      try {
        await Effect.runPromise(sessions.stopAll());
      } catch (error) {
        failures.push(error);
      }
      try {
        await Effect.runPromise(Scope.close(controlScope, Exit.void));
      } catch (error) {
        failures.push(error);
      }
      try {
        await Effect.runPromise(Scope.close(ownershipScope, Exit.void));
      } catch (error) {
        failures.push(error);
      }
      if (failures.length === 1) throw failures[0];
      if (failures.length > 1)
        throw new AggregateError(failures, "Supervisor shutdown failed");
    })();
    return closePromise;
  }

  scheduleIdleShutdown();

  return { controlAddress: paths.controlSocket, identity, paths, close };
}
