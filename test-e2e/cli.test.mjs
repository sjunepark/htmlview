import assert from "node:assert/strict";
import { decode } from "@toon-format/toon";
import { spawn } from "node:child_process";
import {
  mkdtemp,
  lstat,
  readdir,
  readFile,
  realpath,
  stat,
  writeFile,
} from "node:fs/promises";
import { request } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";

const packageVersion = JSON.parse(
  await readFile(new URL("../package.json", import.meta.url), "utf8"),
).version;

let base;
let stateDirectory;
let firstRoot;
let secondRoot;
let environment;

function cli(args, cwd = firstRoot, childEnvironment = environment) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [path.resolve("dist/cli.js"), ...args],
      {
        cwd,
        env: childEnvironment,
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

function supervisorHealth() {
  return new Promise((resolve, reject) => {
    const operation = request(
      {
        socketPath: path.join(stateDirectory, "control.sock"),
        method: "GET",
        path: "/health",
        headers: { host: "htmlview-control" },
      },
      (response) => {
        const chunks = [];
        response.on("data", (chunk) => chunks.push(chunk));
        response.on("end", () =>
          resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))),
        );
      },
    );
    operation.once("error", reject);
    operation.end();
  });
}

function withoutHelp(value) {
  const result = { ...value };
  delete result.help;
  return result;
}

function processExists(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error.code === "ESRCH") return false;
    throw error;
  }
}

async function waitForProcessExit(pid, timeoutMilliseconds = 2_000) {
  const deadline = Date.now() + timeoutMilliseconds;
  while (Date.now() < deadline) {
    if (!processExists(pid)) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.equal(processExists(pid), false, `process ${pid} did not exit`);
}

async function waitForPath(pathname, timeoutMilliseconds = 2_000) {
  const deadline = Date.now() + timeoutMilliseconds;
  while (Date.now() < deadline) {
    if (
      await lstat(pathname)
        .then(() => true)
        .catch(() => false)
    )
      return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  await lstat(pathname);
}

async function activeSupervisorEntry() {
  const launcher = await readFile(path.resolve("dist/cli.js"), "utf8");
  const match = launcher.match(
    /^#!\/usr\/bin\/env node\nimport "\.\/(generations\/[0-9a-f]{64})\/cli\.js";\n$/,
  );
  assert.notEqual(match, null, "build launcher does not select one generation");
  return path.resolve("dist", match[1], "supervisor-main.js");
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
  const { rm } = await import("node:fs/promises");
  await rm(base, { recursive: true, force: true });
});

test("native CLI metadata, syntax, and logging keep their channels", async () => {
  const metadataState = path.join(base, "m");
  const metadataEnvironment = {
    ...environment,
    HTMLVIEW_STATE_DIR: metadataState,
  };
  for (const args of [["--version"], ["-v"], ["--version", "--json"]]) {
    const result = await cli(args, firstRoot, metadataEnvironment);
    assert.deepEqual(result, {
      code: 0,
      signal: null,
      stdout: `htmlview v${packageVersion}\n`,
      stderr: "",
    });
  }
  for (const flag of ["--help", "-h"]) {
    const result = await cli([flag], firstRoot, metadataEnvironment);
    assert.equal(result.code, 0);
    assert.match(result.stdout, /USAGE/);
    assert.match(result.stdout, /SUBCOMMANDS/);
    assert.equal(result.stderr, "");
  }
  for (const shell of ["bash", "sh", "zsh", "fish"]) {
    const result = await cli(
      ["--completions", shell],
      firstRoot,
      metadataEnvironment,
    );
    assert.equal(result.code, 0);
    assert.match(result.stdout, /htmlview/);
    assert.equal(result.stderr, "");
  }
  await assert.rejects(lstat(metadataState));

  const invalid = await cli(["serve"], firstRoot, metadataEnvironment);
  const invalidJson = await cli(
    ["serve", "--json"],
    firstRoot,
    metadataEnvironment,
  );
  assert.equal(invalid.code, 1);
  assert.match(invalid.stdout, /USAGE/);
  assert.match(invalid.stderr, /Missing required argument/);
  assert.equal(invalidJson.stdout, invalid.stdout);
  assert.equal(invalidJson.stderr, invalid.stderr);

  for (const level of [
    "all",
    "trace",
    "debug",
    "info",
    "warn",
    "warning",
    "error",
    "fatal",
    "none",
  ]) {
    const result = await cli(
      ["--json", "--log-level", level],
      firstRoot,
      metadataEnvironment,
    );
    assert.equal(result.code, 0, `${level}: ${JSON.stringify(result)}`);
    assert.equal(JSON.parse(result.stdout).count, 0);
    if (["all", "trace", "debug"].includes(level)) {
      const event = JSON.parse(result.stderr);
      assert.equal(event.level, "debug");
      assert.equal(event.operation, "cli.home");
    } else assert.equal(result.stderr, "", level);
  }
});

test("detached CLI lifecycle converges, recovers, and remains project-clean", async () => {
  const empty = await jsonCli([]);
  assert.equal(empty.code, 0);
  assert.equal(empty.value.count, 0);
  assert.deepEqual(empty.value.sessions, []);

  const toonRuntimeError = await toonCli(["serve", "missing.html"]);
  const jsonRuntimeError = await jsonCli(["serve", "missing.html"]);
  assert.equal(toonRuntimeError.code, 1);
  assert.equal(jsonRuntimeError.code, 1);
  assert.deepEqual(
    withoutHelp(toonRuntimeError.value),
    withoutHelp(jsonRuntimeError.value),
  );
  assert.deepEqual(toonRuntimeError.value.help, [
    "Run `htmlview serve --help` to review entry and root requirements",
  ]);
  assert.deepEqual(jsonRuntimeError.value.help, [
    "Run `htmlview serve --help --json` to review entry and root requirements",
  ]);

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
  assert.equal(stopped.code, 0, JSON.stringify(stopped.value));
  assert.equal(stopped.value.stop.status, "stopped");
  const stoppedAgain = await jsonCli(["stop", firstCall.value.session.id]);
  assert.equal(stoppedAgain.value.stop.status, "already_stopped");
  const toonNoOp = await toonCli(["stop", firstCall.value.session.id]);
  assert.deepEqual(toonNoOp.value, stoppedAgain.value);
  const stopAllOwner = await supervisorHealth();
  assert.equal((await jsonCli(["stop", "--all"])).value.stop.stopped, 1);
  await waitForProcessExit(stopAllOwner.pid);
  await assert.rejects(lstat(path.join(stateDirectory, "control.sock")));
  await assert.rejects(fetch(other.value.session.url));

  const beforeCrash = await jsonCli(["serve", "report.html"]);
  const crashedSupervisor = await supervisorHealth();
  assert.notEqual(crashedSupervisor.instanceId, stopAllOwner.instanceId);
  process.kill(crashedSupervisor.pid, "SIGKILL");
  await waitForProcessExit(crashedSupervisor.pid);
  const afterCrash = await jsonCli(["serve", "report.html"]);
  assert.equal(afterCrash.code, 0);
  assert.notEqual(afterCrash.value.session.url, beforeCrash.value.session.url);
  assert.notEqual(
    new URL(afterCrash.value.session.url).hostname,
    new URL(beforeCrash.value.session.url).hostname,
  );

  const gracefulSupervisor = await supervisorHealth();
  assert.equal(
    (await lstat(path.join(stateDirectory, "control.sock"))).mode & 0o777,
    0o600,
  );
  process.kill(gracefulSupervisor.pid, "SIGTERM");
  const shutdownDeadline = Date.now() + 2_000;
  while (Date.now() < shutdownDeadline) {
    const stillPresent = await lstat(path.join(stateDirectory, "control.sock"))
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

test("supervisor runtime signals close owned state before exit", async () => {
  const { rm } = await import("node:fs/promises");
  for (const signal of ["SIGINT", "SIGTERM"]) {
    const parent = await realpath(
      await mkdtemp(path.join(tmpdir(), "hv-sig-")),
    );
    const signalState = path.join(parent, "state");
    const childEnvironment = {
      ...process.env,
      HTMLVIEW_STATE_DIR: signalState,
      HTMLVIEW_IDLE_MS: "30000",
    };
    delete childEnvironment.HTMLVIEW_SUPERVISOR_LOCK_NONCE;
    const child = spawn(process.execPath, [await activeSupervisorEntry()], {
      env: childEnvironment,
      stdio: "ignore",
    });
    const exited = new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (code, exitSignal) =>
        resolve({ code, signal: exitSignal }),
      );
    });
    try {
      await waitForPath(path.join(signalState, "control.sock"));
      child.kill(signal);
      assert.deepEqual(await exited, { code: 130, signal: null });
      await assert.rejects(lstat(path.join(signalState, "control.sock")));
      await assert.rejects(lstat(path.join(signalState, "supervisor.lock")));
    } finally {
      if (child.pid !== undefined && processExists(child.pid))
        child.kill("SIGKILL");
      await rm(parent, { recursive: true, force: true });
    }
  }
});
