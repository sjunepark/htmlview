import {
  Agent,
  request,
  type ClientRequest,
  type IncomingMessage,
} from "node:http";
import type { Socket } from "node:net";
import { expect, it } from "@effect/vitest";
import { Effect, Exit, Scope } from "effect";
import { startLoopbackHttpListener } from "../src/serving/listener.js";

it.effect("the scoped loopback listener owns admitted request fibers", () =>
  Effect.acquireUseRelease(
    Scope.make(),
    (scope) =>
      Effect.gen(function* () {
        let finalized = false;
        const listener = yield* Scope.provide(scope)(
          startLoopbackHttpListener((_request, response) =>
            Effect.sync(() => {
              response.writeHead(200, { "content-type": "text/plain" });
              response.flushHeaders();
            }).pipe(
              Effect.andThen(Effect.never),
              Effect.ensuring(
                Effect.sync(() => {
                  finalized = true;
                }),
              ),
            ),
          ),
        );
        expect(listener.bindAddress).toBe("127.0.0.1");

        let operation: ClientRequest | undefined;
        let response: IncomingMessage | undefined;
        yield* Effect.promise(
          () =>
            new Promise<void>((resolve, reject) => {
              operation = request(
                {
                  hostname: listener.bindAddress,
                  port: listener.port,
                  path: "/",
                },
                (incoming) => {
                  response = incoming;
                  incoming.pause();
                  resolve();
                },
              );
              operation.once("error", reject);
              operation.end();
            }),
        );

        const closed = new Promise<void>((resolve) =>
          response?.once("close", resolve),
        );
        yield* Scope.close(scope, Exit.void);
        yield* Effect.promise(() => closed);
        expect(finalized).toBe(true);
        expect(response?.destroyed).toBe(true);
        operation?.destroy();
      }),
    (scope) => Scope.close(scope, Exit.void),
  ),
);

it.effect("each keep-alive response receives a fresh absolute deadline", () =>
  Effect.acquireUseRelease(
    Scope.make(),
    (scope) =>
      Effect.gen(function* () {
        const listener = yield* Scope.provide(scope)(
          startLoopbackHttpListener(
            (incoming, response) =>
              (incoming.url === "/slow"
                ? Effect.promise(
                    () =>
                      new Promise<void>((resolve) => setTimeout(resolve, 120)),
                  )
                : Effect.void
              ).pipe(
                Effect.andThen(
                  Effect.sync(() => {
                    response.end("ok");
                  }),
                ),
              ),
            { responseDeadlineMilliseconds: 200 },
          ),
        );
        const agent = new Agent({ keepAlive: true, maxSockets: 1 });
        yield* Scope.provide(scope)(
          Effect.addFinalizer(() =>
            Effect.sync(() => {
              agent.destroy();
            }),
          ),
        );
        const requestOnce = (pathname: string): Effect.Effect<Socket> =>
          Effect.promise(
            () =>
              new Promise<Socket>((resolve, reject) => {
                let socket: Socket | undefined;
                const operation = request(
                  {
                    agent,
                    hostname: listener.bindAddress,
                    port: listener.port,
                    path: pathname,
                  },
                  (response) => {
                    response.resume();
                    response.once("end", () =>
                      socket === undefined
                        ? reject(new Error("Request did not receive a socket"))
                        : resolve(socket),
                    );
                  },
                );
                operation.once("socket", (assigned) => {
                  socket = assigned;
                });
                operation.once("error", reject);
                operation.end();
              }),
          );

        const firstSocket = yield* requestOnce("/first");
        yield* Effect.promise(
          () => new Promise<void>((resolve) => setTimeout(resolve, 150)),
        );
        const secondSocket = yield* requestOnce("/slow");
        expect(secondSocket).toBe(firstSocket);
      }),
    (scope) => Scope.close(scope, Exit.void),
  ),
);
