import { randomBytes } from "node:crypto";
import { constants as fsConstants, type BigIntStats } from "node:fs";
import { open, realpath, stat } from "node:fs/promises";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import path from "node:path";
import { Data, Effect, FiberSet, type Scope } from "effect";
import { contentType } from "mime-types";
import { ContentListenerError } from "../errors.js";
import { isWithinRoot, type ServingGrant } from "./grant.js";

const loopbackAddress = "127.0.0.1";
const defaultResponseDeadlineMilliseconds = 5 * 60_000;
const responseDeadlines = new WeakMap<
  IncomingMessage["socket"],
  NodeJS.Timeout
>();

export interface StaticSessionServer {
  readonly bindAddress: "127.0.0.1";
  readonly hostname: string;
  readonly port: number;
  readonly origin: string;
  readonly url: string;
}

export interface StaticHandlerOptions {
  readonly hostname: string;
  readonly responseDeadlineMilliseconds: number;
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
    "x-content-type-options": "nosniff",
    ...extraHeaders,
  });
  response.end(body);
}

function isExpectedAuthority(
  request: IncomingMessage,
  hostname: string,
): boolean {
  const port = request.socket.localPort;
  return port !== undefined && request.headers.host === `${hostname}:${port}`;
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

type FileHandle = Awaited<ReturnType<typeof open>>;

interface OwnedFileHandle {
  readonly handle: FileHandle;
  transferredToStream: boolean;
}

class FileAccessError extends Data.TaggedError("FileAccessError")<{
  readonly cause: unknown;
}> {}

type AuthorizedFile =
  | { readonly outcome: "missing" }
  | { readonly outcome: "forbidden" }
  | { readonly outcome: "changed" }
  | {
      readonly outcome: "file";
      readonly owned: OwnedFileHandle;
      readonly metadata: BigIntStats;
    };

function reportCleanupFailure(operation: string): Effect.Effect<void> {
  return Effect.sync(() => {
    try {
      process.stderr.write(`htmlview: ${operation} cleanup failed\n`);
    } catch {
      // The request's primary outcome remains authoritative.
    }
  });
}

function closeOwnedFile(owned: OwnedFileHandle): Effect.Effect<void> {
  if (owned.transferredToStream) return Effect.void;
  return Effect.tryPromise({
    try: () => owned.handle.close(),
    catch: (cause) => new FileAccessError({ cause }),
  }).pipe(
    Effect.catch(() => reportCleanupFailure("authorized file")),
    Effect.asVoid,
  );
}

function optionalFilePromise<A>(
  operation: () => Promise<A>,
): Effect.Effect<A | undefined> {
  return Effect.tryPromise({
    try: operation,
    catch: (cause) => new FileAccessError({ cause }),
  }).pipe(Effect.catch(() => Effect.sync((): undefined => undefined)));
}

function openAuthorizedFile(
  root: string,
  target: string,
): Effect.Effect<AuthorizedFile, never, Scope.Scope> {
  return Effect.gen(function* () {
    const resolved = yield* optionalFilePromise(() => realpath(target));
    if (resolved === undefined || resolved === root)
      return { outcome: "missing" };
    if (!isWithinRoot(root, resolved)) return { outcome: "forbidden" };

    const owned = yield* Effect.acquireRelease(
      optionalFilePromise(() =>
        open(resolved, fsConstants.O_RDONLY | fsConstants.O_NONBLOCK),
      ).pipe(
        Effect.flatMap((handle) =>
          handle === undefined
            ? Effect.fail(undefined)
            : Effect.succeed({ handle, transferredToStream: false }),
        ),
      ),
      closeOwnedFile,
    ).pipe(Effect.catch(() => Effect.void));
    if (owned === undefined) return { outcome: "missing" };

    const openedMetadata = yield* optionalFilePromise(() =>
      owned.handle.stat({ bigint: true }),
    );
    if (openedMetadata === undefined || !openedMetadata.isFile())
      return { outcome: "missing" };

    const resolvedAfterOpen = yield* optionalFilePromise(() =>
      realpath(resolved),
    );
    if (resolvedAfterOpen === undefined) return { outcome: "missing" };
    if (!isWithinRoot(root, resolvedAfterOpen)) return { outcome: "forbidden" };

    const currentMetadata = yield* optionalFilePromise(() =>
      stat(resolvedAfterOpen, { bigint: true }),
    );
    if (currentMetadata === undefined) return { outcome: "missing" };
    if (
      currentMetadata.dev !== openedMetadata.dev ||
      currentMetadata.ino !== openedMetadata.ino
    )
      return { outcome: "changed" };
    return { outcome: "file", owned, metadata: openedMetadata };
  });
}

function streamAuthorizedFile(
  opened: Extract<AuthorizedFile, { readonly outcome: "file" }>,
  response: ServerResponse,
): Effect.Effect<void> {
  return Effect.callback<void>((resume, signal) => {
    let stream: ReturnType<FileHandle["createReadStream"]> | undefined;
    const destroy = (): void => {
      if (stream !== undefined && !stream.destroyed) stream.destroy();
      if (!response.destroyed) response.destroy();
    };
    try {
      stream = opened.owned.handle.createReadStream({
        autoClose: true,
        end: Number(opened.metadata.size - 1n),
      });
      opened.owned.transferredToStream = true;
      stream.once("error", () => response.destroy());
      stream.once("close", () => resume(Effect.void));
      response.once("close", () => {
        if (stream !== undefined && !stream.destroyed) stream.destroy();
      });
      if (signal.aborted) destroy();
      else stream.pipe(response);
    } catch (cause) {
      destroy();
      resume(Effect.die(cause));
    }
    return Effect.sync(destroy);
  });
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
        yield* Effect.sync(() => {
          if (responseDeadlines.has(request.socket)) return;
          const responseDeadline = setTimeout(
            () => request.socket.destroy(),
            options.responseDeadlineMilliseconds,
          );
          responseDeadline.unref();
          responseDeadlines.set(request.socket, responseDeadline);
          request.socket.once("close", () => {
            clearTimeout(responseDeadline);
            responseDeadlines.delete(request.socket);
          });
        });

        if (!isExpectedAuthority(request, options.hostname))
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

        const modified = new Date(Number(opened.metadata.mtimeNs / 1_000_000n));
        const tag = etag(
          opened.metadata.size,
          opened.metadata.mtimeNs,
          opened.metadata.ino,
        );
        const headers = {
          "content-type":
            contentType(path.extname(target)) || "application/octet-stream",
          "content-length": opened.metadata.size.toString(),
          "last-modified": modified.toUTCString(),
          etag: tag,
          "x-content-type-options": "nosniff",
          "cross-origin-resource-policy": "same-origin",
        };

        if (isNotModified(request, tag, modified))
          return yield* Effect.sync(() => {
            response.writeHead(304, {
              etag: tag,
              "last-modified": modified.toUTCString(),
              "x-content-type-options": "nosniff",
            });
            response.end();
          });

        yield* Effect.sync(() => response.writeHead(200, headers));
        if (request.method === "HEAD" || opened.metadata.size === 0n)
          return yield* Effect.sync(() => response.end());
        return yield* streamAuthorizedFile(opened, response);
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

function closeServer(server: Server): Effect.Effect<void> {
  return Effect.callback<void>((resume) => {
    try {
      server.close((error) =>
        resume(
          error === undefined
            ? Effect.void
            : reportCleanupFailure("content listener"),
        ),
      );
      server.closeAllConnections();
    } catch {
      resume(Effect.void);
    }
  });
}

function listen(server: Server): Effect.Effect<void, ContentListenerError> {
  return Effect.callback<void, ContentListenerError>((resume) => {
    const onError = (cause: Error): void =>
      resume(Effect.fail(contentStartFailure(cause)));
    server.once("error", onError);
    try {
      server.listen({ host: loopbackAddress, port: 0 }, () => {
        server.off("error", onError);
        resume(Effect.void);
      });
    } catch (cause) {
      server.off("error", onError);
      resume(Effect.fail(contentStartFailure(cause)));
    }
    return Effect.sync(() => {
      server.off("error", onError);
      try {
        server.close();
      } catch {
        // The scoped server finalizer remains authoritative.
      }
    });
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
    const responseDeadlineMilliseconds =
      options.responseDeadlineMilliseconds !== undefined &&
      Number.isFinite(options.responseDeadlineMilliseconds) &&
      options.responseDeadlineMilliseconds > 0
        ? options.responseDeadlineMilliseconds
        : defaultResponseDeadlineMilliseconds;
    const requests = yield* FiberSet.make<void, never>();
    const runRequest = yield* FiberSet.runtime(requests)<never>();
    const handler = createStaticHandler(grant, {
      hostname,
      responseDeadlineMilliseconds,
    });
    const server = yield* Effect.acquireRelease(
      Effect.try({
        try: () =>
          createServer((request, response) => {
            runRequest(
              handler(request, response).pipe(
                Effect.catchCause(() =>
                  Effect.sync(() => {
                    if (!response.destroyed) response.destroy();
                  }),
                ),
              ),
            );
          }),
        catch: contentStartFailure,
      }),
      closeServer,
    );
    yield* Effect.sync(() => {
      server.maxConnections = 100;
      server.maxHeadersCount = 100;
      server.headersTimeout = 5_000;
      server.requestTimeout = 30_000;
      server.keepAliveTimeout = 5_000;
      server.maxRequestsPerSocket = 100;
      server.setTimeout(30_000, (socket) => socket.destroy());
    });
    yield* listen(server);
    const address = server.address();
    if (address === null || typeof address === "string")
      return yield* contentStartFailure(
        new Error("Static server did not receive a TCP address"),
      );
    const origin = `http://${hostname}:${address.port}`;
    return {
      bindAddress: loopbackAddress,
      hostname,
      port: address.port,
      origin,
      url: `${origin}${grant.entryUrlPath}`,
    };
  });
}
