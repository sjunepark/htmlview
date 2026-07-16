import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { request } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { connect } from "node:net";
import { Script } from "node:vm";
import { describe, it } from "vitest";
import { Effect, Exit, Scope } from "effect";
import type {
  AnnotationDraft,
  PersistedReview,
} from "../src/annotation/model.js";
import type { AnnotationDraftInput } from "../src/annotation/registry.js";
import { ReviewError } from "../src/errors.js";
import { resolveServingGrant } from "../src/serving/grant.js";
import {
  generateReviewHostname,
  ReviewSurfaceState,
  startReviewOriginServer,
  type ReviewOriginServer,
  type ReviewSurfaceConfiguration,
} from "../src/serving/review.js";

interface ResponseResult {
  readonly status: number;
  readonly headers: Record<string, string | string[] | undefined>;
  readonly body: Buffer;
}

function send(
  server: ReviewOriginServer,
  method: string,
  requestPath: string,
  options: {
    readonly host?: string;
    readonly headers?: Record<string, string>;
    readonly body?: string | Buffer;
  } = {},
): Promise<ResponseResult> {
  return new Promise((resolve, reject) => {
    const operation = request(
      {
        hostname: "127.0.0.1",
        port: server.port,
        method,
        path: requestPath,
        headers: {
          host: options.host ?? `${server.hostname}:${server.port}`,
          ...options.headers,
        },
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.once("end", () =>
          resolve({
            status: response.statusCode ?? 0,
            headers: response.headers,
            body: Buffer.concat(chunks),
          }),
        );
      },
    );
    operation.once("error", reject);
    operation.end(options.body);
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

function holdResponse(
  server: ReviewOriginServer,
  requestPath: string,
): Promise<() => void> {
  return new Promise((resolve, reject) => {
    const operation = request(
      {
        hostname: "127.0.0.1",
        port: server.port,
        method: "GET",
        path: requestPath,
        headers: { host: `${server.hostname}:${server.port}` },
      },
      (response) => {
        response.pause();
        resolve(() => {
          response.destroy();
          operation.destroy();
        });
      },
    );
    operation.once("error", (error) => {
      if (!operation.destroyed) reject(error);
    });
    operation.end();
  });
}

const browserHeaders = {
  "sec-fetch-site": "same-origin",
  "sec-fetch-mode": "cors",
  "sec-fetch-dest": "empty",
};

interface TestSurface {
  readonly shell: ReviewOriginServer;
  readonly content: ReviewOriginServer;
  readonly configuration: ReviewSurfaceConfiguration;
  readonly state: ReviewSurfaceState;
  readonly queued: () => readonly AnnotationDraft[];
  readonly closeCount: () => number;
}

async function withSurface<A>(
  source: string | Buffer,
  use: (surface: TestSurface) => Promise<A>,
): Promise<A> {
  const parent = await mkdtemp(path.join(tmpdir(), "htmlview-review-"));
  const root = path.join(parent, "site");
  const entry = path.join(root, "report.html");
  await mkdir(root, { recursive: true });
  await writeFile(entry, source);
  await writeFile(path.join(root, "asset.txt"), "asset bytes");
  const grant = await Effect.runPromise(resolveServingGrant(entry, { root }));
  const scope = await Effect.runPromise(Scope.make());
  try {
    const state = new ReviewSurfaceState();
    const shell = await Effect.runPromise(
      Scope.provide(scope)(
        startReviewOriginServer("shell", {
          hostname: "r-0123456789abcdef0123456789abcdef.localhost",
          state,
        }),
      ),
    );
    const content = await Effect.runPromise(
      Scope.provide(scope)(
        startReviewOriginServer("content", {
          hostname: "c-0123456789abcdef0123456789abcdef.localhost",
          state,
        }),
      ),
    );
    let record: PersistedReview = {
      id: `rv_${"a".repeat(22)}`,
      identity: { root: grant.root, entry: grant.entryUrlPath },
      status: "ready",
      session: "session1",
      drafts: [],
      events: [],
      nextCursor: 1,
      acknowledgedCursor: 0,
      highestDeliveredCursor: 0,
    };
    let closes = 0;
    const configuration: ReviewSurfaceConfiguration = {
      reviewId: record.id,
      grant,
      shellOrigin: shell.origin,
      contentOrigin: content.origin,
      service: {
        record: () => record,
        queue: (input: AnnotationDraftInput) =>
          Effect.sync(() => {
            const id = `dr_${String(record.drafts.length + 1).padStart(22, "a")}`;
            const draft = { id, ...input } as AnnotationDraft;
            record = { ...record, drafts: [...record.drafts, draft] };
            return draft;
          }),
        send: (ids, options = {}) => {
          const selected = new Set(ids);
          if (ids.some((id) => !record.drafts.some((draft) => draft.id === id)))
            return Effect.fail(
              new ReviewError({
                code: "review.draft_not_found",
                message: "Draft not found",
              }),
            );
          const remaining = record.drafts.filter(
            (draft) => !selected.has(draft.id),
          );
          if (
            options.end === true &&
            remaining.length > 0 &&
            options.discardRemaining !== true
          )
            return Effect.fail(
              new ReviewError({
                code: "review.unsent_drafts",
                message: "Drafts remain",
              }),
            );
          const discarded =
            options.end === true && options.discardRemaining === true
              ? remaining.length
              : 0;
          record = {
            ...record,
            status: options.end === true ? "ended" : record.status,
            drafts:
              options.end === true && options.discardRemaining === true
                ? []
                : remaining,
          };
          return Effect.succeed({
            sent: ids.length,
            discarded,
            status: record.status,
          });
        },
        closeAfterEnd: Effect.sync(() => {
          closes += 1;
        }),
      },
    };
    state.configure(configuration);
    return await use({
      shell,
      content,
      configuration,
      state,
      queued: () => record.drafts,
      closeCount: () => closes,
    });
  } finally {
    await Effect.runPromise(Scope.close(scope, Exit.void));
    await rm(parent, { recursive: true, force: true });
  }
}

function jsonBody(response: ResponseResult): Record<string, unknown> {
  return JSON.parse(response.body.toString("utf8")) as Record<string, unknown>;
}

describe("review origins", () => {
  it(
    "holds the transform permit until a slow entry response closes",
    async () =>
      withSurface(
        Buffer.alloc(8 * 1024 * 1024, 0x20),
        async ({ content, configuration }) => {
          const release = await holdResponse(content, "/report.html");
          const second = send(content, "GET", "/report.html");
          await new Promise((resolve) => setTimeout(resolve, 50));
          await writeFile(
            configuration.grant.routeEntry,
            "<!doctype html><p>second transform</p>",
          );
          release();
          const response = await second;
          assert.equal(response.status, 200);
          assert.match(response.body.toString(), /second transform/);
        },
      ),
    20_000,
  );

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

  it("stays unavailable until configured and rejects ambiguous authority", async () => {
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
      assert.equal(
        (await send(shell, "HEAD", shell.readinessPath)).status,
        503,
      );
      assert.equal((await send(shell, "GET", "/")).status, 503);
      assert.equal(
        (
          await send(shell, "HEAD", shell.readinessPath, {
            host: `foreign.localhost:${shell.port}`,
          })
        ).status,
        421,
      );
      assert.equal(
        await rawStatus(
          shell.port,
          `HEAD ${shell.readinessPath} HTTP/1.1\r\nHost: ${shell.hostname}:${shell.port}\r\nHost: foreign.localhost:${shell.port}\r\nConnection: close\r\n\r\n`,
        ),
        421,
      );
    } finally {
      await Effect.runPromise(Scope.close(scope, Exit.void));
    }
  });

  it("serves an isolated immutable shell and a private state API", async () =>
    withSurface("<!doctype html><h1>Hello</h1>", async ({ shell, content }) => {
      const ready = await send(shell, "HEAD", shell.readinessPath);
      assert.equal(ready.status, 204);
      assert.equal(ready.body.length, 0);
      assert.equal(ready.headers["access-control-allow-origin"], undefined);

      const page = await send(shell, "GET", "/");
      assert.equal(page.status, 200);
      assert.match(
        String(page.headers["content-security-policy"]),
        new RegExp(`frame-src ${content.origin.replaceAll(".", "\\.")}`),
      );
      assert.equal(page.headers["x-frame-options"], "DENY");
      assert.equal(page.headers["referrer-policy"], "no-referrer");
      assert.equal(page.headers["access-control-allow-origin"], undefined);

      const script = await send(shell, "HEAD", "/.htmlview/shell.js");
      assert.equal(script.status, 200);
      assert.equal(script.body.length, 0);
      assert.equal(
        script.headers["cache-control"],
        "public, max-age=31536000, immutable",
      );
      const shellJavaScript = await send(shell, "GET", "/.htmlview/shell.js");
      assert.doesNotThrow(
        () => new Script(shellJavaScript.body.toString("utf8")),
      );

      assert.equal(
        (await send(shell, "GET", "/.htmlview/api/state")).status,
        403,
      );
      const state = await send(shell, "GET", "/.htmlview/api/state", {
        headers: browserHeaders,
      });
      assert.equal(state.status, 200);
      assert.equal(
        jsonBody(state).content_url,
        `${content.origin}/report.html`,
      );
      assert.equal(state.body.includes(Buffer.from("htmlview-review-")), false);
    }));

  it("rejects missing, wrong, and ambiguous browser mutation authority", async () =>
    withSurface("<!doctype html><h1>Hello</h1>", async ({ shell, content }) => {
      const endpoint = "/.htmlview/api/drafts";
      const valid = {
        ...browserHeaders,
        origin: shell.origin,
        "content-type": "application/json",
      };
      for (const name of [
        "origin",
        "sec-fetch-site",
        "sec-fetch-mode",
        "sec-fetch-dest",
        "content-type",
      ]) {
        const headers = { ...valid } as Record<string, string>;
        delete headers[name];
        assert.equal(
          (
            await send(shell, "POST", endpoint, {
              headers,
              body: "{}",
            })
          ).status,
          403,
          `missing ${name}`,
        );
      }
      for (const [name, values] of Object.entries({
        origin: [content.origin, `${shell.origin}/`, "null"],
        "sec-fetch-site": ["cross-site", "same-site", "none"],
        "sec-fetch-mode": ["navigate", "no-cors", "same-origin"],
        "sec-fetch-dest": ["document", "iframe", "script"],
        "content-type": [
          "text/plain",
          "Application/JSON",
          "application/json;charset=utf-8",
          "application/json; charset=UTF-8",
          "application/json; profile=test",
        ],
      }))
        for (const value of values) {
          const headers = { ...valid, [name]: value };
          assert.equal(
            (
              await send(shell, "POST", endpoint, {
                headers,
                body: "{}",
              })
            ).status,
            403,
            `${name}: ${value}`,
          );
        }

      for (const contentType of [
        "application/json",
        "application/json; charset=utf-8",
      ])
        assert.equal(
          (
            await send(shell, "POST", endpoint, {
              headers: { ...valid, "content-type": contentType },
              body: "{}",
            })
          ).status,
          400,
        );

      const duplicateCases = [
        ["Origin", shell.origin, "Origin", shell.origin],
        ["Sec-Fetch-Site", "same-origin", "Sec-Fetch-Site", "same-origin"],
        ["Sec-Fetch-Mode", "cors", "Sec-Fetch-Mode", "cors"],
        ["Sec-Fetch-Dest", "empty", "Sec-Fetch-Dest", "empty"],
        [
          "Content-Type",
          "application/json",
          "Content-Type",
          "application/json",
        ],
      ];
      const standard = [
        ["Origin", shell.origin],
        ["Sec-Fetch-Site", "same-origin"],
        ["Sec-Fetch-Mode", "cors"],
        ["Sec-Fetch-Dest", "empty"],
        ["Content-Type", "application/json"],
      ];
      for (const duplicate of duplicateCases) {
        const duplicateName = duplicate[0];
        const headers = standard
          .filter(([name]) => name !== duplicateName)
          .concat([
            [duplicate[0] ?? "", duplicate[1] ?? ""],
            [duplicate[2] ?? "", duplicate[3] ?? ""],
          ])
          .map(([name, value]) => `${name}: ${value}`)
          .join("\r\n");
        assert.equal(
          await rawStatus(
            shell.port,
            `POST ${endpoint} HTTP/1.1\r\nHost: ${shell.hostname}:${shell.port}\r\n${headers}\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}`,
          ),
          403,
          `duplicate ${duplicateName}`,
        );
      }

      for (const [name, value] of Object.entries({
        origin: `${shell.origin}, ${shell.origin}`,
        "sec-fetch-site": "same-origin, cross-site",
        "sec-fetch-mode": "cors, no-cors",
        "sec-fetch-dest": "empty, iframe",
        "content-type": "application/json, application/json",
      }))
        assert.equal(
          (
            await send(shell, "POST", endpoint, {
              headers: { ...valid, [name]: value },
              body: "{}",
            })
          ).status,
          403,
          `joined ${name}`,
        );

      assert.equal(
        (
          await send(shell, "POST", endpoint, {
            headers: {
              ...valid,
              host: `foreign.localhost:${shell.port}`,
            },
            body: "{}",
          })
        ).status,
        421,
      );
      assert.equal(
        await rawStatus(
          shell.port,
          `POST ${endpoint} HTTP/1.1\r\nHost: ${shell.hostname}:${shell.port}\r\nHost: foreign.localhost:${shell.port}\r\nOrigin: ${shell.origin}\r\nSec-Fetch-Site: same-origin\r\nSec-Fetch-Mode: cors\r\nSec-Fetch-Dest: empty\r\nContent-Type: application/json\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}`,
        ),
        421,
      );

      for (const route of [
        "/.htmlview/api/drafts",
        "/.htmlview/api/send",
        "/.htmlview/api/end",
      ]) {
        for (const method of ["GET", "PUT", "DELETE", "OPTIONS"])
          assert.equal(
            (await send(shell, method, route, { headers: valid })).status,
            405,
            `${method} ${route}`,
          );
        assert.equal(
          (
            await send(shell, "POST", `${route}?forged=1`, {
              headers: valid,
              body: "{}",
            })
          ).status,
          405,
          `query ${route}`,
        );
      }

      for (const [route, body] of [
        [
          "/.htmlview/api/drafts",
          {
            kind: "freeform",
            comment: "x",
            revision: `sha256:${"0".repeat(64)}`,
            review: "forged",
          },
        ],
        ["/.htmlview/api/send", { drafts: [], session: "forged" }],
        [
          "/.htmlview/api/end",
          { drafts: [], discard_remaining: true, root: "/forged" },
        ],
      ] as const)
        assert.equal(
          (
            await send(shell, "POST", route, {
              headers: valid,
              body: JSON.stringify(body),
            })
          ).status,
          400,
          `excess schema ${route}`,
        );

      const preflight = await send(shell, "OPTIONS", endpoint, {
        headers: {
          origin: content.origin,
          "access-control-request-method": "POST",
          "access-control-request-headers": "content-type",
        },
      });
      assert.equal(preflight.status, 405);
      assert.equal(preflight.headers["access-control-allow-origin"], undefined);
      assert.equal(
        preflight.headers["access-control-allow-methods"],
        undefined,
      );
      assert.equal(
        preflight.headers["access-control-allow-headers"],
        undefined,
      );
      assert.equal(
        preflight.headers["access-control-allow-credentials"],
        undefined,
      );
      const state = await send(shell, "GET", "/.htmlview/api/state", {
        headers: browserHeaders,
      });
      assert.deepEqual(jsonBody(state).drafts, []);
    }));

  it("instruments only the entry and validates every browser mutation", async () =>
    withSurface(
      "<!doctype html><html><body><h1>Hello</h1></body></html>",
      async ({ shell, content, configuration, queued, closeCount }) => {
        const entry = await send(content, "GET", "/report.html?theme=dark");
        assert.equal(entry.status, 200);
        assert.match(
          String(entry.headers["content-security-policy"]),
          new RegExp(
            `frame-ancestors ${configuration.shellOrigin.replaceAll(".", "\\.")}`,
          ),
        );
        const transformed = entry.body.toString("utf8");
        assert.match(transformed, /<h1>Hello<\/h1>/);
        assert.match(
          transformed,
          new RegExp(
            `src="${content.origin.replaceAll(".", "\\.")}\\/\\.htmlview\\/probe\\.js"`,
          ),
        );
        const revision = transformed.match(
          /data-htmlview-revision="(sha256:[0-9a-f]{64})"/,
        )?.[1];
        assert.ok(revision !== undefined);

        const asset = await send(content, "GET", "/asset.txt");
        assert.equal(asset.body.toString(), "asset bytes");
        assert.equal(
          (await send(content, "GET", "/.htmlview/authored.txt")).status,
          404,
        );
        assert.equal(
          (await send(content, "GET", "/.htmlview/probe.js?x=1")).status,
          404,
        );
        const probe = await send(content, "GET", "/.htmlview/probe.js");
        assert.doesNotThrow(() => new Script(probe.body.toString("utf8")));

        const mutationHeaders = {
          ...browserHeaders,
          origin: shell.origin,
          "content-type": "application/json",
        };
        const validDraft = JSON.stringify({
          kind: "freeform",
          comment: "Tighten this heading",
          revision,
        });
        assert.equal(
          (
            await send(shell, "POST", "/.htmlview/api/drafts", {
              headers: {
                ...browserHeaders,
                "content-type": "application/json",
              },
              body: validDraft,
            })
          ).status,
          403,
        );
        assert.equal(
          (
            await send(shell, "POST", "/.htmlview/api/drafts", {
              headers: mutationHeaders,
              body: JSON.stringify({ ...JSON.parse(validDraft), extra: true }),
            })
          ).status,
          400,
        );
        assert.equal(
          (
            await send(shell, "POST", "/.htmlview/api/drafts", {
              headers: mutationHeaders,
              body: JSON.stringify({
                ...JSON.parse(validDraft),
                revision: `sha256:${"f".repeat(64)}`,
              }),
            })
          ).status,
          409,
        );
        assert.equal(
          (
            await send(shell, "POST", "/.htmlview/api/drafts", {
              headers: mutationHeaders,
              body: "x".repeat(65 * 1024),
            })
          ).status,
          413,
        );

        const first = await send(shell, "POST", "/.htmlview/api/drafts", {
          headers: mutationHeaders,
          body: validDraft,
        });
        const second = await send(shell, "POST", "/.htmlview/api/drafts", {
          headers: mutationHeaders,
          body: validDraft,
        });
        assert.equal(first.status, 200);
        assert.equal(second.status, 200);
        assert.deepEqual(
          queued().map((draft) => draft.entry),
          ["/report.html", "/report.html"],
        );
        const firstId = (jsonBody(first).draft as { readonly id: string }).id;
        assert.equal(
          (
            await send(shell, "POST", "/.htmlview/api/end", {
              headers: mutationHeaders,
              body: JSON.stringify({
                drafts: [firstId],
                discard_remaining: false,
              }),
            })
          ).status,
          409,
        );
        const ended = await send(shell, "POST", "/.htmlview/api/end", {
          headers: mutationHeaders,
          body: JSON.stringify({
            drafts: [firstId],
            discard_remaining: true,
          }),
        });
        assert.deepEqual(jsonBody(ended), {
          sent: 1,
          discarded: 1,
          status: "ended",
        });
        await new Promise((resolve) => setImmediate(resolve));
        assert.equal(closeCount(), 1);
      },
    ));

  it("reports authored policy limitations without exposing the serving root", async () =>
    withSurface(
      '<!doctype html><meta http-equiv="content-security-policy" content="script-src \'none\'"><p>blocked</p>',
      async ({ shell, content }) => {
        const entry = await send(content, "GET", "/report.html");
        assert.equal(entry.status, 422);
        assert.match(entry.body.toString(), /csp_blocked/);
        const state = await send(shell, "GET", "/.htmlview/api/state", {
          headers: browserHeaders,
        });
        assert.equal(jsonBody(state).limitation, "csp_blocked");
        assert.equal(
          state.body.includes(Buffer.from("htmlview-review-")),
          false,
        );
      },
    ));
});
