import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  rename,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { request } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import {
  resolveServingGrant,
  type ServingGrant,
} from "../src/serving/grant.js";
import {
  startStaticServer,
  type StaticSessionServer,
} from "../src/serving/http.js";

interface ResponseResult {
  readonly status: number;
  readonly headers: Record<string, string | string[] | undefined>;
  readonly body: Buffer;
}

let root: string;
let grant: ServingGrant;
let server: StaticSessionServer;

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

  it("never serves outside bytes while a symlink is swapped", async () => {
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
      for (let index = 0; index < 40; index += 1) {
        const replacement = `${link}.next`;
        await symlink(index % 2 === 0 ? outside : inside, replacement);
        await rename(replacement, link);
        const response = await rawRequest("/race.txt");
        assert.notEqual(response.body.toString(), "outside-secret");
        if (response.status === 200)
          assert.equal(response.body.toString(), "inside");
        else assert.ok([403, 404, 409].includes(response.status));
      }
    } finally {
      await unlink(outside);
    }
  });
});
