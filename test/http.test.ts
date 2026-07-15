import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import {
  appendFile,
  mkdtemp,
  mkdir,
  open,
  rename,
  symlink,
  truncate,
  unlink,
  writeFile,
} from "node:fs/promises";
import { request } from "node:http";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { promisify } from "node:util";
import { Effect, Exit, Scope } from "effect";
import {
  isWithinRoot,
  resolveServingGrant as resolveServingGrantEffect,
  type ServingGrant,
} from "../src/serving/grant.js";
import {
  generateSessionHostname,
  startStaticServer as startStaticServerEffect,
  type StaticSessionServer,
} from "../src/serving/http.js";

interface ResponseResult {
  readonly status: number;
  readonly headers: Record<string, string | string[] | undefined>;
  readonly body: Buffer;
}

let root: string;
let grant: ServingGrant;
interface ManagedStaticSessionServer extends StaticSessionServer {
  close(): Promise<void>;
}

let server: ManagedStaticSessionServer;
const execute = promisify(execFile);

function resolveServingGrant(
  entry: string,
  options?: { readonly root?: string; readonly cwd?: string },
): Promise<ServingGrant> {
  return Effect.runPromise(resolveServingGrantEffect(entry, options));
}

async function startStaticServer(
  sessionGrant: ServingGrant,
  options?: {
    readonly hostname?: string;
    readonly responseDeadlineMilliseconds?: number;
  },
): Promise<ManagedStaticSessionServer> {
  const scope = await Effect.runPromise(Scope.make());
  try {
    const session = await Effect.runPromise(
      startStaticServerEffect(sessionGrant, options).pipe(
        Effect.provideService(Scope.Scope, scope),
      ),
    );
    let closePromise: Promise<void> | undefined;
    return {
      ...session,
      close: () =>
        (closePromise ??= Effect.runPromise(Scope.close(scope, Exit.void))),
    };
  } catch (error) {
    await Effect.runPromise(Scope.close(scope, Exit.void));
    throw error;
  }
}

function rawRequest(
  rawPath: string,
  options: {
    method?: string;
    host?: string;
    headers?: Record<string, string>;
  } = {},
): Promise<ResponseResult> {
  return new Promise((resolve, reject) => {
    const operation = request(
      {
        hostname: "127.0.0.1",
        port: server.port,
        method: options.method ?? "GET",
        path: rawPath,
        headers: {
          host: options.host ?? `${server.hostname}:${server.port}`,
          ...options.headers,
        },
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () =>
          resolve({
            status: response.statusCode ?? 0,
            headers: response.headers,
            body: Buffer.concat(chunks),
          }),
        );
      },
    );
    operation.once("error", reject);
    operation.end();
  });
}

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "htmlview-http-"));
  await mkdir(path.join(root, "pages"));
  await mkdir(path.join(root, "assets"));
  await writeFile(
    path.join(root, "pages", "report space ü.html"),
    Buffer.from("<!doctype html>\n<p>snow 雪</p>\n"),
  );
  await writeFile(
    path.join(root, "assets", "app.css"),
    "body { color: red }\n",
  );
  await writeFile(path.join(root, ".hidden"), "visible-by-grant\n");
  grant = await resolveServingGrant("pages/report space ü.html", {
    cwd: root,
    root,
  });
  server = await startStaticServer(grant, {
    hostname: "h-integration.localhost",
  });
});

afterEach(async () => {
  await server.close();
  const { rm } = await import("node:fs/promises");
  await rm(root, { recursive: true, force: true });
});

describe("faithful static HTTP", () => {
  it("uses only numeric loopback and generates unique 128-bit host labels", () => {
    assert.equal(server.bindAddress, "127.0.0.1");
    const names = new Set(
      Array.from({ length: 1_000 }, () => generateSessionHostname()),
    );
    assert.equal(names.size, 1_000);
    for (const name of names) assert.match(name, /^h-[0-9a-f]{32}\.localhost$/);
  });

  it("preserves root-containment properties for generated path shapes", () => {
    for (let index = 0; index < 500; index += 1) {
      const nested = path.join(root, `segment-${index}`, "asset.txt");
      const sibling = path.join(`${root}-sibling-${index}`, "asset.txt");
      const parent = path.resolve(root, "..", `outside-${index}.txt`);
      assert.equal(isWithinRoot(root, nested), true);
      assert.equal(isWithinRoot(root, sibling), false);
      assert.equal(isWithinRoot(root, parent), false);
      assert.equal(isWithinRoot(root, root), false);
    }
  });

  it("serves entry bytes, MIME, and security headers at the encoded relative path", async () => {
    const response = await rawRequest(
      "/pages/report%20space%20%C3%BC.html?mode=inspect",
    );
    assert.equal(response.status, 200);
    assert.deepEqual(
      response.body,
      await import("node:fs/promises").then(({ readFile }) =>
        readFile(grant.entry),
      ),
    );
    assert.equal(response.headers["content-type"], "text/html; charset=utf-8");
    assert.equal(
      response.headers["content-length"],
      String(response.body.length),
    );
    assert.equal(response.headers["x-content-type-options"], "nosniff");
    assert.equal(
      response.headers["cross-origin-resource-policy"],
      "same-origin",
    );
    assert.equal(response.headers["access-control-allow-origin"], undefined);
    assert.equal(response.headers.server, undefined);
  });

  it("supports HEAD and conditional requests", async () => {
    const first = await rawRequest(grant.entryUrlPath);
    const head = await rawRequest(grant.entryUrlPath, { method: "HEAD" });
    assert.equal(head.status, 200);
    assert.equal(head.body.length, 0);
    assert.equal(head.headers.etag, first.headers.etag);
    assert.equal(
      head.headers["content-length"],
      first.headers["content-length"],
    );

    const byTag = await rawRequest(grant.entryUrlPath, {
      headers: { "if-none-match": String(first.headers.etag) },
    });
    assert.equal(byTag.status, 304);
    assert.equal(byTag.body.length, 0);
    const byWeakTag = await rawRequest(grant.entryUrlPath, {
      headers: { "if-none-match": `W/${String(first.headers.etag)}` },
    });
    assert.equal(byWeakTag.status, 304);
    const byDate = await rawRequest(grant.entryUrlPath, {
      headers: { "if-modified-since": String(first.headers["last-modified"]) },
    });
    assert.equal(byDate.status, 304);
  });

  it("serves root-relative, hidden, unreferenced, and in-root symlinked files", async () => {
    await symlink(
      path.join(root, "assets", "app.css"),
      path.join(root, "linked.css"),
    );
    for (const [url, expected] of [
      ["/assets/app.css", "body { color: red }\n"],
      ["/.hidden", "visible-by-grant\n"],
      ["/linked.css", "body { color: red }\n"],
    ] as const) {
      const response = await rawRequest(url);
      assert.equal(response.status, 200);
      assert.equal(response.body.toString(), expected);
    }
  });

  it("selects MIME types for web assets without sniffing", async () => {
    const expectedTypes = {
      "module.js": "text/javascript; charset=utf-8",
      "data.json": "application/json; charset=utf-8",
      "image.svg": "image/svg+xml",
      "font.woff2": "font/woff2",
      "pixel.png": "image/png",
      "clip.mp4": "video/mp4",
    } as const;
    for (const [name, expectedType] of Object.entries(expectedTypes)) {
      await writeFile(path.join(root, "assets", name), "fixture");
      const response = await rawRequest(`/assets/${name}`);
      assert.equal(response.status, 200);
      assert.equal(response.headers["content-type"], expectedType, name);
    }
  });

  it("observes file changes without restarting", async () => {
    const file = path.join(root, "assets", "app.css");
    assert.equal(
      (await rawRequest("/assets/app.css")).body.toString(),
      "body { color: red }\n",
    );
    await writeFile(file, "body { color: blue }\n");
    assert.equal(
      (await rawRequest("/assets/app.css")).body.toString(),
      "body { color: blue }\n",
    );
  });

  it("rejects malformed paths, traversal, separators, and NULs", async () => {
    for (const malicious of [
      "/../outside.txt",
      "/%2e%2e/outside.txt",
      "/%2E%2E/outside.txt",
      "/assets%2F..%2Foutside.txt",
      "/assets%5C..%5Coutside.txt",
      "/assets\\..\\outside.txt",
      "/%C0%AFoutside.txt",
      "/bad%00name",
    ]) {
      const response = await rawRequest(malicious);
      assert.equal(response.status, 400, malicious);
    }
    assert.equal((await rawRequest("/%252e%252e/outside.txt")).status, 404);
  });

  it("rejects generated single-decode traversal and malformed encodings", async () => {
    const dot = [".", "%2e", "%2E"];
    const separators = ["/", "%2f", "%2F", "%5c", "%5C", "\\"];
    const candidates = new Set<string>();
    for (const left of dot) {
      for (const right of dot) {
        for (const separator of separators) {
          candidates.add(`/safe${separator}${left}${right}/outside.txt`);
        }
      }
    }
    for (let byte = 0; byte < 32; byte += 1)
      candidates.add(`/bad%${byte.toString(16).padStart(2, "0")}`);
    candidates.add("/bad%");
    candidates.add("/bad%GG");
    candidates.add("/%F0%28%8C%28");

    for (const candidate of candidates) {
      assert.equal((await rawRequest(candidate)).status, 400, candidate);
    }
  });

  it("round-trips generated encoded Unicode and delimiter filenames", async () => {
    const pieces = ["雪", "한글", "😀", "space name", "a,b", "x#y", "q?z"];
    for (let index = 0; index < 70; index += 1) {
      const name = `${index}-${pieces[index % pieces.length]}.txt`;
      const contents = `value-${index}-${name}`;
      await writeFile(path.join(root, "assets", name), contents);
      const response = await rawRequest(`/assets/${encodeURIComponent(name)}`);
      assert.equal(response.status, 200, name);
      assert.equal(response.body.toString(), contents, name);
    }
  });

  it("rejects symlink escape and directories", async () => {
    const outside = path.join(
      path.dirname(root),
      `outside-${path.basename(root)}.txt`,
    );
    await writeFile(outside, "outside-secret");
    await symlink(outside, path.join(root, "escape.txt"));
    try {
      assert.equal((await rawRequest("/escape.txt")).status, 403);
      assert.equal((await rawRequest("/assets")).status, 404);
      assert.equal((await rawRequest("/")).status, 404);
    } finally {
      await unlink(outside);
    }
  });

  it("rejects FIFOs without blocking filesystem workers", async () => {
    const fifo = path.join(root, "assets", "blocked.fifo");
    await execute("mkfifo", [fifo]);
    let releasedBlockedReader = false;
    let releasePromise = Promise.resolve();
    const release = setTimeout(() => {
      releasedBlockedReader = true;
      releasePromise = open(fifo, fsConstants.O_WRONLY | fsConstants.O_NONBLOCK)
        .then((handle) => handle.close())
        .catch(() => undefined);
    }, 1_000);

    const response = await rawRequest("/assets/blocked.fifo");
    clearTimeout(release);
    await releasePromise;
    assert.equal(releasedBlockedReader, false);
    assert.equal(response.status, 404);
    assert.equal((await rawRequest(grant.entryUrlPath)).status, 200);
  });

  it("rejects forged hosts and unsupported methods", async () => {
    assert.equal(
      (
        await rawRequest(grant.entryUrlPath, {
          host: `evil.localhost:${server.port}`,
        })
      ).status,
      421,
    );
    const post = await rawRequest(grant.entryUrlPath, { method: "POST" });
    assert.equal(post.status, 405);
    assert.equal(post.headers.allow, "GET, HEAD");
  });

  it("never serves outside bytes during concurrent symlink swaps", async () => {
    const inside = path.join(root, "inside.txt");
    const outside = path.join(
      path.dirname(root),
      `outside-race-${path.basename(root)}.txt`,
    );
    const link = path.join(root, "race.txt");
    await writeFile(inside, "inside");
    await writeFile(outside, "outside-secret");
    await symlink(inside, link);
    try {
      const swaps = (async () => {
        for (let index = 0; index < 80; index += 1) {
          const replacement = `${link}.next`;
          await symlink(index % 2 === 0 ? outside : inside, replacement);
          await rename(replacement, link);
        }
      })();
      const responses = await Promise.all(
        Array.from({ length: 80 }, () => rawRequest("/race.txt")),
      );
      await swaps;
      for (const response of responses) {
        assert.notEqual(response.body.toString(), "outside-secret");
        if (response.status === 200)
          assert.equal(response.body.toString(), "inside");
        else assert.ok([403, 404, 409].includes(response.status));
      }
    } finally {
      await unlink(outside);
    }
  });

  it("streams a large file and remains healthy after an aborted reader", async () => {
    const contents = Buffer.alloc(2 * 1024 * 1024, 0x5a);
    await writeFile(path.join(root, "assets", "large.bin"), contents);
    const complete = await rawRequest("/assets/large.bin");
    assert.equal(complete.status, 200);
    assert.deepEqual(complete.body, contents);

    await new Promise<void>((resolve, reject) => {
      const operation = request(
        {
          hostname: "127.0.0.1",
          port: server.port,
          path: "/assets/large.bin",
          headers: { host: `${server.hostname}:${server.port}` },
        },
        (response) => {
          response.once("data", () => response.destroy());
          response.once("close", resolve);
        },
      );
      operation.once("error", reject);
      operation.end();
    });
    assert.equal((await rawRequest(grant.entryUrlPath)).status, 200);
  });

  it("does not stream bytes appended after response authorization", async () => {
    const file = path.join(root, "assets", "growing.bin");
    await writeFile(file, "");
    await truncate(file, 64 * 1024 * 1024);

    const result = await new Promise<{
      declared: number;
      received: number;
    }>((resolve, reject) => {
      const socket = connect(server.port, "127.0.0.1", () => {
        socket.write(
          `GET /assets/growing.bin HTTP/1.1\r\nHost: ${server.hostname}:${server.port}\r\nConnection: close\r\n\r\n`,
        );
      });
      let header = Buffer.alloc(0);
      let declared: number | undefined;
      let received = 0;
      let appended = false;
      let appendPromise = Promise.resolve();
      socket.on("data", (chunk: Buffer) => {
        if (!appended) {
          appended = true;
          socket.pause();
          appendPromise = appendFile(
            file,
            Buffer.alloc(4 * 1024 * 1024, 0x61),
          ).then(() => {
            socket.resume();
          });
        }
        if (declared !== undefined) {
          received += chunk.length;
          return;
        }
        header = Buffer.concat([header, chunk]);
        const separator = header.indexOf("\r\n\r\n");
        if (separator === -1) return;
        const match = header
          .subarray(0, separator)
          .toString("latin1")
          .match(/\r\ncontent-length: (\d+)/i);
        if (match?.[1] === undefined) {
          socket.destroy();
          reject(new Error("Response omitted Content-Length"));
          return;
        }
        declared = Number(match[1]);
        received += header.length - (separator + 4);
        header = Buffer.alloc(0);
      });
      socket.once("error", reject);
      socket.once("end", () => {
        void appendPromise.then(() => {
          if (declared === undefined)
            reject(new Error("Response ended before its headers"));
          else resolve({ declared, received });
        }, reject);
      });
    });

    assert.equal(result.declared, 64 * 1024 * 1024);
    assert.equal(result.received, result.declared);
  });

  it("ends a slow-progress response at its absolute deadline", async () => {
    const large = path.join(root, "assets", "deadline.bin");
    await writeFile(large, "");
    await truncate(large, 64 * 1024 * 1024);
    const bounded = await startStaticServer(grant, {
      hostname: "h-deadline.localhost",
      responseDeadlineMilliseconds: 50,
    });
    try {
      await new Promise<void>((resolve, reject) => {
        let received = 0;
        const timeout = setTimeout(
          () => reject(new Error("Slow response exceeded its deadline")),
          2_000,
        );
        const operation = request(
          {
            hostname: "127.0.0.1",
            port: bounded.port,
            path: "/assets/deadline.bin",
            headers: { host: `${bounded.hostname}:${bounded.port}` },
          },
          (response) => {
            response.on("data", (chunk: Buffer) => {
              received += chunk.length;
              response.pause();
              setTimeout(() => response.resume(), 10);
            });
          },
        );
        operation.once("socket", (socket) =>
          socket.once("close", () => {
            clearTimeout(timeout);
            assert.ok(received < 64 * 1024 * 1024);
            resolve();
          }),
        );
        operation.once("error", (error) => {
          clearTimeout(timeout);
          reject(error);
        });
        operation.end();
      });

      const status = await new Promise<number>((resolve, reject) => {
        const operation = request(
          {
            hostname: "127.0.0.1",
            port: bounded.port,
            path: grant.entryUrlPath,
            headers: { host: `${bounded.hostname}:${bounded.port}` },
          },
          (response) => {
            response.resume();
            response.once("end", () => resolve(response.statusCode ?? 0));
          },
        );
        operation.once("error", reject);
        operation.end();
      });
      assert.equal(status, 200);
    } finally {
      await bounded.close();
    }
  });
});
