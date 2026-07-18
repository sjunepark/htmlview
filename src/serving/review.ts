import { randomBytes } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Readable } from "node:stream";
import { Effect, Semaphore, type Scope } from "effect";
import type { AnnotationDraft, PersistedReview } from "../annotation/model.js";
import type { AnnotationDraftInput } from "../annotation/registry.js";
import {
  ContentListenerError,
  ReviewError,
  RuntimeStateError,
} from "../errors.js";
import { openAuthorizedFile } from "./authorized-file.js";
import type { ServingGrant } from "./grant.js";
import {
  createStaticHandler,
  type ServedFileDescriptor,
  type ServedFileObservation,
} from "./http.js";
import {
  maximumInstrumentedEntryBytes,
  reviewProbePathPrefix,
  transformReviewEntry,
  type ReviewEntryLimitation,
} from "./instrumented-entry.js";
import {
  hasExactAuthority,
  startLoopbackHttpListener,
  type LoopbackHttpListener,
} from "./listener.js";
import {
  reviewAssets,
  reviewProbeAsset,
  type ReviewAsset,
} from "./review-assets.js";
import type {
  ReviewEntryObservation,
  ReviewRefreshObserver,
} from "./review-entry-observer.js";
import {
  decodeActivateProbeRequest,
  decodeEndReviewRequest,
  decodeIssueNavigationRequest,
  decodeQueueDraftRequest,
  decodeSendDraftsRequest,
  decodedOrUndefined,
} from "./review-browser-protocol.js";

export type ReviewOriginRole = "shell" | "content";

const navigationCapabilityParameter = "__htmlview_navigation";
const navigationCapabilityLifetimeMilliseconds = 10_000;
const maximumNavigationCapabilities = 16;

export interface ReviewSurfaceService {
  readonly record: () => PersistedReview | undefined;
  readonly queue: (
    input: AnnotationDraftInput,
  ) => Effect.Effect<AnnotationDraft, ReviewError | RuntimeStateError>;
  readonly send: (
    draftIds: readonly string[],
    options?: { readonly end?: boolean; readonly discardRemaining?: boolean },
  ) => Effect.Effect<
    {
      readonly sent: number;
      readonly discarded: number;
      readonly status: string;
    },
    ReviewError | RuntimeStateError
  >;
  readonly closeAfterEnd: Effect.Effect<void>;
}

export interface ReviewSurfaceConfiguration {
  readonly reviewId: string;
  readonly grant: ServingGrant;
  readonly shellOrigin: string;
  readonly contentOrigin: string;
  readonly service: ReviewSurfaceService;
}

export class ReviewSurfaceState {
  #configuration: ReviewSurfaceConfiguration | undefined;
  readonly #revisions: string[] = [];
  readonly #pendingProbes = new Map<
    string,
    { readonly lease: string; readonly revision: string }
  >();
  readonly #issuedProbeLeases = new Map<string, string>();
  readonly #navigationCapabilities = new Map<
    string,
    {
      readonly entry: string;
      readonly expectedRevision?: string;
      readonly expiresAt: number;
    }
  >();
  readonly #entryTransforms = Semaphore.makeUnsafe(1);
  #limitation: ReviewEntryLimitation | undefined;
  #entryObservation: ReviewEntryObservation | undefined;
  #refreshObserver: ReviewRefreshObserver | undefined;

  configure(configuration: ReviewSurfaceConfiguration): void {
    if (this.#configuration !== undefined)
      throw new Error("The review surface was already configured");
    this.#configuration = configuration;
  }

  configuration(): ReviewSurfaceConfiguration | undefined {
    return this.#configuration;
  }

  admitRevision(revision: string): void {
    const existing = this.#revisions.indexOf(revision);
    if (existing !== -1) this.#revisions.splice(existing, 1);
    this.#revisions.push(revision);
    if (this.#revisions.length > 8) this.#revisions.shift();
    this.#limitation = undefined;
  }

  hasRevision(revision: string): boolean {
    return this.#revisions.includes(revision);
  }

  prepareProbe(path: string, revision: string): void {
    if (!/^\/\.htmlview\/probe\/[0-9a-f]{32}\.js$/.test(path))
      throw new TypeError("Invalid review probe path");
    this.#pendingProbes.set(path, {
      lease: randomBytes(16).toString("hex"),
      revision,
    });
    while (this.#pendingProbes.size > 8) {
      const oldest = this.#pendingProbes.keys().next().value as
        string | undefined;
      if (oldest === undefined) break;
      this.#pendingProbes.delete(oldest);
    }
  }

  issueProbeLease(path: string): string | undefined {
    const pending = this.#pendingProbes.get(path);
    if (pending === undefined) return undefined;
    this.#pendingProbes.delete(path);
    this.#issuedProbeLeases.set(pending.lease, pending.revision);
    while (this.#issuedProbeLeases.size > 8) {
      const oldest = this.#issuedProbeLeases.keys().next().value as
        string | undefined;
      if (oldest === undefined) break;
      this.#issuedProbeLeases.delete(oldest);
    }
    return pending.lease;
  }

  activateProbe(lease: string): string | undefined {
    const revision = this.#issuedProbeLeases.get(lease);
    if (revision === undefined) return undefined;
    this.#issuedProbeLeases.delete(lease);
    this.admitRevision(revision);
    return revision;
  }

  limit(reason: ReviewEntryLimitation): void {
    this.#limitation = reason;
  }

  limitation(): ReviewEntryLimitation | undefined {
    return this.#limitation;
  }

  publishEntryObservation(observation: ReviewEntryObservation): void {
    this.#entryObservation = observation;
  }

  entryObservation(): ReviewEntryObservation | undefined {
    return this.#entryObservation;
  }

  attachRefreshObserver(observer: ReviewRefreshObserver): void {
    if (this.#refreshObserver !== undefined)
      throw new Error("The review refresh observer was already attached");
    this.#refreshObserver = observer;
  }

  beginServedFileObservation(
    file: ServedFileDescriptor,
  ): ServedFileObservation | undefined {
    return this.#refreshObserver?.beginServedFileObservation(file);
  }

  issueNavigation(
    entry: string,
    options: {
      readonly expectedRevision?: string;
      readonly now?: number;
      readonly random?: (size: number) => Buffer;
    } = {},
  ): string {
    const now = options.now ?? Date.now();
    const random = options.random ?? randomBytes;
    if (options.expectedRevision !== undefined) this.#limitation = undefined;
    for (const [token, capability] of this.#navigationCapabilities)
      if (capability.expiresAt <= now)
        this.#navigationCapabilities.delete(token);
    while (this.#navigationCapabilities.size >= maximumNavigationCapabilities) {
      const oldest = this.#navigationCapabilities.keys().next().value as
        string | undefined;
      if (oldest === undefined) break;
      this.#navigationCapabilities.delete(oldest);
    }
    let token: string;
    do token = random(16).toString("hex");
    while (this.#navigationCapabilities.has(token));
    this.#navigationCapabilities.set(token, {
      entry,
      ...(options.expectedRevision === undefined
        ? {}
        : { expectedRevision: options.expectedRevision }),
      expiresAt: now + navigationCapabilityLifetimeMilliseconds,
    });
    return token;
  }

  authorizeNavigation(
    target: string,
    entry: string,
    now = Date.now(),
  ): { readonly expectedRevision?: string } | undefined {
    let url: URL;
    try {
      url = new URL(target, "http://htmlview-content");
    } catch {
      return undefined;
    }
    const tokens = url.searchParams.getAll(navigationCapabilityParameter);
    if (
      url.pathname !== entry ||
      url.searchParams.size !== 1 ||
      tokens.length !== 1 ||
      !/^[0-9a-f]{32}$/.test(tokens[0] ?? "")
    )
      return undefined;
    const token = tokens[0] as string;
    const capability = this.#navigationCapabilities.get(token);
    if (capability === undefined) return undefined;
    this.#navigationCapabilities.delete(token);
    if (capability.entry !== entry || capability.expiresAt <= now)
      return undefined;
    return capability.expectedRevision === undefined
      ? {}
      : { expectedRevision: capability.expectedRevision };
  }

  withEntryTransform<A, E, R>(
    operation: Effect.Effect<A, E, R>,
  ): Effect.Effect<A, E, R> {
    return this.#entryTransforms.withPermit(operation);
  }
}

export interface ReviewOriginServer extends LoopbackHttpListener {
  readonly role: ReviewOriginRole;
  readonly hostname: string;
  readonly origin: string;
  readonly url: string;
  readonly readinessPath: "/.htmlview/ready";
}

const maximumBrowserBodyBytes = 64 * 1024;

function singleHeader(
  request: IncomingMessage,
  name: string,
): string | undefined {
  const values: string[] = [];
  for (let index = 0; index < request.rawHeaders.length; index += 2)
    if (request.rawHeaders[index]?.toLowerCase() === name)
      values.push(request.rawHeaders[index + 1] ?? "");
  return values.length === 1 ? values[0] : undefined;
}

function browserFetchIsSameOrigin(request: IncomingMessage): boolean {
  return (
    singleHeader(request, "sec-fetch-site") === "same-origin" &&
    singleHeader(request, "sec-fetch-mode") === "cors" &&
    singleHeader(request, "sec-fetch-dest") === "empty"
  );
}

function browserDocumentNavigation(request: IncomingMessage): boolean {
  return (
    singleHeader(request, "sec-fetch-site") === "cross-site" &&
    singleHeader(request, "sec-fetch-mode") === "navigate" &&
    singleHeader(request, "sec-fetch-dest") === "iframe"
  );
}

function browserScriptRequest(request: IncomingMessage): boolean {
  return (
    singleHeader(request, "sec-fetch-site") === "same-origin" &&
    singleHeader(request, "sec-fetch-mode") === "no-cors" &&
    singleHeader(request, "sec-fetch-dest") === "script"
  );
}

function mutationIsAuthorized(
  request: IncomingMessage,
  shellOrigin: string,
): boolean {
  const contentType = singleHeader(request, "content-type");
  return (
    singleHeader(request, "origin") === shellOrigin &&
    browserFetchIsSameOrigin(request) &&
    (contentType === "application/json" ||
      contentType === "application/json; charset=utf-8")
  );
}

function responseHeaders(
  contentType: string,
  bodyLength: number,
  extra: Record<string, string> = {},
): Record<string, string> {
  return {
    "content-type": contentType,
    "content-length": String(bodyLength),
    "x-content-type-options": "nosniff",
    "cache-control": "no-store",
    ...extra,
  };
}

function sendBuffer(
  request: IncomingMessage,
  response: ServerResponse,
  status: number,
  body: Buffer,
  contentType: string,
  extra: Record<string, string> = {},
): void {
  response.writeHead(status, responseHeaders(contentType, body.length, extra));
  response.end(request.method === "HEAD" ? undefined : body);
}

function sendBufferAndWait(
  request: IncomingMessage,
  response: ServerResponse,
  status: number,
  body: Buffer,
  contentType: string,
  extra: Record<string, string> = {},
): Effect.Effect<void> {
  return Effect.callback<void>((resume) => {
    let completed = false;
    const cleanup = (): void => {
      response.off("finish", onComplete);
      response.off("close", onComplete);
      response.off("error", onError);
    };
    const onComplete = (): void => {
      if (completed) return;
      completed = true;
      cleanup();
      resume(Effect.void);
    };
    const onError = (cause: Error): void => {
      if (completed) return;
      completed = true;
      cleanup();
      resume(Effect.die(cause));
    };
    response.once("finish", onComplete);
    response.once("close", onComplete);
    response.once("error", onError);
    try {
      sendBuffer(request, response, status, body, contentType, extra);
    } catch (cause) {
      onError(cause instanceof Error ? cause : new Error("Response failed"));
    }
    return Effect.sync(() => {
      cleanup();
      if (!response.destroyed) response.destroy();
    });
  });
}

function sendText(
  request: IncomingMessage,
  response: ServerResponse,
  status: number,
  message: string,
  extra: Record<string, string> = {},
): void {
  sendBuffer(
    request,
    response,
    status,
    Buffer.from(message),
    "text/plain; charset=utf-8",
    extra,
  );
}

function sendJson(
  request: IncomingMessage,
  response: ServerResponse,
  status: number,
  value: unknown,
): void {
  sendBuffer(
    request,
    response,
    status,
    Buffer.from(JSON.stringify(value)),
    "application/json; charset=utf-8",
    { "cross-origin-resource-policy": "same-origin" },
  );
}

function sendAsset(
  request: IncomingMessage,
  response: ServerResponse,
  asset: ReviewAsset,
  extra: Record<string, string> = {},
): void {
  sendBuffer(request, response, 200, asset.body, asset.contentType, {
    "cache-control": "public, max-age=31536000, immutable",
    "cross-origin-resource-policy": "same-origin",
    ...extra,
  });
}

type JsonBodyResult =
  | { readonly outcome: "ok"; readonly value: unknown }
  | { readonly outcome: "invalid" }
  | { readonly outcome: "too_large" };

function readJsonBody(request: IncomingMessage): Effect.Effect<JsonBodyResult> {
  return Effect.callback<JsonBodyResult>((resume) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let tooLarge = false;
    const cleanup = (): void => {
      request.off("data", onData);
      request.off("end", onEnd);
      request.off("error", onError);
      request.off("aborted", onAborted);
    };
    const finish = (value: JsonBodyResult): void => {
      cleanup();
      resume(Effect.succeed(value));
    };
    const onData = (chunk: Buffer): void => {
      size += chunk.length;
      if (size > maximumBrowserBodyBytes) {
        tooLarge = true;
        chunks.length = 0;
      } else if (!tooLarge) chunks.push(chunk);
    };
    const onEnd = (): void => {
      if (tooLarge) return finish({ outcome: "too_large" });
      try {
        finish({
          outcome: "ok",
          value: JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown,
        });
      } catch {
        finish({ outcome: "invalid" });
      }
    };
    const onError = (): void => finish({ outcome: "invalid" });
    const onAborted = (): void => finish({ outcome: "invalid" });
    request.on("data", onData);
    request.once("end", onEnd);
    request.once("error", onError);
    request.once("aborted", onAborted);
    return Effect.sync(cleanup);
  });
}

function publicDraft(draft: AnnotationDraft): unknown {
  if (draft.kind === "freeform")
    return {
      id: draft.id,
      kind: draft.kind,
      comment: draft.comment,
      revision: draft.revision,
    };
  return {
    id: draft.id,
    kind: draft.kind,
    comment: draft.comment,
    revision: draft.revision,
    anchor: {
      selector: draft.anchor.selector,
      dom_path: draft.anchor.domPath,
      tag: draft.anchor.tag,
      ...(draft.anchor.text === undefined ? {} : { text: draft.anchor.text }),
    },
  };
}

function browserErrorStatus(error: ReviewError | RuntimeStateError): number {
  if (error instanceof RuntimeStateError) return 500;
  return error.code === "review.not_found" ? 404 : 409;
}

function browserError(error: ReviewError | RuntimeStateError): unknown {
  return { error: { code: error.code, message: error.message } };
}

function shellHandler(
  hostname: string,
  state: ReviewSurfaceState,
  request: IncomingMessage,
  response: ServerResponse,
): Effect.Effect<void> {
  return Effect.gen(function* () {
    if (!hasExactAuthority(request, hostname))
      return yield* Effect.sync(() =>
        sendText(request, response, 421, "Misdirected Request"),
      );
    const configuration = state.configuration();
    if (request.method === "HEAD" && request.url === "/.htmlview/ready")
      return yield* Effect.sync(() =>
        sendText(
          request,
          response,
          configuration === undefined ? 503 : 204,
          "",
        ),
      );
    if (configuration === undefined)
      return yield* Effect.sync(() =>
        sendText(request, response, 503, "Review is not ready"),
      );

    if (
      (request.method === "GET" || request.method === "HEAD") &&
      request.url === "/"
    ) {
      const csp = [
        "default-src 'none'",
        "script-src 'self'",
        "style-src 'self'",
        "connect-src 'self'",
        `frame-src ${configuration.contentOrigin}`,
        "base-uri 'none'",
        "form-action 'none'",
        "object-src 'none'",
        "frame-ancestors 'none'",
      ].join("; ");
      return yield* Effect.sync(() =>
        sendBuffer(
          request,
          response,
          200,
          reviewAssets.shellHtml.body,
          reviewAssets.shellHtml.contentType,
          {
            "content-security-policy": csp,
            "cross-origin-resource-policy": "same-origin",
            "referrer-policy": "no-referrer",
            "x-frame-options": "DENY",
          },
        ),
      );
    }
    if (
      (request.method === "GET" || request.method === "HEAD") &&
      request.url === "/.htmlview/shell.css"
    )
      return yield* Effect.sync(() =>
        sendAsset(request, response, reviewAssets.shellCss),
      );
    if (
      (request.method === "GET" || request.method === "HEAD") &&
      request.url === "/.htmlview/shell.js"
    )
      return yield* Effect.sync(() =>
        sendAsset(request, response, reviewAssets.shellJs),
      );

    if (request.method === "GET" && request.url === "/.htmlview/api/state") {
      if (!browserFetchIsSameOrigin(request))
        return yield* Effect.sync(() =>
          sendJson(request, response, 403, {
            error: { code: "review.unauthorized", message: "Forbidden" },
          }),
        );
      const record = configuration.service.record();
      if (record === undefined)
        return yield* Effect.sync(() =>
          sendJson(request, response, 404, {
            error: { code: "review.not_found", message: "Review not found" },
          }),
        );
      return yield* Effect.sync(() =>
        sendJson(request, response, 200, {
          review: { id: record.id, status: record.status },
          content_url: `${configuration.contentOrigin}${configuration.grant.entryUrlPath}`,
          entry: configuration.grant.entryUrlPath,
          drafts: record.drafts.map(publicDraft),
          ...(state.limitation() === undefined
            ? {}
            : { limitation: state.limitation() }),
        }),
      );
    }

    if (request.method === "GET" && request.url === "/.htmlview/api/entry") {
      if (!browserFetchIsSameOrigin(request))
        return yield* Effect.sync(() =>
          sendJson(request, response, 403, {
            error: { code: "review.unauthorized", message: "Forbidden" },
          }),
        );
      return yield* Effect.sync(() =>
        sendJson(request, response, 200, {
          entry: state.entryObservation() ?? { availability: "checking" },
        }),
      );
    }

    if (
      request.method === "POST" &&
      [
        "/.htmlview/api/navigation",
        "/.htmlview/api/probe",
        "/.htmlview/api/drafts",
        "/.htmlview/api/send",
        "/.htmlview/api/end",
      ].includes(request.url ?? "")
    ) {
      if (!mutationIsAuthorized(request, configuration.shellOrigin))
        return yield* Effect.sync(() =>
          sendJson(request, response, 403, {
            error: { code: "review.unauthorized", message: "Forbidden" },
          }),
        );
      const body = yield* readJsonBody(request);
      if (body.outcome === "too_large")
        return yield* Effect.sync(() =>
          sendJson(request, response, 413, {
            error: {
              code: "review.request_too_large",
              message: "Request body is too large",
            },
          }),
        );
      if (body.outcome === "invalid")
        return yield* Effect.sync(() =>
          sendJson(request, response, 400, {
            error: {
              code: "review.invalid_request",
              message: "Invalid request",
            },
          }),
        );

      const operation: Effect.Effect<unknown, ReviewError | RuntimeStateError> =
        request.url === "/.htmlview/api/navigation"
          ? (() => {
              const decoded = decodedOrUndefined(
                decodeIssueNavigationRequest(body.value),
              );
              if (decoded === undefined) return Effect.void;
              const token = state.issueNavigation(
                configuration.grant.entryUrlPath,
                decoded.expected_revision === undefined
                  ? {}
                  : { expectedRevision: decoded.expected_revision },
              );
              return Effect.succeed({
                navigation_url: `${configuration.contentOrigin}${configuration.grant.entryUrlPath}?${navigationCapabilityParameter}=${token}`,
              });
            })()
          : request.url === "/.htmlview/api/probe"
            ? (() => {
                const decoded = decodedOrUndefined(
                  decodeActivateProbeRequest(body.value),
                );
                if (decoded === undefined) return Effect.void;
                const revision = state.activateProbe(decoded.lease);
                return revision === undefined
                  ? Effect.fail(
                      new ReviewError({
                        code: "review.not_ready",
                        message: "The review probe lease is not active",
                      }),
                    )
                  : Effect.succeed({ revision });
              })()
            : request.url === "/.htmlview/api/drafts"
              ? (() => {
                  const decoded = decodedOrUndefined(
                    decodeQueueDraftRequest(body.value),
                  );
                  if (decoded === undefined) return Effect.void;
                  if (!state.hasRevision(decoded.revision))
                    return Effect.fail(
                      new ReviewError({
                        code: "review.not_ready",
                        message: "The rendered document revision is not active",
                      }),
                    );
                  const input: AnnotationDraftInput =
                    decoded.kind === "freeform"
                      ? {
                          kind: "freeform",
                          comment: decoded.comment,
                          revision: decoded.revision,
                          entry: configuration.grant.entryUrlPath,
                        }
                      : {
                          kind: "element",
                          comment: decoded.comment,
                          revision: decoded.revision,
                          entry: configuration.grant.entryUrlPath,
                          anchor: {
                            selector: decoded.anchor.selector,
                            domPath: decoded.anchor.dom_path,
                            tag: decoded.anchor.tag,
                            ...(decoded.anchor.text === undefined
                              ? {}
                              : { text: decoded.anchor.text }),
                          },
                        };
                  return configuration.service
                    .queue(input)
                    .pipe(
                      Effect.map((draft) => ({ draft: publicDraft(draft) })),
                    );
                })()
              : request.url === "/.htmlview/api/send"
                ? (() => {
                    const decoded = decodedOrUndefined(
                      decodeSendDraftsRequest(body.value),
                    );
                    return decoded === undefined
                      ? Effect.void
                      : configuration.service.send(decoded.drafts);
                  })()
                : (() => {
                    const decoded = decodedOrUndefined(
                      decodeEndReviewRequest(body.value),
                    );
                    return decoded === undefined
                      ? Effect.void
                      : configuration.service.send(decoded.drafts, {
                          end: true,
                          discardRemaining: decoded.discard_remaining,
                        });
                  })();
      const result = yield* Effect.result(operation);
      if (result._tag === "Failure")
        return yield* Effect.sync(() =>
          sendJson(
            request,
            response,
            browserErrorStatus(result.failure),
            browserError(result.failure),
          ),
        );
      if (result.success === undefined)
        return yield* Effect.sync(() =>
          sendJson(request, response, 400, {
            error: {
              code: "review.invalid_request",
              message: "Invalid request",
            },
          }),
        );
      if (request.url === "/.htmlview/api/end")
        yield* Effect.gen(function* () {
          const context = yield* Effect.context<never>();
          const runClose = Effect.runForkWith(context);
          yield* Effect.sync(() => {
            let closing = false;
            const close = (): void => {
              if (closing) return;
              closing = true;
              runClose(configuration.service.closeAfterEnd);
            };
            response.once("finish", close);
            response.once("close", close);
            if (response.destroyed) close();
          });
        });
      return yield* Effect.sync(() =>
        sendJson(request, response, 200, result.success),
      );
    }

    if (request.url?.startsWith("/.htmlview/api/") === true)
      return yield* Effect.sync(() =>
        sendText(request, response, 405, "Method Not Allowed", {
          allow: "GET, POST",
        }),
      );
    return yield* Effect.sync(() =>
      sendText(request, response, 404, "Not Found"),
    );
  });
}

function readStream(stream: Readable): Effect.Effect<Buffer | undefined> {
  return Effect.tryPromise({
    try: async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of stream)
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      return Buffer.concat(chunks);
    },
    catch: () => undefined,
  }).pipe(Effect.catch(() => Effect.sync((): undefined => undefined)));
}

function contentHandler(
  hostname: string,
  state: ReviewSurfaceState,
  request: IncomingMessage,
  response: ServerResponse,
): Effect.Effect<void> {
  return Effect.scoped(
    Effect.gen(function* () {
      if (!hasExactAuthority(request, hostname))
        return yield* Effect.sync(() =>
          sendText(request, response, 421, "Misdirected Request"),
        );
      const configuration = state.configuration();
      const requestPath = request.url?.split("?", 1)[0];
      if (request.method === "HEAD" && request.url === "/.htmlview/ready")
        return yield* Effect.sync(() =>
          sendText(
            request,
            response,
            configuration === undefined ? 503 : 204,
            "",
          ),
        );
      if (configuration === undefined)
        return yield* Effect.sync(() =>
          sendText(request, response, 503, "Review is not ready"),
        );
      if (singleHeader(request, "sec-fetch-dest") === "serviceworker")
        return yield* Effect.sync(() =>
          sendText(request, response, 403, "Service workers are unavailable"),
        );
      if (request.url?.startsWith(reviewProbePathPrefix) === true) {
        if (request.method !== "GET" || !browserScriptRequest(request))
          return yield* Effect.sync(() =>
            sendText(request, response, 404, "Not Found"),
          );
        const lease = state.issueProbeLease(request.url);
        if (lease === undefined)
          return yield* Effect.sync(() =>
            sendText(request, response, 404, "Not Found"),
          );
        return yield* Effect.sync(() =>
          sendAsset(request, response, reviewProbeAsset(lease), {
            "cache-control": "no-store",
          }),
        );
      }
      if (request.url?.startsWith("/.htmlview/") === true)
        return yield* Effect.sync(() =>
          sendText(request, response, 404, "Not Found"),
        );
      const reservedNavigation = (() => {
        try {
          return new URL(
            request.url ?? "",
            "http://htmlview-content",
          ).searchParams.has(navigationCapabilityParameter);
        } catch {
          return false;
        }
      })();
      const authorizedNavigation =
        request.method === "GET" &&
        browserDocumentNavigation(request) &&
        requestPath === configuration.grant.entryUrlPath
          ? state.authorizeNavigation(
              request.url ?? "",
              configuration.grant.entryUrlPath,
            )
          : undefined;
      if (reservedNavigation && authorizedNavigation === undefined)
        return yield* Effect.sync(() =>
          sendText(request, response, 404, "Not Found"),
        );
      if (authorizedNavigation) {
        return yield* state.withEntryTransform(
          Effect.gen(function* () {
            const opened = yield* openAuthorizedFile(
              configuration.grant.root,
              configuration.grant.routeEntry,
            );
            if (opened.outcome === "forbidden")
              return yield* Effect.sync(() =>
                sendText(request, response, 403, "Forbidden"),
              );
            if (opened.outcome === "changed")
              return yield* Effect.sync(() =>
                sendText(
                  request,
                  response,
                  409,
                  "File changed during authorization",
                ),
              );
            if (opened.outcome === "missing")
              return yield* Effect.sync(() =>
                sendText(request, response, 404, "Not Found"),
              );
            if (opened.metadata.size > BigInt(maximumInstrumentedEntryBytes)) {
              if (authorizedNavigation.expectedRevision !== undefined)
                return yield* Effect.sync(() =>
                  sendText(
                    request,
                    response,
                    409,
                    "Review entry changed before navigation",
                  ),
                );
              state.limit("entry_too_large");
              return yield* Effect.sync(() =>
                sendText(
                  request,
                  response,
                  422,
                  "Review entry exceeds the supported size",
                ),
              );
            }
            const stream = yield* opened.openReadStream;
            const source = yield* readStream(stream);
            if (source === undefined)
              return yield* Effect.sync(() =>
                sendText(
                  request,
                  response,
                  500,
                  "Review entry could not be read",
                ),
              );
            const probePath = `${reviewProbePathPrefix}${randomBytes(16).toString("hex")}.js`;
            const transformed = transformReviewEntry(
              source,
              configuration.contentOrigin,
              probePath,
            );
            if (
              authorizedNavigation.expectedRevision !== undefined &&
              transformed.revision !== authorizedNavigation.expectedRevision
            )
              return yield* Effect.sync(() =>
                sendText(
                  request,
                  response,
                  409,
                  "Review entry changed before navigation",
                ),
              );
            if (transformed.outcome === "unsupported") {
              state.limit(transformed.reason);
              return yield* Effect.sync(() =>
                sendText(
                  request,
                  response,
                  422,
                  `Review limitation: ${transformed.reason}`,
                ),
              );
            }
            state.prepareProbe(probePath, transformed.revision);
            return yield* sendBufferAndWait(
              request,
              response,
              200,
              transformed.body,
              "text/html; charset=utf-8",
              {
                "cache-control": "no-store",
                "content-security-policy": `frame-ancestors ${configuration.shellOrigin}`,
                "referrer-policy": "no-referrer",
              },
            );
          }),
        );
      }
      return yield* createStaticHandler(configuration.grant, {
        hostname,
        cachePolicy: "no-store",
        observeServedFile: (file) => state.beginServedFileObservation(file),
      })(request, response);
    }),
  );
}

function reviewHandler(
  role: ReviewOriginRole,
  hostname: string,
  state: ReviewSurfaceState,
) {
  return (request: IncomingMessage, response: ServerResponse) =>
    role === "shell"
      ? shellHandler(hostname, state, request, response)
      : contentHandler(hostname, state, request, response);
}

export function generateReviewHostname(
  role: ReviewOriginRole,
  random: (size: number) => Buffer = randomBytes,
): string {
  const prefix = role === "shell" ? "r" : "c";
  return `${prefix}-${random(16).toString("hex")}.localhost`;
}

export function startReviewOriginServer(
  role: ReviewOriginRole,
  options: {
    readonly hostname?: string;
    readonly state?: ReviewSurfaceState;
  } = {},
): Effect.Effect<ReviewOriginServer, ContentListenerError, Scope.Scope> {
  return Effect.gen(function* () {
    const hostname = options.hostname ?? generateReviewHostname(role);
    const state = options.state ?? new ReviewSurfaceState();
    const listener = yield* startLoopbackHttpListener(
      reviewHandler(role, hostname, state),
    );
    const origin = `http://${hostname}:${listener.port}`;
    return {
      ...listener,
      role,
      hostname,
      origin,
      url: `${origin}/`,
      readinessPath: "/.htmlview/ready",
    };
  });
}
