import assert from "node:assert/strict";
import { decode } from "@toon-format/toon";
import { spawn } from "node:child_process";
import {
  mkdtemp,
  readFile,
  readdir,
  realpath,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";

let base;
let stateDirectory;
let firstRoot;
let secondRoot;
let environment;

function cli(args, cwd = firstRoot) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [path.resolve("dist/cli.js"), ...args],
      {
        cwd,
        env: environment,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.setEncoding("utf8").on("data", (chunk) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("exit", (code, signal) =>
      resolve({ code, signal, stdout, stderr }),
    );
  });
}

async function jsonCli(args, cwd) {
  const result = await cli([...args, "--json"], cwd);
  assert.equal(result.signal, null);
  assert.equal(result.stderr, "");
  assert.equal(result.stdout.endsWith("\n"), true);
  return { ...result, value: JSON.parse(result.stdout) };
}

async function toonCli(args, cwd) {
  const result = await cli(args, cwd);
  assert.equal(result.signal, null);
  assert.equal(result.stderr, "");
  assert.equal(result.stdout.endsWith("\n"), true);
  return { ...result, value: decode(result.stdout.trimEnd()) };
}

function withoutHelp(value) {
  const result = { ...value };
  delete result.help;
  return result;
}

before(async () => {
  base = await realpath(await mkdtemp(path.join(tmpdir(), "htmlview-e2e-")));
  stateDirectory = path.join(base, "state");
  firstRoot = path.join(base, "first");
  secondRoot = path.join(base, "second");
  const { mkdir } = await import("node:fs/promises");
  await Promise.all([mkdir(firstRoot), mkdir(secondRoot)]);
  await writeFile(
    path.join(firstRoot, "report.html"),
    "<!doctype html><p>first</p>",
  );
  await writeFile(
    path.join(secondRoot, "report.html"),
    "<!doctype html><p>second</p>",
  );
  environment = {
    ...process.env,
    HTMLVIEW_STATE_DIR: stateDirectory,
    HTMLVIEW_IDLE_MS: "300",
  };
});

after(async () => {
  await cli(["stop", "--all", "--json"]).catch(() => undefined);
  const discovery = await readFile(
    path.join(stateDirectory, "supervisor.json"),
    "utf8",
  )
    .then(JSON.parse)
    .catch(() => undefined);
  if (typeof discovery?.pid === "number") {
    try {
      process.kill(discovery.pid, "SIGTERM");
    } catch {
      // The bounded idle shutdown may already have exited.
    }
  }
  const { rm } = await import("node:fs/promises");
  await rm(base, { recursive: true, force: true });
});

test("detached CLI lifecycle converges, recovers, and remains project-clean", async () => {
  const empty = await jsonCli([]);
  assert.equal(empty.code, 0);
  assert.equal(empty.value.count, 0);
  assert.deepEqual(empty.value.sessions, []);

  const [firstCall, secondCall] = await Promise.all([
    jsonCli(["serve", "report.html"]),
    jsonCli(["serve", "report.html"]),
  ]);
  assert.equal(firstCall.code, 0);
  assert.equal(secondCall.code, 0);
  assert.equal(firstCall.value.session.id, secondCall.value.session.id);
  assert.equal(firstCall.value.session.url, secondCall.value.session.url);
  assert.deepEqual(
    [firstCall.value.session.reused, secondCall.value.session.reused].sort(),
    [false, true],
  );
  const toonReuse = await toonCli(["serve", "report.html"]);
  const jsonReuse = await jsonCli(["serve", "report.html"]);
  assert.deepEqual(withoutHelp(toonReuse.value), withoutHelp(jsonReuse.value));
  assert.equal(
    await fetch(firstCall.value.session.url).then((response) =>
      response.text(),
    ),
    "<!doctype html><p>first</p>",
  );

  const home = await jsonCli(["--fields", "entry,root"]);
  assert.equal(home.value.count, 1);
  assert.equal(
    home.value.sessions[0].entry,
    path.join(firstRoot, "report.html"),
  );
  assert.equal(home.value.sessions[0].root, firstRoot);

  const other = await jsonCli(["serve", "report.html"], secondRoot);
  assert.equal(other.code, 0);
  assert.notEqual(other.value.session.id, firstCall.value.session.id);
  assert.notEqual(
    new URL(other.value.session.url).hostname,
    new URL(firstCall.value.session.url).hostname,
  );

  const stopped = await jsonCli(["stop", firstCall.value.session.id]);
  assert.equal(stopped.value.stop.status, "stopped");
  const stoppedAgain = await jsonCli(["stop", firstCall.value.session.id]);
  assert.equal(stoppedAgain.value.stop.status, "already_stopped");
  const toonNoOp = await toonCli(["stop", firstCall.value.session.id]);
  assert.deepEqual(toonNoOp.value, stoppedAgain.value);
  assert.equal((await jsonCli(["stop", "--all"])).value.stop.stopped, 1);

  const beforeCrash = await jsonCli(["serve", "report.html"]);
  const crashedDiscovery = JSON.parse(
    await readFile(path.join(stateDirectory, "supervisor.json"), "utf8"),
  );
  process.kill(crashedDiscovery.pid, "SIGKILL");
  await new Promise((resolve) => setTimeout(resolve, 50));
  const afterCrash = await jsonCli(["serve", "report.html"]);
  assert.equal(afterCrash.code, 0);
  assert.notEqual(afterCrash.value.session.url, beforeCrash.value.session.url);
  assert.notEqual(
    new URL(afterCrash.value.session.url).hostname,
    new URL(beforeCrash.value.session.url).hostname,
  );

  const gracefulDiscovery = JSON.parse(
    await readFile(path.join(stateDirectory, "supervisor.json"), "utf8"),
  );
  assert.equal(
    (await stat(path.join(stateDirectory, "supervisor.json"))).mode & 0o777,
    0o600,
  );
  process.kill(gracefulDiscovery.pid, "SIGTERM");
  const shutdownDeadline = Date.now() + 2_000;
  while (Date.now() < shutdownDeadline) {
    const stillPresent = await readFile(
      path.join(stateDirectory, "supervisor.json"),
    )
      .then(() => true)
      .catch(() => false);
    if (!stillPresent) break;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  await assert.rejects(fetch(afterCrash.value.session.url));
  assert.equal((await jsonCli([])).value.count, 0);

  assert.equal((await stat(stateDirectory)).mode & 0o777, 0o700);
  assert.deepEqual(await readdir(firstRoot), ["report.html"]);
  assert.deepEqual(await readdir(secondRoot), ["report.html"]);
});
