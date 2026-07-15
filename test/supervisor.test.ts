import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { request } from "node:http";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import { resolveServingGrant } from "../src/serving/grant.js";
import { startStaticServer } from "../src/serving/http.js";
import { SupervisorClient } from "../src/supervisor/client.js";
import { supervisorProtocol } from "../src/supervisor/protocol.js";
import {
  startSupervisor,
  type RunningSupervisor,
} from "../src/supervisor/server.js";
import {
  acquireStartupLock,
  ensurePrivateStateDirectory,
  readDiscovery,
  statePaths,
  writePrivateJson,
  type StatePaths,
} from "../src/supervisor/state.js";

const temporaryDirectories: string[] = [];
const supervisors: RunningSupervisor[] = [];

async function temporaryDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

async function setup(idleMilliseconds = 10_000): Promise<{
  paths: StatePaths;
  supervisor: RunningSupervisor;
  client: SupervisorClient;
  root: string;
  entry: string;
}> {
  const state = await temporaryDirectory("htmlview-state-parent-");
  const paths = statePaths({ HTMLVIEW_STATE_DIR: path.join(state, "state") });
  await ensurePrivateStateDirectory(paths);
  const supervisor = await startSupervisor({ paths, idleMilliseconds });
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

afterEach(async () => {
  await Promise.all(
    supervisors.splice(0).map((supervisor) => supervisor.close()),
  );
  const { rm } = await import("node:fs/promises");
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("supervisor lifecycle", () => {
  it("creates and reuses one ready session for concurrent matching requests", async () => {
    const { client, root, entry, supervisor } = await setup();
    assert.equal(supervisor.controlAddress, "127.0.0.1");
    const results = await Promise.all([
      client.serve(entry, root),
      client.serve(entry, root),
      client.serve(entry, root),
    ]);
    assert.equal(new Set(results.map((result) => result.session.id)).size, 1);
    assert.equal(new Set(results.map((result) => result.session.url)).size, 1);
    assert.equal(results.filter((result) => result.reused).length, 2);
    assert.equal((await client.list()).length, 1);

    const response = await fetch(results[0]?.session.url ?? "");
    assert.equal(response.status, 200);
    assert.equal(await response.text(), "<!doctype html><p>session</p>");
  });

  it("keeps independent roots in simultaneous sessions and stops idempotently", async () => {
    const { client, root, entry } = await setup();
    const otherRoot = await temporaryDirectory("htmlview-session-other-");
    const otherEntry = path.join(otherRoot, "other.html");
    await writeFile(otherEntry, "other");
    const [first, second] = await Promise.all([
      client.serve(entry, root),
      client.serve(otherEntry, otherRoot),
    ]);
    assert.notEqual(first.session.id, second.session.id);
    assert.notEqual(
      new URL(first.session.url).hostname,
      new URL(second.session.url).hostname,
    );
    assert.equal((await client.stop(first.session.id)).stopped, 1);
    assert.equal((await client.stop(first.session.id)).stopped, 0);
    assert.equal((await client.stop(undefined, true)).stopped, 1);
    assert.equal((await client.stop(undefined, true)).stopped, 0);
  });

  it("requires the private credential on control operations", async () => {
    const { supervisor } = await setup();
    for (const [method, route] of [
      ["GET", "/sessions"],
      ["POST", "/stop"],
    ] as const) {
      const status = await new Promise<number>((resolve, reject) => {
        const operation = request(
          {
            hostname: "127.0.0.1",
            port: supervisor.discovery.port,
            method,
            path: route,
            headers: { host: `127.0.0.1:${supervisor.discovery.port}` },
          },
          (response) => {
            response.resume();
            response.on("end", () => resolve(response.statusCode ?? 0));
          },
        );
        operation.once("error", reject);
        operation.end();
      });
      assert.equal(status, 401);
    }
  });

  it("rejects oversized authenticated control bodies", async () => {
    const { supervisor } = await setup();
    const status = await new Promise<number>((resolve, reject) => {
      const payload = Buffer.alloc(65 * 1024, 0x20);
      const operation = request(
        {
          hostname: "127.0.0.1",
          port: supervisor.discovery.port,
          method: "POST",
          path: "/sessions",
          headers: {
            host: `127.0.0.1:${supervisor.discovery.port}`,
            authorization: `Bearer ${supervisor.discovery.token}`,
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

  it("stores private state outside the served root", async () => {
    const { paths, client, root, entry, supervisor } = await setup();
    await client.serve(entry, root);
    assert.match(supervisor.discovery.token, /^[A-Za-z0-9_-]{43}$/);
    assert.equal((await stat(paths.directory)).mode & 0o777, 0o700);
    assert.equal((await stat(paths.discovery)).mode & 0o777, 0o600);
    assert.deepEqual((await readdir(root)).sort(), ["report.html"]);
  });

  it("removes its discovery record after bounded idle shutdown", async () => {
    const { paths } = await setup(30);
    const deadline = Date.now() + 2_000;
    while (
      (await readDiscovery(paths)) !== undefined &&
      Date.now() < deadline
    ) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.equal(await readDiscovery(paths), undefined);
  });

  it("does not shut down while an authenticated request body is in flight", async () => {
    const { paths, supervisor, root, entry } = await setup(100);
    const response = new Promise<{ status: number; body: unknown }>(
      (resolve, reject) => {
        const operation = request(
          {
            hostname: "127.0.0.1",
            port: supervisor.discovery.port,
            method: "POST",
            path: "/sessions",
            headers: {
              host: `127.0.0.1:${supervisor.discovery.port}`,
              authorization: `Bearer ${supervisor.discovery.token}`,
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
    assert.notEqual(await readDiscovery(paths), undefined);
    const session = (result.body as { session: { url: string } }).session;
    assert.equal(await fetch(session.url).then((value) => value.status), 200);
  });

  it("forces a bounded shutdown when a control client stalls", async () => {
    const { paths } = await setup();
    const supervisor = supervisors.pop();
    assert.notEqual(supervisor, undefined);
    await supervisor?.close();

    const bounded = await startSupervisor({
      paths,
      idleMilliseconds: 10_000,
      shutdownGraceMilliseconds: 50,
    });
    supervisors.push(bounded);
    const operation = request({
      hostname: "127.0.0.1",
      port: bounded.discovery.port,
      method: "POST",
      path: "/sessions",
      headers: {
        host: `127.0.0.1:${bounded.discovery.port}`,
        authorization: `Bearer ${bounded.discovery.token}`,
      },
    });
    operation.on("error", () => undefined);
    operation.write('{"entry":"unfinished');
    await new Promise((resolve) => setTimeout(resolve, 20));

    const started = Date.now();
    await bounded.close();
    assert.ok(Date.now() - started < 500);
    operation.destroy();
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
    const supervisor = await startSupervisor({
      paths,
      idleMilliseconds: 10_000,
      shutdownGraceMilliseconds: 50,
      resolveGrant: async (...arguments_) => {
        grantStarted();
        await grantGate;
        return resolveServingGrant(...arguments_);
      },
      startSessionServer: async (sessionGrant) => {
        contentStarts += 1;
        return startStaticServer(sessionGrant);
      },
    });
    supervisors.push(supervisor);
    const operation = request({
      hostname: "127.0.0.1",
      port: supervisor.discovery.port,
      method: "POST",
      path: "/sessions",
      headers: {
        host: `127.0.0.1:${supervisor.discovery.port}`,
        authorization: `Bearer ${supervisor.discovery.token}`,
        "content-type": "application/json",
      },
    });
    operation.on("error", () => undefined);
    operation.end(JSON.stringify({ entry, root }));
    await started;

    await supervisor.close();
    releaseGrant();
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(contentStarts, 0);
  });

  it("rejects stale or unauthenticated discovery instead of trusting its PID", async () => {
    const parent = await temporaryDirectory("htmlview-stale-");
    const paths = statePaths({
      HTMLVIEW_STATE_DIR: path.join(parent, "state"),
    });
    await ensurePrivateStateDirectory(paths);
    await writePrivateJson(paths.discovery, {
      protocol: supervisorProtocol,
      instanceId: "stale",
      pid: process.pid,
      port: 9,
      token: "x".repeat(43),
      version: "0.1.0",
    });
    assert.deepEqual(await new SupervisorClient(paths).list(), []);
    await assert.rejects(readFile(paths.discovery));
  });

  it("translates an unusable state location into a stable client error", async () => {
    const parent = await temporaryDirectory("htmlview-unusable-state-");
    const stateFile = path.join(parent, "not-a-directory");
    await writeFile(stateFile, "blocked");
    const client = new SupervisorClient(
      statePaths({ HTMLVIEW_STATE_DIR: stateFile }),
    );

    await assert.rejects(client.list(), {
      code: "state.unavailable",
      message: "The private htmlview runtime state directory is unavailable",
    });
  });

  it("translates detached process spawn failures without raw process errors", async () => {
    const parent = await temporaryDirectory("htmlview-spawn-failure-");
    const paths = statePaths({
      HTMLVIEW_STATE_DIR: path.join(parent, "state"),
    });
    const root = await temporaryDirectory("htmlview-spawn-entry-");
    const entry = path.join(root, "report.html");
    await writeFile(entry, "<!doctype html>");
    const client = new SupervisorClient(paths, async () => {
      throw Object.assign(new Error("spawn resource exhausted"), {
        code: "EAGAIN",
      });
    });

    await assert.rejects(client.serve(entry, root), {
      code: "supervisor.start_failed",
      message: "The htmlview supervisor process could not start",
    });
  });

  it("exposes stable content start and readiness failures", async () => {
    for (const [expected, startSessionServer] of [
      [
        "http.start_failed",
        async () => {
          throw Object.assign(new Error("bind failed"), {
            code: "EADDRNOTAVAIL",
          });
        },
      ],
      [
        "http.readiness_failed",
        async () => ({
          bindAddress: "127.0.0.1" as const,
          hostname: "h-unready.localhost",
          port: 9,
          origin: "http://h-unready.localhost:9",
          url: "http://h-unready.localhost:9/report.html",
          close: async () => undefined,
        }),
      ],
    ] as const) {
      const parent = await temporaryDirectory(`htmlview-${expected}-`);
      const paths = statePaths({
        HTMLVIEW_STATE_DIR: path.join(parent, "state"),
      });
      const root = await temporaryDirectory(`htmlview-${expected}-entry-`);
      const entry = path.join(root, "report.html");
      await writeFile(entry, "<!doctype html>");
      const supervisor = await startSupervisor({
        paths,
        idleMilliseconds: 10_000,
        startSessionServer,
      });
      supervisors.push(supervisor);

      await assert.rejects(new SupervisorClient(paths).serve(entry, root), {
        code: expected,
      });
      await supervisor.close();
      supervisors.pop();
    }
  });
});

describe("supervisor state", () => {
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

  it("does not expire a startup lock while its owning process is alive", async () => {
    const parent = await temporaryDirectory("htmlview-live-lock-");
    const paths = statePaths({
      HTMLVIEW_STATE_DIR: path.join(parent, "state"),
    });
    await ensurePrivateStateDirectory(paths);
    await mkdir(paths.startupLock, { mode: 0o700 });
    await writePrivateJson(path.join(paths.startupLock, "owner.json"), {
      pid: process.pid,
      createdAt: 0,
      nonce: "a".repeat(32),
    });

    await assert.rejects(
      acquireStartupLock(paths, 80),
      /Timed out waiting for the supervisor startup lock/,
    );
  });

  it("does not let an old owner release a replacement startup lock", async () => {
    const parent = await temporaryDirectory("htmlview-fenced-lock-");
    const paths = statePaths({
      HTMLVIEW_STATE_DIR: path.join(parent, "state"),
    });
    await ensurePrivateStateDirectory(paths);
    const oldOwner = await acquireStartupLock(paths);
    await rm(paths.startupLock, { recursive: true, force: true });
    const replacement = await acquireStartupLock(paths);

    await oldOwner.release();
    assert.equal((await stat(paths.startupLock)).isDirectory(), true);
    await replacement.release();
    await assert.rejects(stat(paths.startupLock));
  });

  it("serializes simultaneous recovery of one stale startup lock", async () => {
    const parent = await temporaryDirectory("htmlview-stale-lock-");
    const paths = statePaths({
      HTMLVIEW_STATE_DIR: path.join(parent, "state"),
    });
    await ensurePrivateStateDirectory(paths);
    await mkdir(paths.startupLock, { mode: 0o700 });
    await writePrivateJson(path.join(paths.startupLock, "owner.json"), {
      pid: 2_147_483_647,
      createdAt: 0,
      nonce: "s".repeat(32),
    });

    const resolved: number[] = [];
    const contenders = [0, 1].map(async (index) => {
      const lock = await acquireStartupLock(paths, 2_000);
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

  it("bounds private state records and removes failed temporary writes", async () => {
    const parent = await temporaryDirectory("htmlview-state-limit-");
    const paths = statePaths({
      HTMLVIEW_STATE_DIR: path.join(parent, "state"),
    });
    await ensurePrivateStateDirectory(paths);

    await assert.rejects(
      writePrivateJson(paths.discovery, { oversized: "x".repeat(17 * 1024) }),
      /State record exceeds size limit/,
    );
    assert.deepEqual(await readdir(paths.directory), []);
  });
});
