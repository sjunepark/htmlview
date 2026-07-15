import { mkdtemp, mkdir, rm, truncate, writeFile } from "node:fs/promises";
import { request, type ClientRequest, type IncomingMessage } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it } from "@effect/vitest";
import { Effect, Exit, Scope } from "effect";
import { PathError } from "../src/errors.js";
import {
  resolveServingGrant,
  type ServingGrant,
} from "../src/serving/grant.js";
import { startStaticServer } from "../src/serving/http.js";

function withTemporaryGrant<A, E>(
  use: (grant: ServingGrant) => Effect.Effect<A, E, Scope.Scope>,
): Effect.Effect<A, E | PathError, Scope.Scope> {
  return Effect.acquireUseRelease(
    Effect.promise(() => mkdtemp(path.join(tmpdir(), "htmlview-effect-http-"))),
    (root) =>
      Effect.gen(function* () {
        yield* Effect.promise(() => mkdir(path.join(root, "assets")));
        yield* Effect.promise(() =>
          writeFile(path.join(root, "index.html"), "<!doctype html>"),
        );
        const grant = yield* resolveServingGrant("index.html", { cwd: root });
        return yield* use(grant);
      }),
    (root) => Effect.promise(() => rm(root, { recursive: true, force: true })),
  );
}

function requestStatus(
  port: number,
  hostname: string,
  requestPath: string,
): Effect.Effect<number | void> {
  return Effect.callback((resume) => {
    const operation = request(
      {
        hostname: "127.0.0.1",
        port,
        method: "HEAD",
        path: requestPath,
        headers: { host: `${hostname}:${port}` },
      },
      (response) => {
        response.resume();
        response.once("end", () => resume(Effect.succeed(response.statusCode)));
      },
    );
    operation.once("error", () => resume(Effect.void));
    operation.end();
    return Effect.sync(() => operation.destroy());
  });
}

it.effect("repeated listener scopes leave no reachable server", () =>
  withTemporaryGrant((grant) =>
    Effect.gen(function* () {
      for (let attempt = 0; attempt < 10; attempt += 1) {
        const scope = yield* Scope.make();
        const server = yield* Scope.provide(scope)(startStaticServer(grant));
        expect(
          yield* requestStatus(
            server.port,
            server.hostname,
            grant.entryUrlPath,
          ),
        ).toBe(200);
        yield* Scope.close(scope, Exit.void);
        expect(
          yield* requestStatus(
            server.port,
            server.hostname,
            grant.entryUrlPath,
          ),
        ).toBeUndefined();
      }
    }),
  ),
);

it.effect("closing the listener scope ends an active stream", () =>
  withTemporaryGrant((grant) =>
    Effect.acquireUseRelease(
      Scope.make(),
      (scope) =>
        Effect.gen(function* () {
          const large = path.join(grant.root, "assets", "large.bin");
          yield* Effect.promise(() => writeFile(large, ""));
          yield* Effect.promise(() => truncate(large, 64 * 1024 * 1024));
          const server = yield* Scope.provide(scope)(startStaticServer(grant));

          let operation: ClientRequest | undefined;
          let response: IncomingMessage | undefined;
          yield* Effect.promise(
            () =>
              new Promise<void>((resolve, reject) => {
                operation = request(
                  {
                    hostname: "127.0.0.1",
                    port: server.port,
                    path: "/assets/large.bin",
                    headers: { host: `${server.hostname}:${server.port}` },
                  },
                  (incoming) => {
                    response = incoming;
                    incoming.once("data", () => {
                      incoming.pause();
                      resolve();
                    });
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
          yield* Effect.promise(
            () =>
              new Promise<void>((resolve, reject) => {
                const timeout = setTimeout(
                  () => reject(new Error("Active stream remained open")),
                  1_000,
                );
                closed.then(() => {
                  clearTimeout(timeout);
                  resolve();
                }, reject);
              }),
          );
          expect(response?.destroyed).toBe(true);
          operation?.destroy();
        }),
      (scope) => Scope.close(scope, Exit.void),
    ),
  ),
);
