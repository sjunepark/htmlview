import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import {
  access,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { createServer } from "node:net";
import path from "node:path";
import { promisify } from "node:util";
import { chromium, expect } from "@playwright/test";
import {
  assertProcessGroupPlatform,
  processIdentity,
  processIsRunning,
  runProcessGroup,
} from "./process.mjs";
import {
  codexPermissionConfig,
  permissionProfileName,
} from "./sandbox-profile.mjs";
import {
  combineFailures,
  stopSupervisorSafely,
} from "./supervisor-cleanup.mjs";

const execute = promisify(execFile);
const repository = process.cwd();
assertProcessGroupPlatform();
const codexBinary = process.env.HTMLVIEW_CODEX_BINARY ?? "codex";
const codexModel = process.env.HTMLVIEW_CODEX_MODEL;
const timeoutMilliseconds = parseTimeout(
  process.env.HTMLVIEW_CODEX_TIMEOUT_MS ?? "300000",
);
const temporary = await mkdtemp(path.join(tmpdir(), "htmlview-codex-"));
const artifacts = path.join(temporary, "artifacts");
const packageSource = path.join(temporary, "package-source");
const prefix = path.join(temporary, "prefix");
const workspace = path.join(temporary, "workspace");
const fixture = path.join(workspace, "site");
const state = path.join(temporary, "state");
const entry = path.join(fixture, "report.html");
const binary = path.join(prefix, "bin", "htmlview");
const controlSocket = path.join(state, "control.sock");
const supervisorLock = path.join(state, "supervisor.lock");
const sandboxCodexHome = path.join(temporary, "sandbox-codex-home");
const sandboxReadCanary = path.join(temporary, "sandbox-read-canary.txt");
const sandboxWriteCanary = path.join(temporary, "sandbox-write-canary");
const deniedSocket = path.join(state, "sandbox-denied.sock");
const sandboxEnvironmentCanary = "HTMLVIEW_SANDBOX_ENV_CANARY";
const initial =
  '<!doctype html><html><body><button id="save">Save</button><p>Keep this text</p></body></html>\n';
const comment =
  "Change the button text from Save to exactly Submit report. Do not change any other content.";
const expected = initial.replace(">Save<", ">Submit report<");

function parseTimeout(value) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1_000 || parsed > 2_147_483_647)
    throw new Error(
      "HTMLVIEW_CODEX_TIMEOUT_MS must be an integer from 1000 through 2147483647",
    );
  return parsed;
}

function withoutModelCredentials(overrides = {}) {
  const environment = { ...process.env, ...overrides };
  for (const name of ["CODEX_ACCESS_TOKEN", "CODEX_API_KEY", "OPENAI_API_KEY"])
    delete environment[name];
  return environment;
}

function diagnostic(error) {
  if (error === null || typeof error !== "object") return String(error);
  return [
    error.message,
    error.stdout === undefined ? undefined : `stdout:\n${error.stdout}`,
    error.stderr === undefined ? undefined : `stderr:\n${error.stderr}`,
  ]
    .filter((line) => line !== undefined && line !== "")
    .join("\n");
}

async function checked(command, args, options = {}) {
  try {
    return await execute(command, args, {
      cwd: options.cwd ?? repository,
      env: options.env ?? withoutModelCredentials(),
      maxBuffer: 10 * 1024 * 1024,
      timeout: options.timeout,
    });
  } catch (error) {
    throw new Error(
      `${command} ${args.join(" ")} failed\n${diagnostic(error)}`,
      { cause: error },
    );
  }
}

async function installed(args) {
  return checked(binary, args, {
    cwd: fixture,
    env: withoutModelCredentials({
      HTMLVIEW_IDLE_MS: "10000",
      HTMLVIEW_STATE_DIR: state,
    }),
  });
}

async function waitForSupervisorExit(pid) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const [socketPresent, lockPresent] = await Promise.all(
      [controlSocket, supervisorLock].map((candidate) =>
        access(candidate)
          .then(() => true)
          .catch(() => false),
      ),
    );
    const processPresent = processIsRunning(pid);
    if (!socketPresent && !lockPresent && !processPresent) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(
    "Codex validation retained the htmlview process, socket, or lock after stop --all",
  );
}

async function waitForSupervisorProcessExit(pid) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (processIdentity(pid) !== supervisorProcessIdentity) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("Codex validation retained the htmlview supervisor process");
}

function expectedSupervisorIsCurrent() {
  if (
    supervisorPid === undefined ||
    supervisorNonce === undefined ||
    supervisorProcessIdentity === undefined ||
    processIdentity(supervisorPid) !== supervisorProcessIdentity
  )
    return false;
  try {
    const owner = JSON.parse(
      readFileSync(path.join(supervisorLock, "owner.json"), "utf8"),
    );
    return owner.pid === supervisorPid && owner.nonce === supervisorNonce;
  } catch {
    return false;
  }
}

function inspectSupervisorProcess() {
  if (!processIsRunning(supervisorPid)) return "exited";
  if (
    supervisorProcessIdentity !== undefined &&
    processIdentity(supervisorPid) !== supervisorProcessIdentity
  )
    return "exited";
  return expectedSupervisorIsCurrent() ? "running" : "unverified";
}

function signalSupervisor(pid, signal) {
  if (pid !== supervisorPid || !expectedSupervisorIsCurrent())
    throw new Error("htmlview supervisor process identity changed");
  try {
    process.kill(pid, signal);
  } catch (error) {
    if (error?.code !== "ESRCH") throw error;
  }
}

async function git(args) {
  return checked("git", args, {
    cwd: workspace,
    env: withoutModelCredentials(),
  });
}

function parseJsonLines(output) {
  return output
    .trim()
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => JSON.parse(line));
}

function listen(socketPath) {
  const server = createServer((socket) => socket.end());
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => resolve(server));
  });
}

function loopbackRequest(url) {
  const target = new URL(url);
  return new Promise((resolve, reject) => {
    const operation = request(
      {
        hostname: "127.0.0.1",
        port: target.port,
        path: `${target.pathname}${target.search}`,
        method: "GET",
        headers: { host: target.host },
      },
      (response) => {
        const chunks = [];
        response.on("data", (chunk) => chunks.push(chunk));
        response.on("end", () =>
          resolve({
            status: response.statusCode,
            body: Buffer.concat(chunks),
          }),
        );
      },
    );
    operation.setTimeout(5_000, () =>
      operation.destroy(new Error(`HTTP request for ${target.host} timed out`)),
    );
    operation.on("error", reject);
    operation.end();
  });
}

let browser;
let supervisorMayExist = false;
let supervisorPid;
let supervisorNonce;
let supervisorProcessIdentity;
let result;
let primaryFailure;

try {
  await checked(codexBinary, ["--version"]);
  browser = await chromium.launch({
    headless: true,
    env: withoutModelCredentials(),
  });
  process.stderr.write("Preparing an isolated installed htmlview package...\n");
  await Promise.all([
    mkdir(artifacts),
    mkdir(fixture, { recursive: true }),
    mkdir(sandboxCodexHome),
    cp(repository, packageSource, {
      recursive: true,
      filter: (candidate) => {
        const first = path.relative(repository, candidate).split(path.sep)[0];
        return ![
          ".git",
          "coverage",
          "dist",
          "node_modules",
          "playwright-report",
          "test-results",
        ].includes(first);
      },
    }),
  ]);
  await symlink(
    path.join(repository, "node_modules"),
    path.join(packageSource, "node_modules"),
  );
  await Promise.all([
    writeFile(entry, initial),
    writeFile(sandboxReadCanary, "sandbox read canary\n"),
    writeFile(
      path.join(workspace, "AGENTS.md"),
      "# Acceptance fixture\n\nOnly edit `site/report.html` when the task explicitly requires it. Do not create files or commits.\n",
    ),
  ]);
  const packed = JSON.parse(
    (
      await checked(
        "pnpm",
        ["pack", "--json", "--pack-destination", artifacts],
        { cwd: packageSource },
      )
    ).stdout,
  );
  const tarball = path.resolve(artifacts, packed.filename);
  await checked("npm", [
    "install",
    "--global",
    tarball,
    "--prefix",
    prefix,
    "--ignore-scripts",
  ]);
  await git(["init", "--quiet"]);
  await git(["config", "user.name", "htmlview validation"]);
  await git(["config", "user.email", "validation@htmlview.invalid"]);
  await git(["add", "AGENTS.md", "site/report.html"]);
  await git(["commit", "--quiet", "-m", "Add Codex validation fixture"]);
  const initialHead = (await git(["rev-parse", "HEAD"])).stdout.trim();

  supervisorMayExist = true;
  const served = JSON.parse(
    (await installed(["serve", "report.html", "--json"])).stdout,
  );
  const supervisorOwner = JSON.parse(
    await readFile(path.join(supervisorLock, "owner.json"), "utf8"),
  );
  supervisorPid = supervisorOwner.pid;
  supervisorNonce = supervisorOwner.nonce;
  supervisorProcessIdentity = processIdentity(supervisorPid);
  const opened = JSON.parse(
    (await installed(["review", served.session.id, "--json"])).stdout,
  );

  const permissionConfig = codexPermissionConfig({
    workspace,
    fixture,
    state,
    prefix,
    controlSocket,
    binary,
    nodeBinary: process.execPath,
    runtimeReadRoots:
      process.platform === "darwin"
        ? ["/System/Library/OpenSSL"]
        : ["/etc/ssl"],
  });
  const sandboxed = (args) =>
    checked(
      codexBinary,
      [
        "sandbox",
        "-P",
        permissionProfileName,
        "-C",
        workspace,
        ...permissionConfig,
        ...args,
      ],
      {
        cwd: workspace,
        env: withoutModelCredentials({
          CODEX_HOME: sandboxCodexHome,
          HTMLVIEW_STATE_DIR: state,
          [sandboxEnvironmentCanary]: "must-not-reach-generated-commands",
        }),
      },
    );

  await sandboxed(["/bin/cat", entry]);
  const sandboxEnvironment = (await sandboxed(["/usr/bin/env"])).stdout;
  assert.equal(sandboxEnvironment.includes(sandboxEnvironmentCanary), false);
  assert.equal(
    sandboxEnvironment.includes("must-not-reach-generated-commands"),
    false,
  );
  await sandboxed(["/bin/mkdir", path.join(fixture, ".sandbox-write-canary")]);
  await assert.rejects(sandboxed(["/bin/cat", sandboxReadCanary]));
  await assert.rejects(sandboxed(["/bin/mkdir", sandboxWriteCanary]));
  await rm(path.join(fixture, ".sandbox-write-canary"), { recursive: true });
  await assert.rejects(access(sandboxWriteCanary));
  const sandboxFeedback = JSON.parse(
    (await sandboxed([binary, "feedback", opened.review.id, "--json"])).stdout,
  );
  assert.equal(sandboxFeedback.count, 0);
  const deniedServer = await listen(deniedSocket);
  try {
    await assert.rejects(
      sandboxed([
        process.execPath,
        "-e",
        [
          'const { connect } = require("node:net");',
          "const socket = connect(process.argv[1]);",
          'socket.once("connect", () => process.exit(0));',
          'socket.once("error", () => process.exit(2));',
          "setTimeout(() => process.exit(3), 1_000).unref();",
        ].join(""),
        deniedSocket,
      ]),
    );
  } finally {
    await new Promise((resolve, reject) =>
      deniedServer.close((error) =>
        error === undefined ? resolve() : reject(error),
      ),
    );
  }

  const page = await browser.newPage();
  await page.goto(opened.review.url);
  const content = page.frameLocator("#content");
  await expect(page.locator("#live")).toHaveText("Annotation tools ready");
  await expect(content.locator("#save")).toHaveText("Save");
  await content.locator("#save").click();
  await page.locator("#comment").fill(comment);
  await page.getByRole("button", { name: "Add draft" }).click();
  await page.getByRole("button", { name: "Send selected" }).click();
  await expect(page.locator("#live")).toHaveText("1 draft sent");

  process.stderr.write("Running a fresh, ephemeral Codex agent session...\n");
  const prompt = [
    `A controlled htmlview review with ID ${opened.review.id} has exactly one submitted feedback batch.`,
    `Read it with \`htmlview feedback ${opened.review.id} --json\` and use the numeric cursor in that result.`,
    "Apply only the requested edit to site/report.html; do not create files, change other content, commit, or wait for another batch.",
    `After editing, acknowledge with \`htmlview feedback ${opened.review.id} --after CURSOR --json\`, replacing CURSOR with that numeric value.`,
    `Before exiting, run \`htmlview feedback ${opened.review.id} --json\` again and require count zero; correct the acknowledgement if it is not zero.`,
  ].join(" ");
  const codexArguments = [
    "exec",
    "-C",
    workspace,
    "--strict-config",
    ...permissionConfig,
    "--ignore-user-config",
    "--ignore-rules",
    "--ephemeral",
    "--json",
    "--color",
    "never",
  ];
  if (codexModel !== undefined) codexArguments.push("--model", codexModel);
  codexArguments.push(prompt);
  const codex = await runProcessGroup(codexBinary, codexArguments, {
    cwd: workspace,
    env: { ...process.env },
    timeoutMilliseconds,
  });
  assert.equal(
    codex.termination,
    undefined,
    `codex exec terminated because of ${codex.termination}\nstdout:\n${codex.stdout}\nstderr:\n${codex.stderr}`,
  );
  assert.equal(
    codex.code,
    0,
    `codex exec failed with signal ${codex.signal ?? "none"}\nstdout:\n${codex.stdout}\nstderr:\n${codex.stderr}`,
  );
  const events = parseJsonLines(codex.stdout);
  assert.equal(
    events.some((event) => event.type === "thread.started"),
    true,
    "codex exec did not start a thread",
  );
  assert.equal(
    events.some((event) => event.type === "turn.completed"),
    true,
    "codex exec did not complete its turn",
  );
  assert.equal(
    events.some(
      (event) => event.type === "turn.failed" || event.type === "error",
    ),
    false,
    `codex exec emitted a failure event\n${codex.stdout}`,
  );
  const commandEvents = events
    .filter((event) => event.item?.type === "command_execution")
    .map((event) => event.item.command)
    .filter((command) => typeof command === "string");
  const completedCommands = events
    .filter(
      (event) =>
        event.item?.type === "command_execution" &&
        event.item.status === "completed",
    )
    .map((event) => event.item)
    .filter(
      (item) =>
        typeof item.command === "string" &&
        typeof item.aggregated_output === "string",
    );
  assert.equal(
    completedCommands.some(
      (item) =>
        item.command.includes("htmlview feedback") &&
        item.aggregated_output.includes('"count":1'),
    ),
    true,
    `Codex did not successfully read htmlview feedback\n${codex.stdout}`,
  );
  assert.equal(
    completedCommands.some(
      (item) =>
        item.command.includes("htmlview feedback") &&
        item.command.includes("--after") &&
        item.aggregated_output.includes('"count":0'),
    ),
    true,
    `Codex did not successfully acknowledge the feedback cursor\n${codex.stdout}`,
  );

  assert.equal((await git(["rev-parse", "HEAD"])).stdout.trim(), initialHead);
  assert.deepEqual(
    (await git(["diff", "--name-only", "HEAD"])).stdout
      .trim()
      .split("\n")
      .filter(Boolean),
    ["site/report.html"],
  );
  assert.deepEqual(
    (await git(["status", "--porcelain", "--untracked-files=all"])).stdout
      .trimEnd()
      .split("\n")
      .filter(Boolean)
      .map((line) => line.slice(3)),
    ["site/report.html"],
  );
  const changed = await readFile(entry, "utf8");
  assert.equal(changed, expected);

  const remaining = JSON.parse(
    (await installed(["feedback", opened.review.id, "--json"])).stdout,
  );
  assert.equal(
    remaining.count,
    0,
    `Codex did not acknowledge the batch\ncommands:\n${commandEvents.join("\n")}\nremaining:\n${JSON.stringify(remaining)}\nevents:\n${codex.stdout}`,
  );
  assert.deepEqual(remaining.feedback, []);
  assert.equal(remaining.cursor > 0, true);

  await expect(content.locator("#save")).toHaveText("Submit report");
  await expect(content.locator("p")).toHaveText("Keep this text");
  const raw = await loopbackRequest(served.session.url);
  assert.equal(raw.status, 200);
  assert.equal(raw.body.toString("utf8"), expected);

  await browser.close();
  browser = undefined;
  await installed(["review", "delete", opened.review.id, "--json"]);
  result = {
    codex: "passed",
    feedback: "acknowledged",
    raw: "updated",
    review: "refreshed",
  };
} catch (error) {
  primaryFailure = error;
}

const cleanupFailures = [];
if (browser !== undefined) {
  try {
    await browser.close();
  } catch (error) {
    cleanupFailures.push(new Error("browser cleanup failed", { cause: error }));
  }
}

let safeToRemove = !supervisorMayExist;
if (supervisorMayExist) {
  try {
    const cleanup = await stopSupervisorSafely({
      pid: supervisorPid,
      requestStop: () => installed(["stop", "--all", "--json"]),
      waitForCleanExit: () => waitForSupervisorExit(supervisorPid),
      waitForProcessExit: () => waitForSupervisorProcessExit(supervisorPid),
      signalProcess: signalSupervisor,
      inspectProcess: inspectSupervisorProcess,
    });
    cleanupFailures.push(...cleanup.failures);
    safeToRemove = cleanup.safeToRemove;
  } catch (error) {
    cleanupFailures.push(
      new Error("supervisor cleanup failed unexpectedly", { cause: error }),
    );
    safeToRemove = false;
  }
}

if (safeToRemove) {
  try {
    await rm(temporary, { recursive: true, force: true });
  } catch (error) {
    cleanupFailures.push(
      new Error("temporary fixture cleanup failed", { cause: error }),
    );
  }
} else {
  cleanupFailures.push(
    new Error(
      `A live htmlview supervisor may remain; private state was retained at ${temporary}`,
    ),
  );
}

const combinedFailure = combineFailures(primaryFailure, cleanupFailures);
if (combinedFailure !== undefined) throw combinedFailure;
process.stdout.write(`${JSON.stringify(result)}\n`);
