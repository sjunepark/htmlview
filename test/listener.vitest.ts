import { request, type ClientRequest, type IncomingMessage } from "node:http";
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
