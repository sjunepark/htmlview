import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { Effect, FiberSet, type Scope } from "effect";
import { logDiagnostic } from "../diagnostics.js";
import { ContentListenerError } from "../errors.js";

const loopbackAddress = "127.0.0.1";
const defaultResponseDeadlineMilliseconds = 5 * 60_000;

export interface LoopbackHttpListener {
  readonly bindAddress: "127.0.0.1";
  readonly port: number;
}

export type LoopbackHttpHandler = (
  request: IncomingMessage,
  response: ServerResponse,
) => Effect.Effect<void>;

export function hasExactAuthority(
  request: IncomingMessage,
  hostname: string,
): boolean {
  const port = request.socket.localPort;
  if (port === undefined) return false;
  const hosts: string[] = [];
  for (let index = 0; index < request.rawHeaders.length; index += 2) {
    if (request.rawHeaders[index]?.toLowerCase() === "host")
      hosts.push(request.rawHeaders[index + 1] ?? "");
  }
  return hosts.length === 1 && hosts[0] === `${hostname}:${port}`;
}

function reportCleanupFailure(): Effect.Effect<void> {
  return logDiagnostic("Error", {
    operation: "http.cleanup",
    code: "runtime.internal",
    failureCount: 1,
  });
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
        resume(error === undefined ? Effect.void : reportCleanupFailure()),
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

function enforceResponseDeadline(
  request: IncomingMessage,
  response: ServerResponse,
  responseDeadlineMilliseconds: number,
): Effect.Effect<void> {
  return Effect.sync(() => {
    const responseDeadline = setTimeout(
      () => request.socket.destroy(),
      responseDeadlineMilliseconds,
    );
    responseDeadline.unref();
    const clearResponseDeadline = (): void => {
      clearTimeout(responseDeadline);
      response.off("finish", clearResponseDeadline);
      response.off("close", clearResponseDeadline);
    };
    response.once("finish", clearResponseDeadline);
    response.once("close", clearResponseDeadline);
  });
}

export function startLoopbackHttpListener(
  handler: LoopbackHttpHandler,
  options: { readonly responseDeadlineMilliseconds?: number } = {},
): Effect.Effect<LoopbackHttpListener, ContentListenerError, Scope.Scope> {
  return Effect.gen(function* () {
    const responseDeadlineMilliseconds =
      options.responseDeadlineMilliseconds !== undefined &&
      Number.isFinite(options.responseDeadlineMilliseconds) &&
      options.responseDeadlineMilliseconds > 0
        ? options.responseDeadlineMilliseconds
        : defaultResponseDeadlineMilliseconds;
    const requests = yield* FiberSet.make<void, never>();
    const runRequest = yield* FiberSet.runtime(requests)<never>();
    const server = yield* Effect.acquireRelease(
      Effect.try({
        try: () =>
          createServer((request, response) => {
            runRequest(
              enforceResponseDeadline(
                request,
                response,
                responseDeadlineMilliseconds,
              ).pipe(
                Effect.andThen(handler(request, response)),
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
    return {
      bindAddress: loopbackAddress,
      port: address.port,
    };
  });
}
