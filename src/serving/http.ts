import { randomBytes } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { open, realpath, stat } from "node:fs/promises";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import path from "node:path";
import { contentType } from "mime-types";
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
  close(): Promise<void>;
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

async function openAuthorizedFile(root: string, target: string) {
  let resolved: string;
  try {
    resolved = await realpath(target);
  } catch {
    return { outcome: "missing" as const };
  }
  if (resolved === root) return { outcome: "missing" as const };
  if (!isWithinRoot(root, resolved)) return { outcome: "forbidden" as const };

  let handle;
  try {
    handle = await open(
      resolved,
      fsConstants.O_RDONLY | fsConstants.O_NONBLOCK,
    );
    const openedMetadata = await handle.stat({ bigint: true });
    if (!openedMetadata.isFile()) {
      await handle.close();
      return { outcome: "missing" as const };
    }

    const resolvedAfterOpen = await realpath(resolved);
    if (!isWithinRoot(root, resolvedAfterOpen)) {
      await handle.close();
      return { outcome: "forbidden" as const };
    }
    const currentMetadata = await stat(resolvedAfterOpen, { bigint: true });
    if (
      currentMetadata.dev !== openedMetadata.dev ||
      currentMetadata.ino !== openedMetadata.ino
    ) {
      await handle.close();
      return { outcome: "changed" as const };
    }
    return { outcome: "file" as const, handle, metadata: openedMetadata };
  } catch {
    if (handle !== undefined) await handle.close().catch(() => undefined);
    return { outcome: "missing" as const };
  }
}

export function createStaticHandler(
  grant: ServingGrant,
  options: StaticHandlerOptions,
) {
  return async (
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> => {
    if (!responseDeadlines.has(request.socket)) {
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
    }

    if (!isExpectedAuthority(request, options.hostname)) {
      send(response, 421, "Misdirected Request");
      return;
    }
    if (request.method !== "GET" && request.method !== "HEAD") {
      send(response, 405, "Method Not Allowed", { allow: "GET, HEAD" });
      return;
    }
    const segments = decodeRequestPath(request.url);
    if (segments === undefined) {
      send(response, 400, "Malformed request path");
      return;
    }

    const target = path.join(grant.root, ...segments);
    const opened = await openAuthorizedFile(grant.root, target);
    if (opened.outcome === "forbidden") {
      send(response, 403, "Forbidden");
      return;
    }
    if (opened.outcome === "changed") {
      send(response, 409, "File changed during authorization");
      return;
    }
    if (opened.outcome === "missing") {
      send(response, 404, "Not Found");
      return;
    }
    if (opened.metadata.size > BigInt(Number.MAX_SAFE_INTEGER) + 1n) {
      await opened.handle.close();
      send(response, 413, "File exceeds the supported size");
      return;
    }

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

    if (isNotModified(request, tag, modified)) {
      await opened.handle.close();
      response.writeHead(304, {
        etag: tag,
        "last-modified": modified.toUTCString(),
        "x-content-type-options": "nosniff",
      });
      response.end();
      return;
    }

    response.writeHead(200, headers);
    if (request.method === "HEAD") {
      await opened.handle.close();
      response.end();
      return;
    }
    if (opened.metadata.size === 0n) {
      await opened.handle.close();
      response.end();
      return;
    }
    const stream = opened.handle.createReadStream({
      autoClose: true,
      end: Number(opened.metadata.size - 1n),
    });
    stream.on("error", () => response.destroy());
    response.on("close", () => {
      if (!stream.destroyed) stream.destroy();
    });
    stream.pipe(response);
  };
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => (error === undefined ? resolve() : reject(error)));
    server.closeAllConnections();
  });
}

export function generateSessionHostname(): string {
  return `h-${randomBytes(16).toString("hex")}.localhost`;
}

export async function startStaticServer(
  grant: ServingGrant,
  options: {
    readonly hostname?: string;
    readonly responseDeadlineMilliseconds?: number;
  } = {},
): Promise<StaticSessionServer> {
  const hostname = options.hostname ?? generateSessionHostname();
  const responseDeadlineMilliseconds =
    options.responseDeadlineMilliseconds !== undefined &&
    Number.isFinite(options.responseDeadlineMilliseconds) &&
    options.responseDeadlineMilliseconds > 0
      ? options.responseDeadlineMilliseconds
      : defaultResponseDeadlineMilliseconds;
  const server = createServer(
    createStaticHandler(grant, { hostname, responseDeadlineMilliseconds }),
  );
  server.maxConnections = 100;
  server.maxHeadersCount = 100;
  server.headersTimeout = 5_000;
  server.requestTimeout = 30_000;
  server.keepAliveTimeout = 5_000;
  server.maxRequestsPerSocket = 100;
  server.setTimeout(30_000, (socket) => socket.destroy());

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen({ host: loopbackAddress, port: 0 }, resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    await closeServer(server);
    throw new Error("Static server did not receive a TCP address");
  }
  const origin = `http://${hostname}:${address.port}`;
  return {
    bindAddress: loopbackAddress,
    hostname,
    port: address.port,
    origin,
    url: `${origin}${grant.entryUrlPath}`,
    close: () => closeServer(server),
  };
}
