import assert from "node:assert/strict";
import { test } from "node:test";
import {
  assertProcessGroupPlatform,
  processIsRunning,
  runProcessGroup,
} from "./process.mjs";

const environment = { ...process.env };
const stubbornDescendant = [
  "process.on('SIGTERM', () => undefined);",
  "process.send('ready', () => process.disconnect());",
  "setInterval(() => undefined, 1_000);",
].join("");

function readyParent({
  exitAfterReady = false,
  ignoreTermination = false,
  inheritOutput = false,
} = {}) {
  const stdio = inheritOutput
    ? ["ignore", "inherit", "inherit", "ipc"]
    : ["ignore", "ignore", "ignore", "ipc"];
  return [
    'const { spawn } = require("node:child_process");',
    ignoreTermination ? "process.on('SIGTERM', () => undefined);" : undefined,
    `const child = spawn(process.execPath, ["-e", ${JSON.stringify(stubbornDescendant)}], { stdio: ${JSON.stringify(stdio)} });`,
    "child.once('message', (message) => {",
    "if (message !== 'ready') process.exit(2);",
    exitAfterReady
      ? "process.stdout.write(`${child.pid}\\n`, () => process.exit(0));"
      : "process.stdout.write(`${child.pid}\\n`);",
    "});",
    "setInterval(() => undefined, 1_000);",
  ]
    .filter((line) => line !== undefined)
    .join("");
}

test("acceptance process groups support only macOS and Linux", () => {
  assert.doesNotThrow(() => assertProcessGroupPlatform("darwin"));
  assert.doesNotThrow(() => assertProcessGroupPlatform("linux"));
  assert.throws(() => assertProcessGroupPlatform("win32"), /macOS or Linux/);
});

test("captures a completed process result", async () => {
  const result = await runProcessGroup(
    process.execPath,
    ["-e", 'process.stdout.write("complete")'],
    {
      cwd: process.cwd(),
      env: environment,
      timeoutMilliseconds: 5_000,
    },
  );

  assert.deepEqual(result, {
    code: 0,
    signal: null,
    stdout: "complete",
    stderr: "",
    termination: undefined,
    processGroupRetained: false,
  });
});

test(
  "a timeout terminates descendants that retain the output pipes",
  { skip: process.platform === "win32" },
  async () => {
    const started = Date.now();
    const result = await runProcessGroup(
      process.execPath,
      ["-e", readyParent({ ignoreTermination: true, inheritOutput: true })],
      {
        cwd: process.cwd(),
        env: environment,
        timeoutMilliseconds: 1_000,
        terminationGraceMilliseconds: 100,
        streamDrainMilliseconds: 100,
      },
    );

    assert.equal(result.termination, "timeout");
    assert.equal(result.signal, "SIGKILL");
    assert.equal(result.processGroupRetained, false);
    assert.ok(Date.now() - started < 5_000, "process group exceeded deadline");
    const descendantPid = Number(result.stdout.trim());
    assert.equal(Number.isSafeInteger(descendantPid), true);
    assert.equal(processIsRunning(descendantPid), false);
  },
);

test(
  "a direct-child close does not disarm descendant escalation",
  { skip: process.platform === "win32" },
  async () => {
    const result = await runProcessGroup(
      process.execPath,
      ["-e", readyParent()],
      {
        cwd: process.cwd(),
        env: environment,
        timeoutMilliseconds: 1_000,
        terminationGraceMilliseconds: 100,
        streamDrainMilliseconds: 1_000,
      },
    );

    assert.equal(result.termination, "timeout");
    assert.equal(result.signal, "SIGTERM");
    assert.equal(result.processGroupRetained, false);
    const descendantPid = Number(result.stdout.trim());
    assert.equal(Number.isSafeInteger(descendantPid), true);
    assert.equal(processIsRunning(descendantPid), false);
  },
);

test(
  "a nominal direct-child exit fails and cleans up a retained descendant",
  { skip: process.platform === "win32" },
  async () => {
    const result = await runProcessGroup(
      process.execPath,
      ["-e", readyParent({ exitAfterReady: true })],
      {
        cwd: process.cwd(),
        env: environment,
        timeoutMilliseconds: 5_000,
        terminationGraceMilliseconds: 100,
        streamDrainMilliseconds: 1_000,
      },
    );

    assert.equal(result.code, 0);
    assert.equal(result.termination, "retained_process_group");
    assert.equal(result.processGroupRetained, false);
    const descendantPid = Number(result.stdout.trim());
    assert.equal(Number.isSafeInteger(descendantPid), true);
    assert.equal(processIsRunning(descendantPid), false);
  },
);

test("bounded output terminates a noisy process", async () => {
  const result = await runProcessGroup(
    process.execPath,
    [
      "-e",
      'process.stdout.write("x".repeat(8_192)); setInterval(() => undefined, 1_000)',
    ],
    {
      cwd: process.cwd(),
      env: environment,
      timeoutMilliseconds: 5_000,
      terminationGraceMilliseconds: 100,
      streamDrainMilliseconds: 100,
      maximumOutputBytes: 1_024,
    },
  );

  assert.equal(result.termination, "output_limit");
  assert.equal(result.processGroupRetained, false);
  assert.equal(Buffer.byteLength(result.stdout), 1_024);
});
