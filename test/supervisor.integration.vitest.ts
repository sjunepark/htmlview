import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  readdir,
  rm,
  stat,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { createServer as createHttpServer, request } from "node:http";
import {
  connect as connectSocket,
  createServer as createNetServer,
} from "node:net";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "vitest";
import { Effect, Exit, Fiber, Scope } from "effect";
import {
  loadAnnotationState,
  saveAnnotationState,
} from "../src/annotation/store.js";
import { logDiagnostic } from "../src/diagnostics.js";
import { ContentListenerError } from "../src/errors.js";
import { resolveServingGrant } from "../src/serving/grant.js";
import { startStaticServer } from "../src/serving/http.js";
import { startReviewOriginServer } from "../src/serving/review.js";
import {
  ProcessStartError,
  SupervisorClient,
} from "../src/supervisor/client.js";
import { supervisorDiagnosticLayer } from "../src/supervisor/logging.js";
import {
  controlHost,
  maximumControlResponseBytes,
  maximumConcurrentSessions,
  supervisorProtocol,
} from "../src/supervisor/protocol.js";
import {
  startSupervisor,
  type RunningSupervisor,
  type SupervisorOptions,
} from "../src/supervisor/server.js";
import {
  acquireSupervisorLock,
  ensurePrivateStateDirectory,
  statePaths,
  writePrivateJson,
  type StatePaths,
} from "../src/supervisor/state.js";
import { htmlviewVersion } from "../src/version.js";

const temporaryDirectories: string[] = [];
const supervisors: RunningSupervisor[] = [];

function runEffect<A, E>(effect: Effect.Effect<A, E>): Promise<A> {
  return Effect.runPromise(effect);
}

async function acquireTestLock(
  paths: StatePaths,
  timeoutMilliseconds?: number,
): Promise<{ readonly nonce: string; release(): Promise<void> }> {
  const scope = await Effect.runPromise(Scope.make());
  try {
    const lock = await Effect.runPromise(
      Scope.provide(scope)(acquireSupervisorLock(paths, timeoutMilliseconds)),
    );
    return {
      nonce: lock.nonce,
      release: () => Effect.runPromise(Scope.close(scope, Exit.void)),
    };
  } catch (error) {
    await Effect.runPromise(Scope.close(scope, Exit.void));
    throw error;
  }
}

async function temporaryDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

async function socketExists(paths: StatePaths): Promise<boolean> {
  try {
    await lstat(paths.controlSocket);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function setup(
  options: {
    readonly idleMilliseconds?: number;
    readonly maximumSessions?: number;
    readonly maximumReviews?: number;
    readonly version?: string;
    readonly beforeHealth?: () => Promise<void>;
    readonly startSessionServer?: SupervisorOptions["startSessionServer"];
    readonly startReviewOriginServer?: SupervisorOptions["startReviewOriginServer"];
  } = {},
): Promise<{
  paths: StatePaths;
  supervisor: RunningSupervisor;
  client: SupervisorClient;
  root: string;
  entry: string;
}> {
  const state = await temporaryDirectory("htmlview-state-parent-");
  const paths = statePaths({ HTMLVIEW_STATE_DIR: path.join(state, "state") });
  await Effect.runPromise(ensurePrivateStateDirectory(paths));
  const supervisor = await runEffect(
    startSupervisor({
      paths,
      idleMilliseconds: options.idleMilliseconds ?? 10_000,
      ...(options.maximumSessions === undefined
        ? {}
        : { maximumSessions: options.maximumSessions }),
      ...(options.maximumReviews === undefined
        ? {}
        : { maximumReviews: options.maximumReviews }),
      ...(options.version === undefined ? {} : { version: options.version }),
      ...(options.beforeHealth === undefined
        ? {}
        : { beforeHealth: options.beforeHealth }),
      ...(options.startSessionServer === undefined
        ? {}
        : { startSessionServer: options.startSessionServer }),
      ...(options.startReviewOriginServer === undefined
        ? {}
        : { startReviewOriginServer: options.startReviewOriginServer }),
    }),
  );
  supervisors.push(supervisor);
  const root = await temporaryDirectory("htmlview-session-");
  const entry = path.join(root, "report.html");
  await writeFile(entry, "<!doctype html><p>session</p>");
  return {
    paths,
    supervisor,
    client: new SupervisorClient(paths),
    root,
    entry,
  };
}

function controlRequest(
  paths: StatePaths,
  method: "GET" | "POST",
  route: string,
  body?: unknown,
  host = controlHost,
): Promise<{ status: number; value: unknown }> {
  return new Promise((resolve, reject) => {
    const payload =
      body === undefined ? undefined : Buffer.from(JSON.stringify(body));
    const operation = request(
      {
        socketPath: paths.controlSocket,
        method,
        path: route,
        headers: {
          host,
          ...(payload === undefined
            ? {}
            : {
                "content-type": "application/json",
                "content-length": String(payload.length),
              }),
        },
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          resolve({
            status: response.statusCode ?? 0,
            value: text === "" ? undefined : JSON.parse(text),
          });
        });
      },
    );
    operation.once("error", reject);
    if (payload !== undefined) operation.write(payload);
    operation.end();
  });
}

function abandonControlResponse(
  paths: StatePaths,
  route: string,
  body: unknown,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const payload = Buffer.from(JSON.stringify(body));
    const operation = request(
      {
        socketPath: paths.controlSocket,
        method: "POST",
        path: route,
        headers: {
          host: controlHost,
          "content-type": "application/json",
          "content-length": String(payload.length),
        },
      },
      (response) => {
        response.once("data", () => {
          response.destroy();
          operation.destroy();
          resolve();
        });
        response.once("error", () => undefined);
      },
    );
    operation.once("error", (error) => {
      if (!operation.destroyed) reject(error);
    });
    operation.end(payload);
  });
}

function rawHeaders(response: Response): Record<string, string | null> {
  return Object.fromEntries(
    [
      "content-type",
      "content-length",
      "last-modified",
      "etag",
      "cache-control",
      "x-content-type-options",
      "cross-origin-resource-policy",
      "access-control-allow-origin",
    ].map((name) => [name, response.headers.get(name)]),
  );
}

function rawControlStatus(paths: StatePaths, payload: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const socket = connectSocket(paths.controlSocket, () =>
      socket.end(payload),
    );
    let response = "";
    socket.on("data", (chunk: Buffer) => {
      response += chunk.toString("latin1");
    });
    socket.once("error", reject);
    socket.once("end", () => {
      const match = response.match(/^HTTP\/1\.1 (\d{3})/);
      if (match?.[1] === undefined)
        reject(new Error("Control listener returned no HTTP status"));
      else resolve(Number(match[1]));
    });
  });
}

afterEach(async () => {
  await Promise.all(
    supervisors.splice(0).map((supervisor) => runEffect(supervisor.close)),
  );
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("supervisor lifecycle", () => {
  it("converges concurrent first startup on one healthy owner", async () => {
    const parent = await temporaryDirectory("htmlview-first-start-");
    const paths = statePaths({
      HTMLVIEW_STATE_DIR: path.join(parent, "state"),
    });
    const root = await temporaryDirectory("htmlview-first-entry-");
    const entry = path.join(root, "report.html");
    await writeFile(entry, "first startup");
    let starts = 0;
    const start = (_: StatePaths, ownershipNonce: string) =>
      Effect.tryPromise({
        try: async () => {
          starts += 1;
          supervisors.push(
            await runEffect(startSupervisor({ paths, ownershipNonce })),
          );
        },
        catch: (cause) => new ProcessStartError({ cause }),
      });
    const firstClient = new SupervisorClient(paths, start);
    const secondClient = new SupervisorClient(paths, start);

    const [first, second] = await Promise.all([
      runEffect(firstClient.serve(entry, root)),
      runEffect(secondClient.serve(entry, root)),
    ]);
    assert.equal(starts, 1);
    assert.equal(first.session.id, second.session.id);
    assert.equal((await runEffect(secondClient.list())).length, 1);
  });

  it("creates one private control socket and reuses matching sessions", async () => {
    const { client, root, entry, paths } = await setup();
    const socketMetadata = await lstat(paths.controlSocket);
    assert.equal(socketMetadata.isSocket(), true);
    assert.equal(socketMetadata.mode & 0o777, 0o600);
    assert.equal((await stat(paths.directory)).mode & 0o777, 0o700);

    const results = await Promise.all([
      runEffect(client.serve(entry, root)),
      runEffect(client.serve(entry, root)),
      runEffect(client.serve(entry, root)),
    ]);
    assert.equal(new Set(results.map((result) => result.session.id)).size, 1);
    assert.equal(new Set(results.map((result) => result.session.url)).size, 1);
    assert.equal(results.filter((result) => result.reused).length, 2);
    assert.equal((await runEffect(client.list())).length, 1);
    assert.equal(
      await fetch(results[0]?.session.url ?? "").then((value) => value.text()),
      "<!doctype html><p>session</p>",
    );
  });

  it("creates reviews lazily, reuses live origins, and resumes stable identity", async () => {
    let reviewStarts = 0;
    const startReview: NonNullable<
      SupervisorOptions["startReviewOriginServer"]
    > = (role, state) => {
      reviewStarts += 1;
      return startReviewOriginServer(role, { state });
    };
    const { client, root, entry, paths, supervisor } = await setup({
      startReviewOriginServer: startReview,
    });
    const served = await runEffect(client.serve(entry, root));
    const beforeReviewResponse = await fetch(served.session.url);
    const beforeReview = {
      status: beforeReviewResponse.status,
      headers: rawHeaders(beforeReviewResponse),
      body: await beforeReviewResponse.text(),
    };
    assert.deepEqual(await runEffect(client.listState()), {
      sessions: [
        {
          id: served.session.id,
          status: "ready",
          url: served.session.url,
        },
      ],
      reviews: [],
    });
    assert.equal(reviewStarts, 0);

    const [first, concurrent] = await Promise.all([
      runEffect(client.review(served.session.id)),
      runEffect(client.review(served.session.id)),
    ]);
    assert.equal(first.review.id, concurrent.review.id);
    assert.equal(first.review.url, concurrent.review.url);
    assert.equal(
      [first.review.reused, concurrent.review.reused].filter(Boolean).length,
      1,
    );
    assert.equal(reviewStarts, 2);
    assert.match(
      first.review.url,
      /^http:\/\/r-[0-9a-f]{32}\.localhost:\d+\/$/,
    );
    assert.equal(first.session.url, served.session.url);
    assert.equal(first.grant.root, await realpath(root));
    assert.equal(first.fidelity, "instrumented_review");
    const afterReviewResponse = await fetch(served.session.url);
    assert.deepEqual(
      {
        status: afterReviewResponse.status,
        headers: rawHeaders(afterReviewResponse),
        body: await afterReviewResponse.text(),
      },
      beforeReview,
    );

    const state = await runEffect(client.listState());
    assert.deepEqual(state.reviews, [
      {
        id: first.review.id,
        status: "ready",
        session: served.session.id,
        drafts: 0,
        unacknowledged: 0,
      },
    ]);
    assert.equal(
      (await runEffect(loadAnnotationState(paths))).reviews[0]?.identity.entry,
      "/report.html",
    );

    await runEffect(client.stopSession(served.session.id));
    await assert.rejects(fetch(first.review.url));
    const stopped = await runEffect(client.listState());
    assert.equal(stopped.reviews[0]?.status, "stopped");
    assert.equal(stopped.reviews[0]?.session, served.session.id);

    const replacement = await runEffect(client.serve(entry, root));
    assert.notEqual(replacement.session.id, served.session.id);
    const resumed = await runEffect(client.review(replacement.session.id));
    assert.equal(resumed.review.id, first.review.id);
    assert.notEqual(resumed.review.url, first.review.url);
    assert.equal(resumed.review.reused, true);
    assert.equal(reviewStarts, 4);
    assert.equal(
      (await runEffect(client.listState())).reviews[0]?.session,
      replacement.session.id,
    );

    supervisors.splice(supervisors.indexOf(supervisor), 1);
    await runEffect(supervisor.close);
    const restarted = await runEffect(
      startSupervisor({
        paths,
        idleMilliseconds: 10_000,
        startReviewOriginServer: startReview,
      }),
    );
    supervisors.push(restarted);
    const afterRestart = await runEffect(client.serve(entry, root));
    const resumedAfterRestart = await runEffect(
      client.review(afterRestart.session.id),
    );
    assert.equal(resumedAfterRestart.review.id, first.review.id);
    assert.notEqual(resumedAfterRestart.review.url, resumed.review.url);
    assert.equal(resumedAfterRestart.review.reused, true);
    assert.equal(reviewStarts, 6);
  });

  it("serves cancellable feedback waits and idempotent review deletion", async () => {
    const { client, root, entry, paths } = await setup();
    const served = await runEffect(client.serve(entry, root));
    const review = await runEffect(client.review(served.session.id));
    assert.deepEqual(await runEffect(client.feedback(review.review.id)), {
      review: { id: review.review.id, status: "ready" },
      cursor: 0,
      count: 0,
      feedback: [],
    });

    const beforeCancellation = await runEffect(loadAnnotationState(paths));
    const cancelled = Effect.runFork(
      client.feedback(review.review.id, { wait: true }),
    );
    await new Promise((resolve) => setTimeout(resolve, 25));
    await runEffect(Fiber.interrupt(cancelled));
    await new Promise((resolve) => setTimeout(resolve, 25));
    const afterCancellation = await runEffect(loadAnnotationState(paths));
    assert.deepEqual(
      afterCancellation.reviews.map((record) => ({
        acknowledgedCursor: record.acknowledgedCursor,
        highestDeliveredCursor: record.highestDeliveredCursor,
        nextCursor: record.nextCursor,
        events: record.events,
      })),
      beforeCancellation.reviews.map((record) => ({
        acknowledgedCursor: record.acknowledgedCursor,
        highestDeliveredCursor: record.highestDeliveredCursor,
        nextCursor: record.nextCursor,
        events: record.events,
      })),
    );

    const waiting = runEffect(
      client.feedback(review.review.id, { wait: true }),
    );
    await new Promise((resolve) => setTimeout(resolve, 25));
    await assert.rejects(
      runEffect(client.feedback(review.review.id, { wait: true })),
      { code: "feedback.consumer_busy" },
    );
    await runEffect(client.stopSession(served.session.id));
    assert.deepEqual(await waiting, {
      review: { id: review.review.id, status: "stopped" },
      cursor: 0,
      count: 0,
      feedback: [],
    });

    const deleted = await runEffect(
      client.deleteReview(review.review.id, false),
    );
    assert.deepEqual(deleted, {
      delete: {
        review: review.review.id,
        deleted: 1,
        status: "deleted",
        discarded: { drafts: 0, feedback: 0 },
      },
    });
    assert.deepEqual(
      await runEffect(client.deleteReview(review.review.id, false)),
      deleted,
    );
    assert.deepEqual((await runEffect(client.listState())).reviews, []);
  });

  it("keeps a session live when its stopped review cannot be persisted", async () => {
    const { client, root, entry, paths } = await setup();
    const served = await runEffect(client.serve(entry, root));
    const review = await runEffect(client.review(served.session.id));
    await chmod(paths.annotationDirectory, 0o500);
    try {
      await assert.rejects(runEffect(client.stopSession(served.session.id)), {
        code: "state.unavailable",
      });
    } finally {
      await chmod(paths.annotationDirectory, 0o700);
    }

    assert.equal(
      await fetch(served.session.url).then((response) => response.status),
      200,
    );
    assert.equal(
      await fetch(review.review.url).then((response) => response.status),
      200,
    );
    const retained = await runEffect(client.listState());
    assert.equal(retained.sessions.length, 1);
    assert.equal(retained.reviews[0]?.status, "ready");

    assert.equal(
      (await runEffect(client.stopSession(served.session.id))).stopped,
      1,
    );
    await assert.rejects(fetch(served.session.url));
    await assert.rejects(fetch(review.review.url));
    assert.equal(
      (await runEffect(client.listState())).reviews[0]?.status,
      "stopped",
    );
  });

  it("keeps the supervisor live when stop-all cannot persist stopped reviews", async () => {
    const { client, root, entry, paths } = await setup();
    const served = await runEffect(client.serve(entry, root));
    const review = await runEffect(client.review(served.session.id));
    await chmod(paths.annotationDirectory, 0o500);
    try {
      await assert.rejects(runEffect(client.stopAll()), {
        code: "state.unavailable",
      });
    } finally {
      await chmod(paths.annotationDirectory, 0o700);
    }

    assert.equal(await socketExists(paths), true);
    assert.equal(
      await fetch(served.session.url).then((response) => response.status),
      200,
    );
    assert.equal(
      await fetch(review.review.url).then((response) => response.status),
      200,
    );
    const retained = await runEffect(client.listState());
    assert.equal(retained.sessions.length, 1);
    assert.equal(retained.reviews[0]?.status, "ready");

    assert.equal((await runEffect(client.stopAll())).stopped, 1);
    assert.equal(await socketExists(paths), false);
    await assert.rejects(fetch(served.session.url));
    await assert.rejects(fetch(review.review.url));
  });

  it("forces listener teardown before releasing ownership on direct close", async () => {
    const { client, root, entry, paths, supervisor } = await setup();
    const served = await runEffect(client.serve(entry, root));
    const review = await runEffect(client.review(served.session.id));
    supervisors.splice(supervisors.indexOf(supervisor), 1);
    await chmod(paths.annotationDirectory, 0o500);
    const closed = assert.rejects(runEffect(supervisor.closed), {
      _tag: "SupervisorLifecycleError",
      phase: "shutdown",
    });
    try {
      await assert.rejects(runEffect(supervisor.close), {
        _tag: "SupervisorLifecycleError",
        phase: "shutdown",
      });
      await closed;
    } finally {
      await chmod(paths.annotationDirectory, 0o700);
    }

    assert.equal(await socketExists(paths), false);
    await assert.rejects(lstat(paths.supervisorLock));
    await assert.rejects(fetch(served.session.url));
    await assert.rejects(fetch(review.review.url));
  });

  it("retries unacknowledged feedback after a transport response is lost", async () => {
    const parent = await temporaryDirectory("htmlview-feedback-loss-");
    const paths = statePaths({
      HTMLVIEW_STATE_DIR: path.join(parent, "state"),
    });
    await runEffect(ensurePrivateStateDirectory(paths));
    const reviewId = `rv_${"a".repeat(22)}`;
    const eventId = `fb_${"b".repeat(22)}`;
    await runEffect(
      saveAnnotationState(paths, {
        version: 1,
        reviews: [
          {
            id: reviewId,
            identity: { root: "/workspace", entry: "/report.html" },
            status: "stopped",
            session: "session1",
            drafts: [],
            events: [
              {
                id: eventId,
                position: 1,
                kind: "freeform",
                comment: "durable feedback",
                entry: "/report.html",
                revision: `sha256:${"0".repeat(64)}`,
              },
            ],
            nextCursor: 2,
            acknowledgedCursor: 0,
            highestDeliveredCursor: 0,
          },
        ],
        tombstones: [],
      }),
    );
    const supervisor = await runEffect(
      startSupervisor({ paths, idleMilliseconds: 10_000 }),
    );
    supervisors.push(supervisor);

    await abandonControlResponse(paths, "/feedback", {
      review: reviewId,
      wait: false,
    });

    const retry = await runEffect(
      new SupervisorClient(paths).feedback(reviewId),
    );
    assert.equal(retry.cursor, 1);
    assert.equal(retry.feedback[0]?.id, eventId);
    const persisted = await runEffect(loadAnnotationState(paths));
    assert.equal(persisted.reviews[0]?.acknowledgedCursor, 0);
    assert.equal(persisted.reviews[0]?.highestDeliveredCursor, 1);
    assert.equal(persisted.reviews[0]?.events[0]?.id, eventId);
  });

  it("maps opaque missing selectors to domain not-found errors", async () => {
    const { client } = await setup();
    await assert.rejects(runEffect(client.review("bad")), {
      code: "review.session_not_found",
    });
    await assert.rejects(runEffect(client.feedback("bad")), {
      code: "review.not_found",
    });
    await assert.rejects(runEffect(client.deleteReview("bad", false)), {
      code: "review.not_found",
    });
  });

  it("restarts on demand to make retained review state discoverable", async () => {
    const { client, root, entry, paths, supervisor } = await setup();
    const served = await runEffect(client.serve(entry, root));
    const review = await runEffect(client.review(served.session.id));
    await runEffect(client.stopAll());
    await runEffect(supervisor.closed);
    supervisors.splice(supervisors.indexOf(supervisor), 1);

    const retainedClient = new SupervisorClient(paths, (_, ownershipNonce) =>
      Effect.tryPromise({
        try: async () => {
          supervisors.push(
            await runEffect(startSupervisor({ paths, ownershipNonce })),
          );
        },
        catch: (cause) => new ProcessStartError({ cause }),
      }),
    );
    assert.deepEqual((await runEffect(retainedClient.listState())).reviews, [
      {
        id: review.review.id,
        status: "stopped",
        session: served.session.id,
        drafts: 0,
        unacknowledged: 0,
      },
    ]);
  });

  it("closes live review origins before deleting while leaving raw serving live", async () => {
    const { client, root, entry } = await setup();
    const served = await runEffect(client.serve(entry, root));
    const review = await runEffect(client.review(served.session.id));
    await runEffect(client.deleteReview(review.review.id, false));
    await assert.rejects(fetch(review.review.url));
    assert.equal(
      await fetch(served.session.url).then((response) => response.status),
      200,
    );
  });

  it("rolls back both-origin review acquisition and preserves capacity", async () => {
    let shellUrl: string | undefined;
    const { client, root, entry } = await setup({
      maximumReviews: 1,
      startReviewOriginServer: (role, state) =>
        role === "content"
          ? Effect.fail(
              new ContentListenerError({
                code: "http.start_failed",
                message: "The loopback content listener could not start",
              }),
            )
          : startReviewOriginServer(role, { state }).pipe(
              Effect.tap((server) =>
                Effect.sync(() => {
                  shellUrl = server.url;
                }),
              ),
            ),
    });
    const served = await runEffect(client.serve(entry, root));
    await assert.rejects(runEffect(client.review(served.session.id)), {
      code: "http.start_failed",
    });
    assert.deepEqual((await runEffect(client.listState())).reviews, []);
    assert.notEqual(shellUrl, undefined);
    await assert.rejects(fetch(shellUrl ?? ""));
  });

  it("bounds stalled review-origin acquisition and releases lifecycle mutation", async () => {
    const { client, root, entry } = await setup({
      startReviewOriginServer: () => Effect.never,
    });
    const served = await runEffect(client.serve(entry, root));
    await assert.rejects(runEffect(client.review(served.session.id)), {
      code: "http.readiness_failed",
    });
    assert.equal(
      (await runEffect(client.stopSession(served.session.id))).stopped,
      1,
    );
    assert.deepEqual((await runEffect(client.listState())).reviews, []);
  });

  it("closes review origins before their raw listener", async () => {
    const closed: string[] = [];
    const { client, root, entry } = await setup({
      startSessionServer: (grant) =>
        Effect.gen(function* () {
          yield* Effect.addFinalizer(() =>
            Effect.sync(() => {
              closed.push("raw");
            }),
          );
          return yield* startStaticServer(grant);
        }),
      startReviewOriginServer: (role, state) =>
        Effect.gen(function* () {
          yield* Effect.addFinalizer(() =>
            Effect.sync(() => {
              closed.push(role);
            }),
          );
          return yield* startReviewOriginServer(role, { state });
        }),
    });
    const served = await runEffect(client.serve(entry, root));
    await runEffect(client.review(served.session.id));
    await runEffect(client.stopSession(served.session.id));
    assert.equal(closed.at(-1), "raw");
    assert.deepEqual(
      new Set(closed.slice(0, -1)),
      new Set(["shell", "content"]),
    );
  });

  it("stops sessions idempotently and makes stop-all a complete shutdown", async () => {
    const { client, root, entry, paths } = await setup();
    const otherRoot = await temporaryDirectory("htmlview-session-other-");
    const otherEntry = path.join(otherRoot, "other.html");
    await writeFile(otherEntry, "other");
    const [first, second] = await Promise.all([
      runEffect(client.serve(entry, root)),
      runEffect(client.serve(otherEntry, otherRoot)),
    ]);
    assert.notEqual(first.session.id, second.session.id);
    assert.equal(
      (await runEffect(client.stopSession(first.session.id))).stopped,
      1,
    );
    assert.equal(
      (await runEffect(client.stopSession(first.session.id))).stopped,
      0,
    );
    assert.equal((await runEffect(client.stopAll())).stopped, 1);
    assert.equal(await socketExists(paths), false);
    await assert.rejects(fetch(second.session.url));
    assert.equal((await runEffect(client.stopAll())).stopped, 0);
  });

  it("uses the private socket directory for authorization", async () => {
    const { paths } = await setup();
    assert.equal(
      (await controlRequest(paths, "GET", "/sessions", undefined, "wrong"))
        .status,
      401,
    );
    assert.equal((await controlRequest(paths, "GET", "/sessions")).status, 200);
    assert.equal(
      await rawControlStatus(
        paths,
        `GET /sessions HTTP/1.1\r\nHost: ${controlHost}\r\nHost: duplicate\r\nConnection: close\r\n\r\n`,
      ),
      401,
    );
    assert.deepEqual((await readdir(paths.directory)).sort(), [
      "annotations",
      "control.sock",
      "supervisor.lock",
    ]);
  });

  it("rejects malformed successful responses at every client seam", async () => {
    const parent = await temporaryDirectory("hv-malformed-");
    const paths = statePaths({
      HTMLVIEW_STATE_DIR: path.join(parent, "s"),
    });
    await Effect.runPromise(ensurePrivateStateDirectory(paths));
    const root = await temporaryDirectory("htmlview-malformed-entry-");
    const entry = path.join(root, "report.html");
    await writeFile(entry, "<!doctype html>");

    const fake = createHttpServer((incoming, response) => {
      const route = new URL(incoming.url ?? "/", `http://${controlHost}`);
      const value =
        route.pathname === "/health"
          ? {
              protocol: supervisorProtocol,
              instanceId: randomUUID(),
              pid: process.pid,
              version: htmlviewVersion,
            }
          : incoming.method === "GET" && route.pathname === "/sessions"
            ? { sessions: [{ id: "invalid" }] }
            : incoming.method === "GET" && route.pathname === "/state"
              ? { sessions: [], reviews: [{ id: "invalid" }] }
              : route.pathname === "/sessions"
                ? { session: {}, reused: "no" }
                : route.pathname === "/reviews"
                  ? { review: {}, session: {} }
                  : route.pathname === "/stop"
                    ? { stopped: "one" }
                    : { stopped: maximumConcurrentSessions + 1 };
      const body = Buffer.from(JSON.stringify(value));
      response.writeHead(200, {
        "content-type": "application/json",
        "content-length": String(body.length),
      });
      response.end(body);
    });
    await new Promise<void>((resolve, reject) => {
      fake.once("error", reject);
      fake.listen(paths.controlSocket, resolve);
    });

    const client = new SupervisorClient(paths);
    const expected = {
      code: "supervisor.request_failed",
      message: "The htmlview supervisor returned an invalid response",
    };
    try {
      await assert.rejects(runEffect(client.list()), (error: unknown) => {
        assert.deepEqual(
          {
            code: (error as { readonly code?: unknown }).code,
            message: (error as { readonly message?: unknown }).message,
          },
          expected,
        );
        assert.equal(
          (error as { readonly cause?: { readonly _tag?: unknown } }).cause
            ?._tag,
          "ControlResponseSchemaError",
        );
        return true;
      });
      await assert.rejects(runEffect(client.listState()), expected);
      await assert.rejects(
        runEffect(client.serve(entry, await realpath(root))),
        expected,
      );
      await assert.rejects(runEffect(client.review("aB3_-xYz")), expected);
      await assert.rejects(runEffect(client.stopSession("missing")), expected);
      await assert.rejects(runEffect(client.stopAll()), expected);
    } finally {
      await new Promise<void>((resolve, reject) =>
        fake.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });

  it("bounds and parses control responses before schema decoding", async () => {
    const parent = await temporaryDirectory("hv-control-response-");
    const paths = statePaths({
      HTMLVIEW_STATE_DIR: path.join(parent, "state"),
    });
    await Effect.runPromise(ensurePrivateStateDirectory(paths));
    let oversized = false;
    const fake = createHttpServer((incoming, response) => {
      const route = new URL(incoming.url ?? "/", `http://${controlHost}`);
      if (route.pathname === "/health") {
        response.end(
          JSON.stringify({
            protocol: supervisorProtocol,
            instanceId: randomUUID(),
            pid: process.pid,
            version: htmlviewVersion,
          }),
        );
        return;
      }
      response.end(
        oversized
          ? JSON.stringify({
              padding: "x".repeat(maximumControlResponseBytes),
            })
          : "not-json",
      );
    });
    await new Promise<void>((resolve, reject) => {
      fake.once("error", reject);
      fake.listen(paths.controlSocket, resolve);
    });

    try {
      const client = new SupervisorClient(paths);
      await assert.rejects(runEffect(client.list()), {
        code: "supervisor.unavailable",
      });
      oversized = true;
      await assert.rejects(runEffect(client.list()), {
        code: "supervisor.unavailable",
      });
    } finally {
      await new Promise<void>((resolve, reject) =>
        fake.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });

  it("rejects valid-shaped responses that violate operation invariants", async () => {
    const parent = await temporaryDirectory("hv-invariant-");
    const paths = statePaths({
      HTMLVIEW_STATE_DIR: path.join(parent, "state"),
    });
    await Effect.runPromise(ensurePrivateStateDirectory(paths));
    const root = await temporaryDirectory("htmlview-invariant-entry-");
    const entry = path.join(root, "report.html");
    await writeFile(entry, "<!doctype html>");
    const session = {
      id: "aB3_-xYz",
      status: "ready",
      url: "http://h-0123456789abcdef0123456789abcdef.localhost:4321/report.html",
    };
    let value: unknown = { sessions: [session] };

    const fake = createHttpServer((incoming, response) => {
      const route = new URL(incoming.url ?? "/", `http://${controlHost}`);
      const responseValue =
        route.pathname === "/health"
          ? {
              protocol: supervisorProtocol,
              instanceId: randomUUID(),
              pid: process.pid,
              version: htmlviewVersion,
            }
          : value;
      const body = Buffer.from(JSON.stringify(responseValue));
      response.writeHead(200, {
        "content-type": "application/json",
        "content-length": String(body.length),
      });
      response.end(body);
    });
    await new Promise<void>((resolve, reject) => {
      fake.once("error", reject);
      fake.listen(paths.controlSocket, resolve);
    });

    const client = new SupervisorClient(paths);
    const expected = {
      code: "supervisor.request_failed",
      message: "The htmlview supervisor returned an invalid response",
    };
    try {
      await assert.rejects(runEffect(client.list(["root"])), expected);
      value = { sessions: [{ ...session, entry }] };
      await assert.rejects(runEffect(client.list()), expected);
      value = {
        sessions: [{ ...session, entry }],
        reviews: [],
      };
      await assert.rejects(runEffect(client.listState(["root"])), expected);
      value = {
        session: { ...session, entry: `${entry}.different`, root },
        reused: false,
      };
      await assert.rejects(runEffect(client.serve(entry, root)), expected);
      value = {
        review: {
          id: "rv_0123456789abcdefABCDEF",
          status: "ready",
          url: "http://r-fedcba9876543210fedcba9876543210.localhost:4322/",
          reused: false,
        },
        session: { id: "zB3_-xYz", url: session.url },
        grant: {
          root,
          access: "read_all_regular_files_beneath_root",
        },
        fidelity: "instrumented_review",
      };
      await assert.rejects(runEffect(client.review(session.id)), expected);
      value = { stopped: 2 };
      await assert.rejects(runEffect(client.stopSession("missing")), expected);
    } finally {
      await new Promise<void>((resolve, reject) =>
        fake.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });

  it("rejects oversized control bodies", async () => {
    const { paths } = await setup();
    const status = await new Promise<number>((resolve, reject) => {
      const payload = Buffer.alloc(65 * 1024, 0x20);
      const operation = request(
        {
          socketPath: paths.controlSocket,
          method: "POST",
          path: "/sessions",
          headers: {
            host: controlHost,
            "content-length": String(payload.length),
          },
        },
        (response) => {
          response.resume();
          response.on("end", () => resolve(response.statusCode ?? 0));
        },
      );
      operation.once("error", reject);
      operation.end(payload);
    });
    assert.equal(status, 413);
  });

  it("validates exact control request schemas", async () => {
    const { paths } = await setup();
    for (const body of [
      null,
      [],
      {},
      { entry: "/tmp/report.html" },
      { entry: 1, root: "/tmp" },
      { entry: "/tmp/report.html", root: "/tmp", extra: true },
    ]) {
      const response = await controlRequest(paths, "POST", "/sessions", body);
      assert.equal(response.status, 400);
      assert.deepEqual(response.value, {
        error: {
          code: "control.invalid_request",
          message: "Invalid control request",
        },
      });
    }

    assert.deepEqual(
      await controlRequest(paths, "POST", "/stop", { session: "" }),
      { status: 200, value: { stopped: 0 } },
    );
    assert.equal(
      (
        await controlRequest(paths, "POST", "/shutdown", {
          unexpected: true,
        })
      ).status,
      400,
    );
  });

  it("keeps control state outside an ordinary served root", async () => {
    const { paths, client, root, entry } = await setup();
    await runEffect(client.serve(entry, root));
    assert.deepEqual(await readdir(root), ["report.html"]);
    assert.deepEqual((await readdir(paths.directory)).sort(), [
      "annotations",
      "control.sock",
      "supervisor.lock",
    ]);
  });

  it("fails empty home discovery closed for a symlinked annotation directory", async () => {
    const parent = await temporaryDirectory("htmlview-state-link-");
    const outside = await temporaryDirectory("htmlview-annotation-outside-");
    const paths = statePaths({
      HTMLVIEW_STATE_DIR: path.join(parent, "state"),
    });
    await runEffect(ensurePrivateStateDirectory(paths));
    await symlink(outside, paths.annotationDirectory, "dir");

    await assert.rejects(runEffect(new SupervisorClient(paths).listState()), {
      code: "state.unavailable",
    });
  });

  it("rejects a serving root that contains configured runtime state", async () => {
    const root = await temporaryDirectory("htmlview-state-overlap-");
    const paths = statePaths({
      HTMLVIEW_STATE_DIR: path.join(root, "runtime-state"),
    });
    const entry = path.join(root, "report.html");
    await writeFile(entry, "<!doctype html>");
    let starts = 0;
    const client = new SupervisorClient(paths, () =>
      Effect.sync(() => (starts += 1)),
    );
    await assert.rejects(runEffect(client.serve(entry, await realpath(root))), {
      code: "path.root_contains_state",
    });
    assert.equal(starts, 0);
    await assert.rejects(lstat(paths.directory));
    assert.deepEqual(await readdir(root), ["report.html"]);
  });

  it("rejects a symlinked root that resolves over runtime state", async () => {
    const root = await temporaryDirectory("htmlview-state-link-target-");
    const aliases = await temporaryDirectory("htmlview-state-link-alias-");
    const linkedRoot = path.join(aliases, "root");
    const paths = statePaths({
      HTMLVIEW_STATE_DIR: path.join(root, "runtime-state"),
    });
    const entry = path.join(root, "report.html");
    await writeFile(entry, "<!doctype html>");
    await symlink(root, linkedRoot, "dir");
    let starts = 0;
    const client = new SupervisorClient(paths, () =>
      Effect.sync(() => (starts += 1)),
    );

    await assert.rejects(
      runEffect(client.serve(path.join(linkedRoot, "report.html"), linkedRoot)),
      {
        code: "path.root_contains_state",
      },
    );
    assert.equal(starts, 0);
    await assert.rejects(lstat(paths.directory));
  });

  it("rejects roots equal to or nested beneath configured runtime state", async () => {
    for (const nested of [false, true]) {
      const parent = await temporaryDirectory("hv-state-inverse-");
      const state = path.join(parent, nested ? "state" : "equal");
      const root = nested ? path.join(state, "served") : state;
      await mkdir(root, { recursive: true });
      const entry = path.join(root, "report.html");
      await writeFile(entry, "<!doctype html>");
      const paths = statePaths({ HTMLVIEW_STATE_DIR: state });
      let starts = 0;
      const client = new SupervisorClient(paths, () =>
        Effect.sync(() => (starts += 1)),
      );

      await assert.rejects(
        runEffect(client.serve(entry, await realpath(root))),
        {
          code: "path.root_contains_state",
        },
      );
      assert.equal(starts, 0);
      assert.deepEqual(await readdir(root), ["report.html"]);
    }
  });

  it("rejects a state symlink whose canonical tree contains the grant", async () => {
    const parent = await temporaryDirectory("hv-state-inverse-link-");
    const actualState = path.join(parent, "actual");
    const aliasState = path.join(parent, "alias");
    const root = path.join(actualState, "served");
    await mkdir(root, { recursive: true });
    await symlink(actualState, aliasState, "dir");
    const entry = path.join(root, "report.html");
    await writeFile(entry, "<!doctype html>");
    const paths = statePaths({ HTMLVIEW_STATE_DIR: aliasState });
    let starts = 0;
    const client = new SupervisorClient(paths, () =>
      Effect.sync(() => (starts += 1)),
    );

    await assert.rejects(runEffect(client.serve(entry, await realpath(root))), {
      code: "path.root_contains_state",
    });
    assert.equal(starts, 0);
  });

  it("revalidates runtime-state overlap at the supervisor seam", async () => {
    const root = await temporaryDirectory("hv-state-recheck-");
    const paths = statePaths({
      HTMLVIEW_STATE_DIR: path.join(root, "runtime-state"),
    });
    const entry = path.join(root, "report.html");
    await writeFile(entry, "<!doctype html>");
    const supervisor = await runEffect(startSupervisor({ paths }));
    supervisors.push(supervisor);
    const response = await controlRequest(paths, "POST", "/sessions", {
      entry,
      root,
    });
    assert.equal(response.status, 400);
    assert.equal(
      (response.value as { error: { code: string } }).error.code,
      "path.root_contains_state",
    );
  });

  it("revalidates a grant nested beneath state at the supervisor seam", async () => {
    const parent = await temporaryDirectory("hv-state-inverse-recheck-");
    const paths = statePaths({
      HTMLVIEW_STATE_DIR: path.join(parent, "state"),
    });
    const supervisor = await runEffect(startSupervisor({ paths }));
    supervisors.push(supervisor);
    const root = path.join(paths.directory, "served");
    await mkdir(root);
    const entry = path.join(root, "report.html");
    await writeFile(entry, "<!doctype html>");

    const response = await controlRequest(paths, "POST", "/sessions", {
      entry,
      root,
    });
    assert.equal(response.status, 400);
    assert.equal(
      (response.value as { error: { code: string } }).error.code,
      "path.root_contains_state",
    );
  });

  it("removes the control socket after bounded idle shutdown", async () => {
    const { paths } = await setup({ idleMilliseconds: 30 });
    const deadline = Date.now() + 2_000;
    while ((await socketExists(paths)) && Date.now() < deadline)
      await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(await socketExists(paths), false);
  });

  it("does not shut down while a request body is in flight", async () => {
    const { paths, root, entry } = await setup({ idleMilliseconds: 100 });
    const response = new Promise<{ status: number; body: unknown }>(
      (resolve, reject) => {
        const operation = request(
          {
            socketPath: paths.controlSocket,
            method: "POST",
            path: "/sessions",
            headers: {
              host: controlHost,
              "content-type": "application/json",
            },
          },
          (incoming) => {
            const chunks: Buffer[] = [];
            incoming.on("data", (chunk: Buffer) => chunks.push(chunk));
            incoming.on("end", () =>
              resolve({
                status: incoming.statusCode ?? 0,
                body: JSON.parse(Buffer.concat(chunks).toString("utf8")),
              }),
            );
          },
        );
        operation.once("error", reject);
        operation.write(`{"entry":${JSON.stringify(entry)},`);
        setTimeout(() => operation.end(`"root":${JSON.stringify(root)}}`), 250);
      },
    );

    const result = await response;
    assert.equal(result.status, 200);
    assert.equal(await socketExists(paths), true);
    const session = (result.body as { session: { url: string } }).session;
    assert.equal(await fetch(session.url).then((value) => value.status), 200);
  });

  it("forces a bounded shutdown when a control client stalls", async () => {
    const { paths } = await setup();
    const current = supervisors.pop();
    assert.notEqual(current, undefined);
    if (current !== undefined) await runEffect(current.close);
    const bounded = await runEffect(
      startSupervisor({
        paths,
        idleMilliseconds: 10_000,
        shutdownGraceMilliseconds: 50,
      }),
    );
    supervisors.push(bounded);
    const operation = request({
      socketPath: paths.controlSocket,
      method: "POST",
      path: "/sessions",
      headers: { host: controlHost },
    });
    operation.on("error", () => undefined);
    operation.write('{"entry":"unfinished');
    await new Promise((resolve) => setTimeout(resolve, 20));

    const started = Date.now();
    await runEffect(bounded.close);
    assert.ok(Date.now() - started < 500);
    operation.destroy();
  });

  it("preserves ownership when a live supervisor is temporarily unavailable", async () => {
    let stallHealth = false;
    let stalledHealthRequests = 0;
    let releaseHealth = (): void => undefined;
    const healthGate = new Promise<void>((resolve) => {
      releaseHealth = resolve;
    });
    const { paths, client, root, entry } = await setup({
      beforeHealth: async () => {
        if (stallHealth) {
          stalledHealthRequests += 1;
          await healthGate;
        }
      },
    });
    const served = await runEffect(client.serve(entry, root));
    let replacementStarts = 0;
    const guardedClient = new SupervisorClient(paths, () =>
      Effect.sync(() => (replacementStarts += 1)),
    );
    stallHealth = true;

    await assert.rejects(runEffect(guardedClient.list()), {
      code: "supervisor.unavailable",
    });
    await assert.rejects(runEffect(guardedClient.serve(entry, root)), {
      code: "supervisor.unavailable",
    });
    assert.equal(stalledHealthRequests, 6);
    assert.equal(replacementStarts, 0);
    assert.equal(await socketExists(paths), true);
    assert.equal(
      await fetch(served.session.url).then((value) => value.status),
      200,
    );

    stallHealth = false;
    releaseHealth();
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal((await runEffect(client.stopAll())).stopped, 1);
  });

  it("does not replace a live foreign owner of the control socket", async () => {
    const parent = await temporaryDirectory("htmlview-foreign-socket-");
    const paths = statePaths({
      HTMLVIEW_STATE_DIR: path.join(parent, "state"),
    });
    await Effect.runPromise(ensurePrivateStateDirectory(paths));
    const foreignSockets = new Set<import("node:net").Socket>();
    const foreign = createNetServer((socket) => {
      foreignSockets.add(socket);
      socket.once("close", () => foreignSockets.delete(socket));
      socket.end(
        "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 2\r\n\r\n{}",
      );
    });
    await new Promise<void>((resolve, reject) => {
      foreign.once("error", reject);
      foreign.listen(paths.controlSocket, resolve);
    });
    const original = await lstat(paths.controlSocket);
    let replacementStarts = 0;
    const client = new SupervisorClient(paths, () =>
      Effect.sync(() => (replacementStarts += 1)),
    );
    const root = await temporaryDirectory("htmlview-foreign-entry-");
    const entry = path.join(root, "report.html");
    await writeFile(entry, "foreign owner remains");

    try {
      await assert.rejects(runEffect(client.list()), {
        code: "supervisor.unavailable",
      });
      await assert.rejects(runEffect(client.serve(entry, root)), {
        code: "supervisor.unavailable",
      });
      const current = await lstat(paths.controlSocket);
      assert.equal(current.ino, original.ino);
      assert.equal(replacementStarts, 0);
    } finally {
      for (const socket of foreignSockets) socket.destroy();
      await new Promise<void>((resolve, reject) =>
        foreign.close((error) =>
          error === undefined ? resolve() : reject(error),
        ),
      );
    }
  });

  it("waits for graceful ownership release before starting a replacement", async () => {
    const { paths, supervisor, root, entry } = await setup();
    const held = request({
      socketPath: paths.controlSocket,
      method: "POST",
      path: "/sessions",
      headers: { host: controlHost },
    });
    held.on("error", () => undefined);
    held.write('{"entry":"unfinished');
    await new Promise((resolve) => setTimeout(resolve, 20));

    const closing = runEffect(supervisor.close);
    const replacementClient = new SupervisorClient(paths, (_, ownershipNonce) =>
      Effect.tryPromise({
        try: async () => {
          supervisors.push(
            await runEffect(startSupervisor({ paths, ownershipNonce })),
          );
        },
        catch: (cause) => new ProcessStartError({ cause }),
      }),
    );
    const replacement = runEffect(replacementClient.serve(entry, root));
    await closing;
    held.destroy();
    const served = await replacement;

    assert.equal(await socketExists(paths), true);
    assert.equal((await runEffect(replacementClient.list())).length, 1);
    assert.equal(
      await fetch(served.session.url).then((response) => response.status),
      200,
    );
  });

  it("makes stop-all clean a stale socket and dead ownership lock", async () => {
    const parent = await temporaryDirectory("htmlview-stale-stop-");
    const paths = statePaths({
      HTMLVIEW_STATE_DIR: path.join(parent, "state"),
    });
    await Effect.runPromise(ensurePrivateStateDirectory(paths));
    const child = spawn(
      process.execPath,
      [
        "-e",
        `const fs=require('fs');const net=require('net');fs.mkdirSync(${JSON.stringify(paths.supervisorLock)},{mode:448});fs.writeFileSync(${JSON.stringify(path.join(paths.supervisorLock, "owner.json"))},JSON.stringify({pid:process.pid,nonce:'d'.repeat(32)}),{mode:384});const s=net.createServer();s.listen(${JSON.stringify(paths.controlSocket)},()=>process.stdout.write('ready'));setInterval(()=>{},1000)`,
      ],
      { stdio: ["ignore", "pipe", "ignore"] },
    );
    await once(child.stdout, "data");
    child.kill("SIGKILL");
    await once(child, "exit");

    assert.equal(
      (await runEffect(new SupervisorClient(paths).stopAll())).stopped,
      0,
    );
    assert.equal(await socketExists(paths), false);
    await assert.rejects(lstat(paths.supervisorLock));
  });

  it("recovers a stale socket left by a killed supervisor", async () => {
    const parent = await temporaryDirectory("htmlview-stale-socket-");
    const paths = statePaths({
      HTMLVIEW_STATE_DIR: path.join(parent, "state"),
    });
    await Effect.runPromise(ensurePrivateStateDirectory(paths));
    const child = spawn(
      process.execPath,
      [
        "-e",
        `const net=require('node:net');const s=net.createServer();s.listen(${JSON.stringify(paths.controlSocket)},()=>process.stdout.write('ready'));setInterval(()=>{},1000)`,
      ],
      { stdio: ["ignore", "pipe", "ignore"] },
    );
    await once(child.stdout, "data");
    child.kill("SIGKILL");
    await once(child, "exit");
    assert.equal((await lstat(paths.controlSocket)).isSocket(), true);

    const root = await temporaryDirectory("htmlview-stale-entry-");
    const entry = path.join(root, "report.html");
    await writeFile(entry, "recovered");
    const client = new SupervisorClient(paths, (_, ownershipNonce) =>
      Effect.tryPromise({
        try: async () => {
          supervisors.push(
            await runEffect(startSupervisor({ paths, ownershipNonce })),
          );
        },
        catch: (cause) => new ProcessStartError({ cause }),
      }),
    );
    const result = await runEffect(client.serve(entry, root));
    assert.equal(
      await fetch(result.session.url).then((value) => value.text()),
      "recovered",
    );
  });

  it("treats public entry aliases as distinct session identities", async () => {
    const { client, root } = await setup();
    await mkdir(path.join(root, "shared"));
    await mkdir(path.join(root, "a"));
    await mkdir(path.join(root, "b"));
    const target = path.join(root, "shared", "index.html");
    await writeFile(target, "shared");
    const { symlink } = await import("node:fs/promises");
    await symlink(target, path.join(root, "a", "index.html"));
    await symlink(target, path.join(root, "b", "index.html"));

    const first = await runEffect(
      client.serve(path.join(root, "a", "index.html"), root),
    );
    const second = await runEffect(
      client.serve(path.join(root, "b", "index.html"), root),
    );
    assert.notEqual(first.session.id, second.session.id);
    const [firstReview, secondReview] = await Promise.all([
      runEffect(client.review(first.session.id)),
      runEffect(client.review(second.session.id)),
    ]);
    assert.notEqual(firstReview.review.id, secondReview.review.id);
    assert.equal(new URL(first.session.url).pathname, "/a/index.html");
    assert.equal(new URL(second.session.url).pathname, "/b/index.html");
    assert.equal(
      (await runEffect(client.serve(path.join(root, "a", "index.html"), root)))
        .session.id,
      first.session.id,
    );
    await runEffect(client.stopSession(first.session.id));
    assert.equal(
      (await runEffect(client.serve(path.join(root, "b", "index.html"), root)))
        .session.id,
      second.session.id,
    );
    assert.notEqual(
      (await runEffect(client.serve(path.join(root, "a", "index.html"), root)))
        .session.id,
      first.session.id,
    );
  });

  it("selects list fields at the control seam", async () => {
    const { client, root, entry, paths } = await setup();
    await runEffect(client.serve(entry, root));
    const minimal = await runEffect(client.list());
    assert.deepEqual(Object.keys(minimal[0] ?? {}).sort(), [
      "id",
      "status",
      "url",
    ]);
    const expanded = await runEffect(client.list(["entry", "root"]));
    assert.deepEqual(Object.keys(expanded[0] ?? {}).sort(), [
      "entry",
      "id",
      "root",
      "status",
      "url",
    ]);
    assert.equal(
      (await controlRequest(paths, "GET", "/sessions?fields=unknown")).status,
      400,
    );
    assert.equal(
      (await controlRequest(paths, "GET", "/sessions?unknown=true")).status,
      400,
    );
    assert.equal(
      (await controlRequest(paths, "GET", "/state?unknown=true")).status,
      400,
    );
    assert.equal(
      (
        await controlRequest(paths, "POST", "/reviews", {
          session: "short",
        })
      ).status,
      404,
    );
    assert.equal(
      (
        await controlRequest(paths, "POST", "/reviews", {
          session: minimal[0]?.id,
          root: "/broadened",
        })
      ).status,
      400,
    );
    assert.equal(
      (
        await controlRequest(paths, "POST", "/stop", {
          session: minimal[0]?.id,
          all: true,
        })
      ).status,
      400,
    );
  });

  it("caps new sessions while allowing reuse and capacity recovery", async () => {
    const { client, root, entry } = await setup({ maximumSessions: 1 });
    const first = await runEffect(client.serve(entry, root));
    assert.equal((await runEffect(client.serve(entry, root))).reused, true);
    const otherRoot = await temporaryDirectory("htmlview-limit-");
    const otherEntry = path.join(otherRoot, "other.html");
    await writeFile(otherEntry, "other");
    await assert.rejects(runEffect(client.serve(otherEntry, otherRoot)), {
      code: "control.session_limit",
    });
    await runEffect(client.stopSession(first.session.id));
    assert.equal(
      (await runEffect(client.serve(otherEntry, otherRoot))).reused,
      false,
    );
  });

  it("bounds retained review summaries while allowing open-review reuse", async () => {
    const { client, root, entry } = await setup({ maximumReviews: 1 });
    const first = await runEffect(client.serve(entry, root));
    const review = await runEffect(client.review(first.session.id));
    assert.equal(
      (await runEffect(client.review(first.session.id))).review.id,
      review.review.id,
    );

    const otherRoot = await temporaryDirectory("htmlview-review-limit-");
    const otherEntry = path.join(otherRoot, "other.html");
    await writeFile(otherEntry, "other");
    const second = await runEffect(client.serve(otherEntry, otherRoot));
    await assert.rejects(runEffect(client.review(second.session.id)), {
      code: "review.limit",
    });
    assert.equal((await runEffect(client.listState())).reviews.length, 1);
  });

  it("enumerates the production session cap and rejects the next session", async () => {
    const { client, root } = await setup();
    for (let index = 0; index < maximumConcurrentSessions; index += 1) {
      const entry = path.join(root, `report-${index}.html`);
      await writeFile(entry, String(index));
      await runEffect(client.serve(entry, root));
    }
    const sessions = await runEffect(client.list(["entry", "root"]));
    assert.equal(sessions.length, maximumConcurrentSessions);
    assert.ok(sessions.every((session) => session.entry && session.root));

    const overflow = path.join(root, "overflow.html");
    await writeFile(overflow, "overflow");
    await assert.rejects(runEffect(client.serve(overflow, root)), {
      code: "control.session_limit",
    });
  });

  it("rejects different versions but lets stop-all shut them down", async () => {
    const { client, paths } = await setup({ version: "9.9.9" });
    await assert.rejects(runEffect(client.list()), {
      code: "supervisor.version_mismatch",
    });
    assert.equal((await runEffect(client.stopAll())).stopped, 0);
    assert.equal(await socketExists(paths), false);
  });

  it("rejects a different control protocol without sending shutdown", async () => {
    const parent = await temporaryDirectory("hv-proto-");
    const paths = statePaths({
      HTMLVIEW_STATE_DIR: path.join(parent, "state"),
    });
    await Effect.runPromise(ensurePrivateStateDirectory(paths));
    let shutdownRequests = 0;
    const fake = createHttpServer((incoming, response) => {
      if (incoming.url === "/shutdown") shutdownRequests += 1;
      response.end(
        JSON.stringify({
          protocol: "htmlview-supervisor-v2",
          instanceId: randomUUID(),
          pid: process.pid,
          version: "0.0.1",
        }),
      );
    });
    await new Promise<void>((resolve, reject) => {
      fake.once("error", reject);
      fake.listen(paths.controlSocket, resolve);
    });
    try {
      const client = new SupervisorClient(paths);
      await assert.rejects(runEffect(client.list()), {
        code: "supervisor.protocol_mismatch",
      });
      await assert.rejects(runEffect(client.stopAll()), {
        code: "supervisor.protocol_mismatch",
      });
      assert.equal(shutdownRequests, 0);
    } finally {
      await new Promise<void>((resolve, reject) =>
        fake.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });

  it("does not create a session when grant resolution resumes after shutdown", async () => {
    const parent = await temporaryDirectory("htmlview-delayed-grant-");
    const paths = statePaths({
      HTMLVIEW_STATE_DIR: path.join(parent, "state"),
    });
    const root = await temporaryDirectory("htmlview-delayed-entry-");
    const entry = path.join(root, "report.html");
    await writeFile(entry, "<!doctype html>");
    let releaseGrant = (): void => undefined;
    const grantGate = new Promise<void>((resolve) => {
      releaseGrant = resolve;
    });
    let grantStarted = (): void => undefined;
    const started = new Promise<void>((resolve) => {
      grantStarted = resolve;
    });
    let contentStarts = 0;
    const supervisor = await runEffect(
      startSupervisor({
        paths,
        idleMilliseconds: 10_000,
        shutdownGraceMilliseconds: 50,
        resolveGrant: (...arguments_) =>
          Effect.gen(function* () {
            yield* Effect.sync(grantStarted);
            yield* Effect.promise(() => grantGate);
            return yield* resolveServingGrant(...arguments_);
          }),
        startSessionServer: (sessionGrant) =>
          Effect.gen(function* () {
            yield* Effect.sync(() => {
              contentStarts += 1;
            });
            return yield* startStaticServer(sessionGrant);
          }),
      }),
    );
    supervisors.push(supervisor);
    const operation = controlRequest(paths, "POST", "/sessions", {
      entry,
      root,
    }).catch(() => undefined);
    await started;
    await runEffect(supervisor.close);
    releaseGrant();
    await operation;
    assert.equal(contentStarts, 0);
  });

  it("interrupts pending session readiness before shutdown takes the registry permit", async () => {
    const parent = await temporaryDirectory("htmlview-pending-ready-");
    const paths = statePaths({
      HTMLVIEW_STATE_DIR: path.join(parent, "state"),
    });
    const root = await temporaryDirectory("htmlview-pending-entry-");
    const entry = path.join(root, "report.html");
    await writeFile(entry, "<!doctype html>");
    let readinessStarted = (): void => undefined;
    const started = new Promise<void>((resolve) => {
      readinessStarted = resolve;
    });
    let finalized = 0;
    const stalled = createHttpServer(() => readinessStarted());
    await new Promise<void>((resolve, reject) => {
      stalled.once("error", reject);
      stalled.listen({ host: "127.0.0.1", port: 0 }, resolve);
    });
    const address = stalled.address();
    assert.ok(address !== null && typeof address !== "string");
    const supervisor = await runEffect(
      startSupervisor({
        paths,
        idleMilliseconds: 10_000,
        shutdownGraceMilliseconds: 50,
        startSessionServer: () =>
          Effect.gen(function* () {
            yield* Effect.addFinalizer(() =>
              Effect.callback<void>((resume) => {
                stalled.close((error) => {
                  finalized += 1;
                  resume(error === undefined ? Effect.void : Effect.die(error));
                });
                stalled.closeAllConnections();
              }),
            );
            return {
              bindAddress: "127.0.0.1" as const,
              hostname: "h-stalled.localhost",
              port: address.port,
              origin: `http://h-stalled.localhost:${address.port}`,
              url: `http://h-stalled.localhost:${address.port}/report.html`,
            };
          }),
      }),
    );
    supervisors.push(supervisor);
    const serve = runEffect(
      new SupervisorClient(paths).serve(entry, root),
    ).then(
      () => undefined,
      (error: unknown) => error,
    );
    await started;
    await runEffect(supervisor.close);
    supervisors.pop();
    assert.equal(
      ((await serve) as { readonly code?: unknown }).code,
      "http.readiness_failed",
    );
    assert.equal(finalized, 1);
    assert.equal(await socketExists(paths), false);
  });

  it("translates an unusable state location into a stable client error", async () => {
    const parent = await temporaryDirectory("htmlview-unusable-state-");
    const stateFile = path.join(parent, "not-a-directory");
    await writeFile(stateFile, "blocked");
    const client = new SupervisorClient(
      statePaths({ HTMLVIEW_STATE_DIR: stateFile }),
    );
    await assert.rejects(runEffect(client.list()), (error: unknown) => {
      assert.equal((error as { code?: unknown }).code, "state.unavailable");
      assert.equal(
        (error as { message?: unknown }).message,
        "The private htmlview runtime state directory is unavailable",
      );
      assert.ok((error as { cause?: unknown }).cause instanceof Error);
      return true;
    });
  });

  it("keeps grant-correlation filesystem failures in the path error boundary", async () => {
    const parent = await temporaryDirectory("htmlview-vanished-root-");
    const paths = statePaths({
      HTMLVIEW_STATE_DIR: path.join(parent, "state"),
    });
    const missingRoot = path.join(parent, "missing");
    let starts = 0;
    const client = new SupervisorClient(paths, () =>
      Effect.sync(() => (starts += 1)),
    );
    await assert.rejects(
      runEffect(
        client.serve(path.join(missingRoot, "report.html"), missingRoot),
      ),
      (error: unknown) => {
        assert.equal((error as { code?: unknown }).code, "path.root_not_found");
        assert.ok((error as { cause?: unknown }).cause instanceof Error);
        return true;
      },
    );
    assert.equal(starts, 0);
  });

  it("translates detached process spawn failures without raw errors", async () => {
    const parent = await temporaryDirectory("htmlview-spawn-failure-");
    const paths = statePaths({
      HTMLVIEW_STATE_DIR: path.join(parent, "state"),
    });
    const root = await temporaryDirectory("htmlview-spawn-entry-");
    const entry = path.join(root, "report.html");
    await writeFile(entry, "<!doctype html>");
    const cause = Object.assign(new Error("spawn resource exhausted"), {
      code: "EAGAIN",
    });
    const client = new SupervisorClient(paths, () =>
      Effect.fail(new ProcessStartError({ cause })),
    );
    await assert.rejects(
      runEffect(client.serve(entry, root)),
      (error: unknown) => {
        assert.equal(
          (error as { code?: unknown }).code,
          "supervisor.start_failed",
        );
        assert.equal(
          (error as { message?: unknown }).message,
          "The htmlview supervisor process could not start",
        );
        assert.equal((error as { cause?: unknown }).cause, cause);
        return true;
      },
    );
  });

  it("exposes stable content start and readiness failures", async () => {
    for (const [expected, startSessionServer] of [
      [
        "http.start_failed",
        () =>
          Effect.fail(
            new ContentListenerError({
              code: "http.start_failed",
              message: "The loopback content listener could not start",
              cause: Object.assign(new Error("bind failed"), {
                code: "EADDRNOTAVAIL",
              }),
            }),
          ),
      ],
      [
        "http.readiness_failed",
        () =>
          Effect.succeed({
            bindAddress: "127.0.0.1" as const,
            hostname: "h-unready.localhost",
            port: 9,
            origin: "http://h-unready.localhost:9",
            url: "http://h-unready.localhost:9/report.html",
          }),
      ],
    ] as const) {
      const parent = await temporaryDirectory("hv-fail-");
      const paths = statePaths({
        HTMLVIEW_STATE_DIR: path.join(parent, "state"),
      });
      const root = await temporaryDirectory("hv-fail-entry-");
      const entry = path.join(root, "report.html");
      await writeFile(entry, "<!doctype html>");
      const supervisor = await runEffect(
        startSupervisor({
          paths,
          idleMilliseconds: 10_000,
          startSessionServer,
        }),
      );
      supervisors.push(supervisor);
      await assert.rejects(
        runEffect(new SupervisorClient(paths).serve(entry, root)),
        {
          code: expected,
        },
      );
      await runEffect(supervisor.close);
      supervisors.pop();
    }
  });

  it("closes a pending session scope when readiness fails", async () => {
    const parent = await temporaryDirectory("hv-readiness-scope-");
    const paths = statePaths({
      HTMLVIEW_STATE_DIR: path.join(parent, "state"),
    });
    const root = await temporaryDirectory("hv-readiness-entry-");
    const entry = path.join(root, "report.html");
    await writeFile(entry, "<!doctype html>");
    let finalized = 0;
    const supervisor = await runEffect(
      startSupervisor({
        paths,
        idleMilliseconds: 10_000,
        startSessionServer: () =>
          Effect.gen(function* () {
            yield* Effect.addFinalizer(() =>
              Effect.sync(() => {
                finalized += 1;
              }),
            );
            return {
              bindAddress: "127.0.0.1" as const,
              hostname: "h-unready.localhost",
              port: 9,
              origin: "http://h-unready.localhost:9",
              url: "http://h-unready.localhost:9/report.html",
            };
          }),
      }),
    );
    supervisors.push(supervisor);
    await assert.rejects(
      runEffect(new SupervisorClient(paths).serve(entry, root)),
      {
        code: "http.readiness_failed",
      },
    );
    assert.equal(finalized, 1);
  });

  it("continues supervisor shutdown after a session finalizer defect", async () => {
    const parent = await temporaryDirectory("hv-finalizer-defect-");
    const paths = statePaths({
      HTMLVIEW_STATE_DIR: path.join(parent, "state"),
    });
    const root = await temporaryDirectory("hv-finalizer-entry-");
    const entry = path.join(root, "report.html");
    await writeFile(entry, "<!doctype html>");
    const defect = new Error("session finalizer defect");
    const supervisor = await runEffect(
      startSupervisor({
        paths,
        idleMilliseconds: 10_000,
        startSessionServer: (grant) =>
          Effect.gen(function* () {
            const server = yield* startStaticServer(grant);
            yield* Effect.addFinalizer(() => Effect.die(defect));
            return server;
          }),
      }),
    );
    supervisors.push(supervisor);
    const served = await runEffect(
      new SupervisorClient(paths).serve(entry, root),
    );
    supervisors.pop();
    const closed = assert.rejects(runEffect(supervisor.closed), {
      _tag: "SupervisorLifecycleError",
      phase: "shutdown",
    });
    await assert.rejects(runEffect(supervisor.close));
    await closed;
    assert.equal(await socketExists(paths), false);
    await assert.rejects(lstat(paths.supervisorLock));
    await assert.rejects(fetch(served.session.url));
  });

  it("releases supervisor ownership after a shutdown-route cleanup defect", async () => {
    const parent = await temporaryDirectory("hv-route-defect-");
    const paths = statePaths({
      HTMLVIEW_STATE_DIR: path.join(parent, "state"),
    });
    const root = await temporaryDirectory("hv-route-entry-");
    const entry = path.join(root, "report.html");
    await writeFile(entry, "<!doctype html>");
    const supervisor = await runEffect(
      startSupervisor({
        paths,
        idleMilliseconds: 10_000,
        startSessionServer: (grant) =>
          Effect.gen(function* () {
            const server = yield* startStaticServer(grant);
            yield* Effect.addFinalizer(() =>
              Effect.die(new Error("shutdown route finalizer defect")),
            );
            return server;
          }),
      }),
    );
    supervisors.push(supervisor);
    const client = new SupervisorClient(paths);
    const served = await runEffect(client.serve(entry, root));
    supervisors.pop();
    const closed = runEffect(supervisor.closed);
    await assert.rejects(runEffect(client.stopAll()), {
      code: "control.internal",
    });
    await closed;

    assert.equal(await socketExists(paths), false);
    await assert.rejects(lstat(paths.supervisorLock));
    await assert.rejects(fetch(served.session.url));
  });

  it("finishes shutdown when its client disconnects during listener cleanup", async () => {
    const parent = await temporaryDirectory("hv-shutdown-drop-");
    const paths = statePaths({
      HTMLVIEW_STATE_DIR: path.join(parent, "state"),
    });
    const root = await temporaryDirectory("hv-shutdown-drop-entry-");
    const entry = path.join(root, "report.html");
    await writeFile(entry, "<!doctype html>");
    let cleanupStartedResolve!: () => void;
    let releaseCleanup!: () => void;
    const cleanupStarted = new Promise<void>((resolve) => {
      cleanupStartedResolve = resolve;
    });
    const cleanupGate = new Promise<void>((resolve) => {
      releaseCleanup = resolve;
    });
    const supervisor = await runEffect(
      startSupervisor({
        paths,
        idleMilliseconds: 10_000,
        startSessionServer: (grant) =>
          Effect.gen(function* () {
            const server = yield* startStaticServer(grant);
            yield* Effect.addFinalizer(() =>
              Effect.promise(async () => {
                cleanupStartedResolve();
                await cleanupGate;
              }),
            );
            return server;
          }),
      }),
    );
    supervisors.push(supervisor);
    const served = await runEffect(
      new SupervisorClient(paths).serve(entry, root),
    );
    supervisors.pop();

    const operation = request({
      socketPath: paths.controlSocket,
      method: "POST",
      path: "/shutdown",
      headers: {
        host: controlHost,
        "content-type": "application/json",
        "content-length": "2",
      },
    });
    operation.on("error", () => undefined);
    operation.end("{}");
    await cleanupStarted;
    operation.destroy();
    releaseCleanup();
    await runEffect(supervisor.closed);

    assert.equal(await socketExists(paths), false);
    await assert.rejects(lstat(paths.supervisorLock));
    await assert.rejects(fetch(served.session.url));
  });

  it("attempts every review and raw cleanup after review finalizer defects", async () => {
    const parent = await temporaryDirectory("hv-rfd-");
    const paths = statePaths({
      HTMLVIEW_STATE_DIR: path.join(parent, "state"),
    });
    const defect = new Error("review finalizer defect");
    const supervisor = await runEffect(
      startSupervisor({
        paths,
        idleMilliseconds: 10_000,
        startReviewOriginServer: (role, state) =>
          Effect.gen(function* () {
            const server = yield* startReviewOriginServer(role, { state });
            if (role === "shell")
              yield* Effect.addFinalizer(() => Effect.die(defect));
            return server;
          }),
      }),
    );
    supervisors.push(supervisor);
    const client = new SupervisorClient(paths);
    const records: Array<{
      readonly id: string;
      readonly rawUrl: string;
      readonly reviewUrl: string;
    }> = [];
    for (let index = 0; index < 2; index += 1) {
      const root = await temporaryDirectory(`hv-review-defect-${index}-`);
      const entry = path.join(root, "report.html");
      await writeFile(entry, `review-${index}`);
      const served = await runEffect(client.serve(entry, root));
      records.push({
        id: served.session.id,
        rawUrl: served.session.url,
        reviewUrl: (await runEffect(client.review(served.session.id))).review
          .url,
      });
    }

    const first = records[0];
    const second = records[1];
    assert.ok(first !== undefined && second !== undefined);
    await assert.rejects(runEffect(client.stopSession(first.id)), {
      code: "control.internal",
    });
    await assert.rejects(fetch(first.reviewUrl));
    await assert.rejects(fetch(first.rawUrl));
    assert.equal((await fetch(second.reviewUrl)).status, 200);
    assert.equal((await fetch(second.rawUrl)).status, 200);

    supervisors.pop();
    const closed = assert.rejects(runEffect(supervisor.closed), {
      _tag: "SupervisorLifecycleError",
      phase: "shutdown",
    });
    await assert.rejects(runEffect(supervisor.close));
    await closed;
    assert.equal(await socketExists(paths), false);
    await assert.rejects(lstat(paths.supervisorLock));
    await assert.rejects(fetch(second.reviewUrl));
    await assert.rejects(fetch(second.rawUrl));
  });

  it("preserves the private logger inside supervisor callback runtimes", async () => {
    const parent = await temporaryDirectory("hv-nested-log-");
    const paths = statePaths({
      HTMLVIEW_STATE_DIR: path.join(parent, "state"),
    });
    const root = await temporaryDirectory("hv-nested-log-entry-");
    const entry = path.join(root, "report.html");
    await writeFile(entry, "<!doctype html>");
    const supervisor = await runEffect(
      startSupervisor({
        paths,
        idleMilliseconds: 10_000,
        startSessionServer: (grant) =>
          Effect.gen(function* () {
            const server = yield* startStaticServer(grant);
            yield* Effect.addFinalizer(() =>
              logDiagnostic("Error", {
                operation: "http.cleanup",
                code: "runtime.internal",
                failureCount: 1,
              }),
            );
            return server;
          }),
      }).pipe(Effect.provide(supervisorDiagnosticLayer(paths))),
    );
    supervisors.push(supervisor);
    const client = new SupervisorClient(paths);
    const served = await runEffect(client.serve(entry, root));
    assert.equal(
      (await runEffect(client.stopSession(served.session.id))).stopped,
      1,
    );

    const events = (await readFile(paths.diagnosticLogFile, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    assert.equal(
      events.some(
        (event) =>
          event.operation === "http.cleanup" && event.failure_count === 1,
      ),
      true,
    );
  });
});

describe("supervisor state", () => {
  it("rejects a relative custom state root without writing below cwd", async () => {
    const relative = statePaths(
      { HTMLVIEW_STATE_DIR: ".repository-state" },
      "linux",
    );
    assert.equal(
      relative.directory,
      path.join(homedir(), ".local", "state", "htmlview"),
    );
    assert.equal(
      relative.configurationError,
      "HTMLVIEW_STATE_DIR must be an absolute path",
    );
    await assert.rejects(runEffect(new SupervisorClient(relative).list()), {
      code: "state.unavailable",
    });
    assert.equal(
      statePaths({ HTMLVIEW_STATE_DIR: "/var/tmp/htmlview-state" }, "linux")
        .directory,
      "/var/tmp/htmlview-state",
    );
  });

  it("ignores a relative XDG state home instead of writing below cwd", () => {
    assert.equal(
      statePaths({ XDG_STATE_HOME: ".repository-state" }, "linux").directory,
      path.join(homedir(), ".local", "state", "htmlview"),
    );
    assert.equal(
      statePaths({ XDG_STATE_HOME: "/var/tmp/user-state" }, "linux").directory,
      "/var/tmp/user-state/htmlview",
    );
  });

  it("rejects a non-portable control-socket path", async () => {
    const paths = statePaths({
      HTMLVIEW_STATE_DIR: path.join("/tmp", "x".repeat(110)),
    });
    await assert.rejects(runEffect(new SupervisorClient(paths).list()), {
      code: "state.unavailable",
    });
  });

  it("does not expire an ownership lock while its process is alive", async () => {
    const parent = await temporaryDirectory("htmlview-live-lock-");
    const paths = statePaths({
      HTMLVIEW_STATE_DIR: path.join(parent, "state"),
    });
    await Effect.runPromise(ensurePrivateStateDirectory(paths));
    await mkdir(paths.supervisorLock, { mode: 0o700 });
    await Effect.runPromise(
      writePrivateJson(path.join(paths.supervisorLock, "owner.json"), {
        pid: process.pid,
        nonce: "a".repeat(32),
      }),
    );
    await assert.rejects(
      Effect.runPromise(Effect.scoped(acquireSupervisorLock(paths, 80))),
      { reason: "ownership_timeout" },
    );
  });

  it("does not let an old owner release a replacement ownership lock", async () => {
    const parent = await temporaryDirectory("htmlview-fenced-lock-");
    const paths = statePaths({
      HTMLVIEW_STATE_DIR: path.join(parent, "state"),
    });
    await Effect.runPromise(ensurePrivateStateDirectory(paths));
    const oldOwner = await acquireTestLock(paths);
    await rm(paths.supervisorLock, { recursive: true, force: true });
    const replacement = await acquireTestLock(paths);
    await oldOwner.release();
    assert.equal((await stat(paths.supervisorLock)).isDirectory(), true);
    await replacement.release();
    await assert.rejects(stat(paths.supervisorLock));
  });

  it("serializes simultaneous recovery of one stale ownership lock", async () => {
    const parent = await temporaryDirectory("htmlview-stale-lock-");
    const paths = statePaths({
      HTMLVIEW_STATE_DIR: path.join(parent, "state"),
    });
    await Effect.runPromise(ensurePrivateStateDirectory(paths));
    await mkdir(paths.supervisorLock, { mode: 0o700 });
    await Effect.runPromise(
      writePrivateJson(path.join(paths.supervisorLock, "owner.json"), {
        pid: 2_147_483_647,
        nonce: "s".repeat(32),
      }),
    );
    const resolved: number[] = [];
    const contenders = [0, 1].map(async (index) => {
      const lock = await acquireTestLock(paths, 2_000);
      resolved.push(index);
      return { index, lock };
    });
    const winner = await Promise.race(contenders);
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.deepEqual(resolved, [winner.index]);
    await winner.lock.release();
    const owners = await Promise.all(contenders);
    const successor = owners.find(({ index }) => index !== winner.index);
    assert.notEqual(successor, undefined);
    await successor?.lock.release();
  });

  it("does not treat a malformed process-group PID as a live owner", async () => {
    const parent = await temporaryDirectory("htmlview-malformed-owner-");
    const paths = statePaths({
      HTMLVIEW_STATE_DIR: path.join(parent, "state"),
    });
    await Effect.runPromise(ensurePrivateStateDirectory(paths));
    await mkdir(paths.supervisorLock, { mode: 0o700 });
    await Effect.runPromise(
      writePrivateJson(path.join(paths.supervisorLock, "owner.json"), {
        pid: 0,
        nonce: "m".repeat(32),
      }),
    );
    const old = new Date(Date.now() - 20_000);
    await utimes(paths.supervisorLock, old, old);

    const lock = await acquireTestLock(paths, 500);
    await lock.release();
  });

  it("bounds private state records and removes failed temporary writes", async () => {
    const parent = await temporaryDirectory("htmlview-state-limit-");
    const paths = statePaths({
      HTMLVIEW_STATE_DIR: path.join(parent, "state"),
    });
    await Effect.runPromise(ensurePrivateStateDirectory(paths));
    await assert.rejects(
      Effect.runPromise(
        writePrivateJson(path.join(paths.directory, "record.json"), {
          oversized: "x".repeat(17 * 1024),
        }),
      ),
      /State record exceeds size limit/,
    );
    assert.deepEqual(await readdir(paths.directory), []);

    const destination = path.join(paths.directory, "record-directory");
    await mkdir(destination);
    await assert.rejects(
      Effect.runPromise(writePrivateJson(destination, { value: true })),
      (error: unknown) => {
        assert.equal((error as { code?: unknown }).code, "state.unavailable");
        assert.ok((error as { cause?: unknown }).cause instanceof Error);
        return true;
      },
    );
    assert.deepEqual(await readdir(paths.directory), ["record-directory"]);
  });
});
