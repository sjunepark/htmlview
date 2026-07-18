import { createHash, randomBytes } from "node:crypto";
import { type IncomingMessage, type ServerResponse } from "node:http";
import path from "node:path";
import type { Readable } from "node:stream";
import { Effect, type Scope } from "effect";
import { contentType } from "mime-types";
import { ContentListenerError } from "../errors.js";
import {
  openAuthorizedFile,
  type AuthorizedFileMetadata,
} from "./authorized-file.js";
import type { ServingGrant } from "./grant.js";
import { hasExactAuthority, startLoopbackHttpListener } from "./listener.js";

export interface StaticSessionServer {
  readonly bindAddress: "127.0.0.1";
  readonly hostname: string;
  readonly port: number;
  readonly origin: string;
  readonly url: string;
}

export interface StaticHandlerOptions {
  readonly hostname: string;
  readonly cachePolicy?: "revalidate" | "no-store";
  readonly observeServedFile?: (
    file: ServedFileDescriptor,
  ) => ServedFileObservation | undefined;
}

export interface ServedFileDescriptor {
  readonly target: string;
  readonly metadata: AuthorizedFileMetadata;
}

export interface ServedFileSnapshot extends ServedFileDescriptor {
  readonly revision: `sha256:${string}`;
}

export interface ServedFileObservation {
  complete(revision: `sha256:${string}`): void;
  cancel(): void;
}

function send(
  response: ServerResponse,
  status: number,
  message: string,
  extraHeaders: Record<string, string> = {},
): void {
  const body = Buffer.from(message);
  response.writeHead(status, {
    "content-type": "text/plain; charset=utf-8",
    "content-length": String(body.length),
    "cache-control": "no-cache",
    "x-content-type-options": "nosniff",
    ...extraHeaders,
  });
  response.end(body);
}

function decodeRequestPath(
  requestUrl: string | undefined,
): string[] | undefined {
  if (requestUrl === undefined) return undefined;
  const rawPath = requestUrl.split("?", 1)[0] ?? "";
  if (
    !rawPath.startsWith("/") ||
    rawPath.includes("\\") ||
    /%2f|%5c/i.test(rawPath)
  )
    return undefined;
  let decoded: string;
  try {
    decoded = decodeURIComponent(rawPath);
  } catch {
    return undefined;
  }
  const hasControl = [...decoded].some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint <= 0x1f || codePoint === 0x7f;
  });
  if (hasControl || decoded.includes("\\")) return undefined;
  const segments = decoded.split("/").slice(1);
  if (segments.some((segment) => segment === "." || segment === ".."))
    return undefined;
  return segments.filter((segment) => segment !== "");
}

function etag(
  size: bigint,
  modifiedNanoseconds: bigint,
  inode: bigint,
): string {
  return `"${inode.toString(16)}-${size.toString(16)}-${modifiedNanoseconds.toString(16)}"`;
}

function isNotModified(
  request: IncomingMessage,
  tag: string,
  modified: Date,
): boolean {
  const ifNoneMatch = request.headers["if-none-match"];
  if (ifNoneMatch !== undefined) {
    return ifNoneMatch
      .split(",")
      .some(
        (candidate) =>
          candidate.trim().replace(/^W\//, "") === tag ||
          candidate.trim() === "*",
      );
  }
  const ifModifiedSince = request.headers["if-modified-since"];
  if (ifModifiedSince === undefined) return false;
  const timestamp = Date.parse(ifModifiedSince);
  return (
    Number.isFinite(timestamp) &&
    Math.floor(modified.getTime() / 1000) <= Math.floor(timestamp / 1000)
  );
}

function streamAuthorizedFile(
  stream: Readable,
  response: ServerResponse,
  expectedSize: bigint,
  observation?: ServedFileObservation,
): Effect.Effect<void> {
  return Effect.callback<void>((resume, signal) => {
    const hash = observation === undefined ? undefined : createHash("sha256");
    const destroy = (): void => {
      if (!stream.destroyed) stream.destroy();
      if (!response.destroyed) response.destroy();
    };
    let completed = false;
    let bytesRead = 0n;
    let sourceEnded = false;
    let observationSettled = false;
    const cancelObservation = (): void => {
      if (observationSettled || observation === undefined) return;
      observationSettled = true;
      try {
        observation.cancel();
      } catch {
        // Observation is auxiliary; a consumer failure must not change serving.
      }
    };
    const completeObservation = (revision: `sha256:${string}`): void => {
      if (observationSettled || observation === undefined) return;
      observationSettled = true;
      try {
        observation.complete(revision);
      } catch {
        // Observation is auxiliary; a consumer failure must not change serving.
      }
    };
    const cleanup = (): void => {
      stream.off("data", onData);
      stream.off("end", onEnd);
      stream.off("error", onStreamError);
      response.off("finish", onResponseFinish);
      response.off("close", onResponseClose);
    };
    const finish = (): void => {
      if (completed) return;
      completed = true;
      cancelObservation();
      cleanup();
      resume(Effect.void);
    };
    const onData = (chunk: Buffer | string): void => {
      const body = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      bytesRead += BigInt(body.byteLength);
      hash?.update(body);
    };
    const onEnd = (): void => {
      sourceEnded = true;
    };
    const onStreamError = (): void => {
      if (!response.destroyed) response.destroy();
    };
    const onResponseFinish = (): void => {
      if (sourceEnded && bytesRead === expectedSize && hash !== undefined)
        completeObservation(`sha256:${hash.digest("hex")}`);
      finish();
    };
    const onResponseClose = (): void => {
      if (!response.writableFinished && !stream.destroyed) stream.destroy();
      finish();
    };
    try {
      if (response.destroyed || signal.aborted) {
        completed = true;
        cancelObservation();
        destroy();
        resume(Effect.void);
        return Effect.void;
      }
      if (hash !== undefined) stream.on("data", onData);
      stream.once("end", onEnd);
      stream.once("error", onStreamError);
      response.once("finish", onResponseFinish);
      response.once("close", onResponseClose);
      if (signal.aborted) destroy();
      else stream.pipe(response);
    } catch (cause) {
      destroy();
      cancelObservation();
      cleanup();
      completed = true;
      resume(Effect.die(cause));
    }
    return Effect.sync(() => {
      cancelObservation();
      cleanup();
      destroy();
    });
  });
}

function beginFileObservation(
  options: StaticHandlerOptions,
  target: string,
  metadata: AuthorizedFileMetadata,
): ServedFileObservation | undefined {
  try {
    return options.observeServedFile?.({ target, metadata });
  } catch {
    return undefined;
  }
}

function completeEmptyObservation(observation: ServedFileObservation): void {
  try {
    observation.complete(`sha256:${createHash("sha256").digest("hex")}`);
  } catch {
    // Observation is auxiliary; a consumer failure must not change serving.
  }
}

function cancelFileObservation(observation: ServedFileObservation): void {
  try {
    observation.cancel();
  } catch {
    // Observation is auxiliary; a consumer failure must not change serving.
  }
}

export function createStaticHandler(
  grant: ServingGrant,
  options: StaticHandlerOptions,
) {
  return (
    request: IncomingMessage,
    response: ServerResponse,
  ): Effect.Effect<void> =>
    Effect.scoped(
      Effect.gen(function* () {
        if (!hasExactAuthority(request, options.hostname))
          return yield* Effect.sync(() =>
            send(response, 421, "Misdirected Request"),
          );
        if (request.method !== "GET" && request.method !== "HEAD")
          return yield* Effect.sync(() =>
            send(response, 405, "Method Not Allowed", { allow: "GET, HEAD" }),
          );
        const segments = decodeRequestPath(request.url);
        if (segments === undefined)
          return yield* Effect.sync(() =>
            send(response, 400, "Malformed request path"),
          );

        const target = path.join(grant.root, ...segments);
        const opened = yield* openAuthorizedFile(grant.root, target);
        if (opened.outcome === "forbidden")
          return yield* Effect.sync(() => send(response, 403, "Forbidden"));
        if (opened.outcome === "changed")
          return yield* Effect.sync(() =>
            send(response, 409, "File changed during authorization"),
          );
        if (opened.outcome === "missing")
          return yield* Effect.sync(() => send(response, 404, "Not Found"));
        if (opened.metadata.size > BigInt(Number.MAX_SAFE_INTEGER) + 1n)
          return yield* Effect.sync(() =>
            send(response, 413, "File exceeds the supported size"),
          );

        const modified = new Date(
          Number(opened.metadata.modifiedNanoseconds / 1_000_000n),
        );
        const tag = etag(
          opened.metadata.size,
          opened.metadata.modifiedNanoseconds,
          opened.metadata.inode,
        );
        const cacheControl =
          options.cachePolicy === "no-store" ? "no-store" : "no-cache";
        const headers = {
          "content-type":
            contentType(path.extname(target)) || "application/octet-stream",
          "content-length": opened.metadata.size.toString(),
          "last-modified": modified.toUTCString(),
          etag: tag,
          "cache-control": cacheControl,
          "x-content-type-options": "nosniff",
          "cross-origin-resource-policy": "same-origin",
        };

        if (
          cacheControl !== "no-store" &&
          isNotModified(request, tag, modified)
        )
          return yield* Effect.sync(() => {
            response.writeHead(304, {
              etag: tag,
              "last-modified": modified.toUTCString(),
              "cache-control": cacheControl,
              "x-content-type-options": "nosniff",
            });
            response.end();
          });

        yield* Effect.sync(() => response.writeHead(200, headers));
        if (request.method === "HEAD")
          return yield* Effect.sync(() => response.end());
        const observation = beginFileObservation(
          options,
          target,
          opened.metadata,
        );
        if (opened.metadata.size === 0n)
          return yield* Effect.sync(() => {
            if (observation !== undefined) {
              if (response.destroyed) {
                cancelFileObservation(observation);
                return;
              }
              let settled = false;
              response.once("finish", () => {
                if (settled) return;
                settled = true;
                completeEmptyObservation(observation);
              });
              response.once("close", () => {
                if (settled) return;
                settled = true;
                cancelFileObservation(observation);
              });
            }
            response.end();
          });
        const stream = yield* opened.openReadStream;
        return yield* streamAuthorizedFile(
          stream,
          response,
          opened.metadata.size,
          observation,
        );
      }),
    );
}

function contentStartFailure(cause: unknown): ContentListenerError {
  return new ContentListenerError({
    code: "http.start_failed",
    message: "The loopback content listener could not start",
    cause,
  });
}

export function generateSessionHostname(): string {
  return `h-${randomBytes(16).toString("hex")}.localhost`;
}

export function startStaticServer(
  grant: ServingGrant,
  options: {
    readonly hostname?: string;
    readonly responseDeadlineMilliseconds?: number;
  } = {},
): Effect.Effect<StaticSessionServer, ContentListenerError, Scope.Scope> {
  return Effect.gen(function* () {
    const hostname = yield* Effect.try({
      try: () => options.hostname ?? generateSessionHostname(),
      catch: contentStartFailure,
    });
    const handler = createStaticHandler(grant, {
      hostname,
    });
    const listener = yield* startLoopbackHttpListener(handler, {
      ...(options.responseDeadlineMilliseconds === undefined
        ? {}
        : {
            responseDeadlineMilliseconds: options.responseDeadlineMilliseconds,
          }),
    });
    const origin = `http://${hostname}:${listener.port}`;
    return {
      bindAddress: listener.bindAddress,
      hostname,
      port: listener.port,
      origin,
      url: `${origin}${grant.entryUrlPath}`,
    };
  });
}
