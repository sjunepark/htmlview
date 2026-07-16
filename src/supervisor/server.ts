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
  Context,
  Data,
  Deferred,
  Effect,
  Exit,
  FiberSet,
  Logger,
  References,
  Result,
  Scope,
  Semaphore,
} from "effect";
import type { Fiber as EffectFiber } from "effect/Fiber";
import { logDiagnostic } from "../diagnostics.js";
import {
  ContentListenerError,
  ControlError,
  PathError,
  ReviewError,
} from "../errors.js";
import {
  canonicalTreesOverlap,
  resolveServingGrant,
  type ServingGrant,
} from "../serving/grant.js";
import {
  startStaticServer,
  type StaticSessionServer,
} from "../serving/http.js";
import {
  startReviewOriginServer,
  type ReviewOriginRole,
  type ReviewOriginServer,
} from "../serving/review.js";
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
  decodeCreateReviewRequest,
  decodeCreateSessionRequest,
  decodeSessionFieldSelection,
  decodeShutdownRequest,
  decodeStopSessionRequest,
  encodeControlError,
  encodeReviewControlResult,
  encodeServeControlResult,
  encodeSessionListResult,
  encodeSupervisorStateResult,
  encodeStopControlResult,
  encodeTargetedStopControlResult,
  encodeSupervisorIdentity,
  makeSupervisorInstanceId,
  maximumControlBodyBytes,
  maximumConcurrentSessions,
  maximumControlResponseBytes,
  maximumRetainedReviews,
  supervisorProtocol,
  type CurrentSupervisorIdentity,
  type OptionalSessionField,
  type ReviewControlResult,
  type ReviewStatus,
  type ReviewSummary,
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
const reviewOriginReadyTimeoutMilliseconds = 2_000;

export function generateSessionId(
  random: (size: number) => Buffer = randomBytes,
): string {
  let id: string;
  do id = random(6).toString("base64url");
  while (id.startsWith("-"));
  return id;
}

export function generateReviewId(
  random: (size: number) => Buffer = randomBytes,
): string {
  return `rv_${random(16).toString("base64url")}`;
}

interface LiveSession {
  readonly summary: SupervisorSession;
  readonly grant: ServingGrant;
  readonly identityKey: string;
  readonly createdAt: string;
  readonly scope: Scope.Closeable;
}

interface LiveReview {
  readonly scope: Scope.Closeable;
  readonly shell: ReviewOriginServer;
  readonly content: ReviewOriginServer;
}

interface ReviewRecord {
  readonly id: string;
  readonly identityKey: string;
  readonly createdAt: string;
  status: ReviewStatus;
  session: string;
  drafts: number;
  unacknowledged: number;
  live: LiveReview | undefined;
}

type StartSessionServer = (
  grant: ServingGrant,
) => Effect.Effect<StaticSessionServer, ContentListenerError, Scope.Scope>;

type StartReviewOriginServer = (
  role: ReviewOriginRole,
) => Effect.Effect<ReviewOriginServer, ContentListenerError, Scope.Scope>;

type IdleRuntime = (effect: Effect.Effect<void>) => EffectFiber<void, never>;

class ControlListenError extends Data.TaggedError("ControlListenError")<{
  readonly cause: unknown;
}> {}

export interface RunningSupervisor {
  readonly close: Effect.Effect<void, SupervisorLifecycleError>;
  readonly closed: Effect.Effect<void, SupervisorLifecycleError>;
  readonly identity: SupervisorIdentity;
  readonly paths: StatePaths;
}

export class SupervisorLifecycleError extends Data.TaggedError(
  "SupervisorLifecycleError",
)<{
  readonly phase: "startup" | "shutdown";
  readonly cause: unknown;
}> {}

export interface SupervisorOptions {
  readonly paths?: StatePaths;
  readonly idleMilliseconds?: number;
  readonly shutdownGraceMilliseconds?: number;
  readonly resolveGrant?: typeof resolveServingGrant;
  readonly startSessionServer?: StartSessionServer;
  readonly startReviewOriginServer?: StartReviewOriginServer;
  readonly version?: string;
  readonly maximumSessions?: number;
  readonly maximumReviews?: number;
  readonly beforeHealth?: () => Promise<void>;
  readonly ownershipNonce?: string;
  readonly idleRuntime?: IdleRuntime;
  readonly deferIdleClose?: (close: () => void) => void;
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
  const hosts: string[] = [];
  for (let index = 0; index < request.rawHeaders.length; index += 2) {
    if (request.rawHeaders[index]?.toLowerCase() === "host")
      hosts.push(request.rawHeaders[index + 1] ?? "");
  }
  return hosts.length === 1 && hosts[0] === controlHost;
}

type ServerControlError =
  PathError | ControlError | ContentListenerError | ReviewError;

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
    case "ReviewError":
      return error.code === "review.session_not_found" ? 404 : 409;
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

function verifyListenerReady(
  listener: { readonly hostname: string; readonly port: number },
  requestPath: string,
  expectedStatus: number,
): Effect.Effect<void, ContentListenerError> {
  return Effect.callback<void, ContentListenerError>((resume) => {
    const operation = httpRequest(
      {
        hostname: "127.0.0.1",
        port: listener.port,
        method: "HEAD",
        path: requestPath,
        headers: { host: `${listener.hostname}:${listener.port}` },
        timeout: 2_000,
      },
      (response) => {
        response.resume();
        if (response.statusCode === expectedStatus) resume(Effect.void);
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

function closeScopeFailures(
  scopes: readonly Scope.Closeable[],
): Effect.Effect<unknown[]> {
  return Effect.forEach(
    scopes,
    (scope) => Effect.exit(Scope.close(scope, Exit.void)),
    { concurrency: "unbounded" },
  ).pipe(
    Effect.map((exits) =>
      exits.flatMap((exit) =>
        Exit.isFailure(exit) ? [Cause.squash(exit.cause)] : [],
      ),
    ),
  );
}

function failCleanup(failures: readonly unknown[]): Effect.Effect<void> {
  if (failures.length === 0) return Effect.void;
  return Effect.die(
    failures.length === 1
      ? failures[0]
      : new AggregateError(failures, "Listener cleanup failed"),
  );
}

class SessionRegistry {
  readonly #sessions = new Map<string, LiveSession>();
  readonly #identity = new Map<string, string>();
  readonly #reviews = new Map<string, ReviewRecord>();
  readonly #openReview = new Map<string, string>();
  readonly #pendingScopes = new Set<Scope.Closeable>();
  readonly #mutations = Semaphore.makeUnsafe(1);
  readonly #scope = Scope.makeUnsafe("parallel");
  #closing = false;

  constructor(
    private readonly startServer: StartSessionServer,
    private readonly startReviewOrigin: StartReviewOriginServer,
    private readonly maximumSessions: number,
    private readonly maximumReviews: number,
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

  state(fields: readonly OptionalSessionField[]): {
    readonly sessions: SessionSummary[];
    readonly reviews: ReviewSummary[];
  } {
    return {
      sessions: this.list(fields),
      reviews: [...this.#reviews.values()]
        .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
        .map((record) => ({
          id: record.id,
          status: record.status,
          session: record.session,
          drafts: record.drafts,
          unacknowledged: record.unacknowledged,
        })),
    };
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
      this.#pendingScopes.add(scope);
      const create = Effect.gen({ self: this }, function* () {
        const server = yield* Scope.provide(scope)(this.startServer(grant));
        yield* verifyListenerReady(server, grant.entryUrlPath, 200);
        let id: string;
        do id = generateSessionId();
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
          grant,
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
        Effect.ensuring(
          Effect.sync(() => {
            this.#pendingScopes.delete(scope);
          }),
        ),
      );
    });
  }

  review(
    sessionId: string,
  ): Effect.Effect<ReviewControlResult, ReviewError | ContentListenerError> {
    return this.#mutations.withPermit(
      Effect.gen({ self: this }, function* () {
        if (this.#closing)
          return yield* new ReviewError({
            code: "review.session_not_found",
            message: "The raw session is not available",
          });
        const session = this.#sessions.get(sessionId);
        if (session === undefined)
          return yield* new ReviewError({
            code: "review.session_not_found",
            message: "The raw session is not available",
          });

        const existingId = this.#openReview.get(session.identityKey);
        if (existingId !== undefined) {
          const existing = this.#reviews.get(existingId);
          if (existing !== undefined) {
            if (existing.status === "ready" && existing.live !== undefined)
              return this.#reviewResult(existing, session, true);
            if (existing.status === "stopped") {
              yield* this.#activateReview(existing, session);
              return this.#reviewResult(existing, session, true);
            }
          }
        }

        if (this.#reviews.size >= this.maximumReviews)
          return yield* new ReviewError({
            code: "review.limit",
            message: `Retained review limit of ${this.maximumReviews} reached`,
          });
        let id: string;
        do id = generateReviewId();
        while (this.#reviews.has(id));
        const record: ReviewRecord = {
          id,
          identityKey: session.identityKey,
          createdAt: new Date(yield* Clock.currentTimeMillis).toISOString(),
          status: "stopped",
          session: session.summary.id,
          drafts: 0,
          unacknowledged: 0,
          live: undefined,
        };
        yield* this.#activateReview(record, session);
        this.#reviews.set(record.id, record);
        this.#openReview.set(record.identityKey, record.id);
        return this.#reviewResult(record, session, false);
      }),
    );
  }

  #activateReview(
    record: ReviewRecord,
    session: LiveSession,
  ): Effect.Effect<void, ContentListenerError> {
    return Effect.gen({ self: this }, function* () {
      const scope = yield* Scope.fork(this.#scope, "parallel");
      this.#pendingScopes.add(scope);
      const activate = Effect.gen({ self: this }, function* () {
        const startReadyOrigin = (role: ReviewOriginRole) =>
          Scope.provide(scope)(this.startReviewOrigin(role)).pipe(
            Effect.tap((server) =>
              verifyListenerReady(server, server.readinessPath, 204),
            ),
            Effect.timeoutOrElse({
              duration: reviewOriginReadyTimeoutMilliseconds,
              orElse: () =>
                Effect.fail(
                  new ContentListenerError({
                    code: "http.readiness_failed",
                    message: "The review listener did not become ready",
                  }),
                ),
            }),
          );
        const shell = yield* startReadyOrigin("shell");
        const content = yield* startReadyOrigin("content");
        const rawHostname = new URL(session.summary.url).hostname;
        if (
          shell.hostname === content.hostname ||
          shell.hostname === rawHostname ||
          content.hostname === rawHostname
        )
          return yield* new ContentListenerError({
            code: "http.readiness_failed",
            message: "The review origins were not isolated",
          });
        record.status = "ready";
        record.session = session.summary.id;
        record.live = { scope, shell, content };
      });
      yield* activate.pipe(
        Effect.onExit((exit) =>
          Exit.isSuccess(exit) ? Effect.void : Scope.close(scope, exit),
        ),
        Effect.ensuring(
          Effect.sync(() => {
            this.#pendingScopes.delete(scope);
          }),
        ),
      );
    });
  }

  #reviewResult(
    record: ReviewRecord,
    session: LiveSession,
    reused: boolean,
  ): ReviewControlResult {
    if (record.status !== "ready" || record.live === undefined)
      throw new Error("Ready review is missing its live origins");
    return {
      review: {
        id: record.id,
        status: "ready",
        url: record.live.shell.url,
        reused,
      },
      session: {
        id: session.summary.id,
        url: session.summary.url,
      },
      grant: {
        root: session.grant.root,
        access: "read_all_regular_files_beneath_root",
      },
      fidelity: "instrumented_review",
    };
  }

  #detachReview(liveSession: LiveSession): Scope.Closeable | undefined {
    const reviewId = this.#openReview.get(liveSession.identityKey);
    if (reviewId === undefined) return undefined;
    const record = this.#reviews.get(reviewId);
    if (
      record === undefined ||
      record.status !== "ready" ||
      record.live === undefined
    )
      return undefined;
    const live = record.live;
    record.status = "stopped";
    record.live = undefined;
    return live.scope;
  }

  stop(sessionId: string): Effect.Effect<TargetedStopControlResult> {
    return this.#mutations.withPermit(
      Effect.gen({ self: this }, function* () {
        const live = this.#sessions.get(sessionId);
        if (live === undefined) return { stopped: 0 };
        const reviewScope = this.#detachReview(live);
        const failures = yield* closeScopeFailures(
          reviewScope === undefined ? [] : [reviewScope],
        );
        this.#sessions.delete(sessionId);
        this.#identity.delete(live.identityKey);
        failures.push(...(yield* closeScopeFailures([live.scope])));
        yield* failCleanup(failures);
        return { stopped: 1 };
      }),
    );
  }

  stopAll(): Effect.Effect<StopControlResult> {
    this.#closing = true;
    return Effect.gen({ self: this }, function* () {
      const failures = yield* closeScopeFailures([...this.#pendingScopes]);
      return yield* this.#mutations.withPermit(
        Effect.gen({ self: this }, function* () {
          const stopped = this.#sessions.size;
          const reviewScopes = [...this.#sessions.values()].flatMap((live) => {
            const scope = this.#detachReview(live);
            return scope === undefined ? [] : [scope];
          });
          failures.push(...(yield* closeScopeFailures(reviewScopes)));
          failures.push(
            ...(yield* closeScopeFailures(
              [...this.#sessions.values()].map((live) => live.scope),
            )),
          );
          this.#sessions.clear();
          this.#identity.clear();
          failures.push(...(yield* closeScopeFailures([this.#scope])));
          yield* failCleanup(failures);
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

async function startSupervisorPromise(
  options: SupervisorOptions = {},
  runPromise: <A, E>(
    effect: Effect.Effect<A, E>,
  ) => Promise<A> = Effect.runPromise,
): Promise<RunningSupervisor> {
  const paths = options.paths ?? statePaths();
  await runPromise(ensurePrivateStateDirectory(paths));
  const instanceId = randomUUID();
  const sessions = new SessionRegistry(
    options.startSessionServer ?? startStaticServer,
    options.startReviewOriginServer ?? startReviewOriginServer,
    options.maximumSessions ?? maximumConcurrentSessions,
    options.maximumReviews ?? maximumRetainedReviews,
  );
  const resolveGrantBase = options.resolveGrant ?? resolveServingGrant;
  const canonicalStateDirectory = await realpath(paths.directory);
  const resolveGrant: typeof resolveServingGrant = (...arguments_) =>
    Effect.gen(function* () {
      const grant = yield* resolveGrantBase(...arguments_);
      if (canonicalTreesOverlap(grant.root, canonicalStateDirectory))
        return yield* new PathError({
          code: "path.root_contains_state",
          message:
            "Serving root and htmlview runtime state directory must be disjoint",
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
    idleScope = await runPromise(Scope.make());
    runIdle = await runPromise(
      Scope.provide(idleScope)(FiberSet.makeRuntime<never, void, never>()),
    );
  }
  let idleFiber: EffectFiber<void, never> | undefined;
  let idleGeneration = 0;
  let activeHandlers = 0;
  let closing = false;
  let closePromise: Promise<void> | undefined;
  const closedSignal = Deferred.makeUnsafe<void, SupervisorLifecycleError>();
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
      await runPromise(Scope.close(idleScope, Exit.void));
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
      if (request.method === "GET" && requestUrl.pathname === "/state") {
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
            encodeSupervisorStateResult(sessions.state(fields.success)),
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
        requestUrl.pathname === "/reviews" &&
        requestUrl.search === ""
      ) {
        const body = decodeCreateReviewRequest(yield* readJsonBody(request));
        if (Result.isFailure(body)) return yield* invalidControlRequest();
        const result = yield* sessions.review(body.success.session);
        return yield* Effect.sync(() =>
          json(response, 200, encodeReviewControlResult(result)),
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

  const controlScope = await runPromise(Scope.make());
  const runControlRequest = await runPromise(
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
  await runPromise(
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
      () => runPromise(Scope.close(controlScope, Exit.void)),
    ];
    if (ownership !== undefined)
      cleanupOperations.push(() =>
        runPromise(Scope.close(ownership, Exit.void)),
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
      bootstrapScope = await runPromise(Scope.make());
      bootstrapLock = await runPromise(
        Scope.provide(bootstrapScope)(acquireSupervisorLock(paths)),
      );
    }
    const candidateScope = await runPromise(Scope.make());
    try {
      await runPromise(
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
      await runPromise(Scope.close(candidateScope, Exit.void));
      throw error;
    }
  } catch (error) {
    throw startupFailure(error, await cleanupStartupResources());
  } finally {
    if (bootstrapScope !== undefined)
      await runPromise(Scope.close(bootstrapScope, Exit.void));
  }

  await runPromise(listenControlServer(control, paths.controlSocket)).catch(
    async (error: unknown) => {
      throw startupFailure(
        error,
        await cleanupStartupResources(ownershipScope),
      );
    },
  );
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
      try {
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
          await runPromise(sessions.stopAll());
        } catch (error) {
          failures.push(error);
        }
        try {
          await runPromise(Scope.close(controlScope, Exit.void));
        } catch (error) {
          failures.push(error);
        }
        try {
          await runPromise(Scope.close(ownershipScope, Exit.void));
        } catch (error) {
          failures.push(error);
        }
        if (failures.length === 1) throw failures[0];
        if (failures.length > 1)
          throw new AggregateError(failures, "Supervisor shutdown failed");
        Effect.runSync(Deferred.succeed(closedSignal, undefined));
      } catch (cause) {
        Effect.runSync(
          Deferred.fail(
            closedSignal,
            new SupervisorLifecycleError({ phase: "shutdown", cause }),
          ),
        );
        throw cause;
      }
    })();
    return closePromise;
  }

  scheduleIdleShutdown();

  return {
    close: Effect.tryPromise({
      try: close,
      catch: (cause) =>
        new SupervisorLifecycleError({ phase: "shutdown", cause }),
    }),
    closed: Deferred.await(closedSignal),
    identity,
    paths,
  };
}

export const startSupervisor = Effect.fn("supervisor.start")((
  options: SupervisorOptions = {},
) => {
  return Effect.gen(function* () {
    const currentLoggers = yield* Logger.CurrentLoggers;
    const logToStderr = yield* Logger.LogToStderr;
    const minimumLogLevel = yield* References.MinimumLogLevel;
    const diagnosticContext = Context.make(
      Logger.CurrentLoggers,
      currentLoggers,
    ).pipe(
      Context.add(Logger.LogToStderr, logToStderr),
      Context.add(References.MinimumLogLevel, minimumLogLevel),
    );
    const runWithDiagnostics = Effect.runPromiseWith(diagnosticContext) as <
      A,
      E,
    >(
      effect: Effect.Effect<A, E>,
    ) => Promise<A>;
    return yield* Effect.tryPromise({
      try: () => startSupervisorPromise(options, runWithDiagnostics),
      catch: (cause) =>
        new SupervisorLifecycleError({ phase: "startup", cause }),
    });
  });
});

export const runSupervisor = Effect.fn("supervisor.run")((
  options: SupervisorOptions = {},
) => {
  return Effect.gen(function* () {
    const supervisor = yield* Effect.acquireRelease(
      startSupervisor(options),
      (running) =>
        running.close.pipe(
          Effect.ensuring(
            logDiagnostic("Info", { operation: "supervisor.stop" }),
          ),
          Effect.orDie,
        ),
    );
    yield* logDiagnostic("Info", { operation: "supervisor.start" });
    yield* supervisor.closed;
  });
});
