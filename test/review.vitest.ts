import assert from "node:assert/strict";
import { request } from "node:http";
import { connect } from "node:net";
import { describe, it } from "vitest";
import { Effect, Exit, Scope } from "effect";
import {
  generateReviewHostname,
  startReviewOriginServer,
  type ReviewOriginServer,
} from "../src/serving/review.js";

interface ResponseResult {
  readonly status: number;
  readonly headers: Record<string, string | string[] | undefined>;
  readonly body: string;
}

function send(
  server: ReviewOriginServer,
  method: string,
  requestPath: string,
  host = `${server.hostname}:${server.port}`,
): Promise<ResponseResult> {
  return new Promise((resolve, reject) => {
    const operation = request(
      {
        hostname: "127.0.0.1",
        port: server.port,
        method,
        path: requestPath,
        headers: { host },
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.once("end", () =>
          resolve({
            status: response.statusCode ?? 0,
            headers: response.headers,
            body: Buffer.concat(chunks).toString(),
          }),
        );
      },
    );
    operation.once("error", reject);
    operation.end();
  });
}

function rawStatus(port: number, payload: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const socket = connect(port, "127.0.0.1", () => socket.end(payload));
    let response = "";
    socket.on("data", (chunk: Buffer) => {
      response += chunk.toString("latin1");
    });
    socket.once("error", reject);
    socket.once("end", () => {
      const match = response.match(/^HTTP\/1\.1 (\d{3})/);
      if (match?.[1] === undefined)
        reject(new Error("Review listener returned no HTTP status"));
      else resolve(Number(match[1]));
    });
  });
}

describe("provisional review origins", () => {
  it("generates distinct role-specific 128-bit authorities", () => {
    const shell = new Set(
      Array.from({ length: 500 }, () => generateReviewHostname("shell")),
    );
    const content = new Set(
      Array.from({ length: 500 }, () => generateReviewHostname("content")),
    );
    assert.equal(shell.size, 500);
    assert.equal(content.size, 500);
    for (const hostname of shell)
      assert.match(hostname, /^r-[0-9a-f]{32}\.localhost$/);
    for (const hostname of content)
      assert.match(hostname, /^c-[0-9a-f]{32}\.localhost$/);
  });

  it("exposes only exact-authority readiness before the browser UI exists", async () => {
    const scope = await Effect.runPromise(Scope.make());
    try {
      const shell = await Effect.runPromise(
        Scope.provide(scope)(
          startReviewOriginServer("shell", {
            hostname: "r-0123456789abcdef0123456789abcdef.localhost",
          }),
        ),
      );
      assert.equal(shell.bindAddress, "127.0.0.1");
      const ready = await send(shell, "HEAD", shell.readinessPath);
      assert.equal(ready.status, 204);
      assert.equal(ready.body, "");
      assert.equal(ready.headers["cache-control"], "no-store");
      assert.equal(ready.headers["access-control-allow-origin"], undefined);

      const wrongHost = await send(
        shell,
        "HEAD",
        shell.readinessPath,
        `c-0123456789abcdef0123456789abcdef.localhost:${shell.port}`,
      );
      assert.equal(wrongHost.status, 421);
      assert.equal(wrongHost.body, "");

      assert.equal(
        await rawStatus(
          shell.port,
          `HEAD ${shell.readinessPath} HTTP/1.1\r\nHost: ${shell.hostname}:${shell.port}\r\nHost: foreign.localhost:${shell.port}\r\nConnection: close\r\n\r\n`,
        ),
        421,
      );

      const noPlaceholderUi = await send(shell, "GET", "/");
      assert.equal(noPlaceholderUi.status, 404);
      assert.equal(noPlaceholderUi.body, "Not Found");
    } finally {
      await Effect.runPromise(Scope.close(scope, Exit.void));
    }
  });
});
