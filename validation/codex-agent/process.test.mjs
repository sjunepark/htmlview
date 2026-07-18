import assert from "node:assert/strict";
import { test } from "node:test";
import { runProcessGroup } from "./process.mjs";

const environment = { ...process.env };

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
    const descendant = [
      "process.on('SIGTERM', () => undefined);",
      "setInterval(() => undefined, 1_000);",
    ].join("");
    const parent = [
      'const { spawn } = require("node:child_process");',
      `const child = spawn(process.execPath, ["-e", ${JSON.stringify(descendant)}], { stdio: ["ignore", "inherit", "inherit"] });`,
      "process.stdout.write(`${child.pid}\\n`);",
      "process.on('SIGTERM', () => undefined);",
      "setInterval(() => undefined, 1_000);",
    ].join("");
    const started = Date.now();
    const result = await runProcessGroup(process.execPath, ["-e", parent], {
      cwd: process.cwd(),
      env: environment,
      timeoutMilliseconds: 100,
      terminationGraceMilliseconds: 100,
      streamDrainMilliseconds: 100,
    });

    assert.equal(result.termination, "timeout");
    assert.equal(result.signal, "SIGKILL");
    assert.equal(result.processGroupRetained, false);
    assert.ok(Date.now() - started < 2_000, "process group exceeded deadline");
    const descendantPid = Number(result.stdout.trim());
    assert.equal(Number.isSafeInteger(descendantPid), true);
    assert.throws(() => process.kill(descendantPid, 0), { code: "ESRCH" });
  },
);

test(
  "a direct-child close does not disarm descendant escalation",
  { skip: process.platform === "win32" },
  async () => {
    const descendant = [
      "process.on('SIGTERM', () => undefined);",
      "setInterval(() => undefined, 1_000);",
    ].join("");
    const parent = [
      'const { spawn } = require("node:child_process");',
      `const child = spawn(process.execPath, ["-e", ${JSON.stringify(descendant)}], { stdio: "ignore" });`,
      "process.stdout.write(`${child.pid}\\n`);",
      "setInterval(() => undefined, 1_000);",
    ].join("");
    const result = await runProcessGroup(process.execPath, ["-e", parent], {
      cwd: process.cwd(),
      env: environment,
      timeoutMilliseconds: 100,
      terminationGraceMilliseconds: 100,
      streamDrainMilliseconds: 1_000,
    });

    assert.equal(result.termination, "timeout");
    assert.equal(result.signal, "SIGTERM");
    assert.equal(result.processGroupRetained, false);
    const descendantPid = Number(result.stdout.trim());
    assert.equal(Number.isSafeInteger(descendantPid), true);
    assert.throws(() => process.kill(descendantPid, 0), { code: "ESRCH" });
  },
);

test(
  "a nominal direct-child exit fails and cleans up a retained descendant",
  { skip: process.platform === "win32" },
  async () => {
    const descendant = [
      "process.on('SIGTERM', () => undefined);",
      "setInterval(() => undefined, 1_000);",
    ].join("");
    const parent = [
      'const { spawn } = require("node:child_process");',
      `const child = spawn(process.execPath, ["-e", ${JSON.stringify(descendant)}], { stdio: "ignore" });`,
      "child.unref();",
      "process.stdout.write(`${child.pid}\\n`, () => process.exit(0));",
    ].join("");
    const result = await runProcessGroup(process.execPath, ["-e", parent], {
      cwd: process.cwd(),
      env: environment,
      timeoutMilliseconds: 5_000,
      terminationGraceMilliseconds: 100,
      streamDrainMilliseconds: 1_000,
    });

    assert.equal(result.code, 0);
    assert.equal(result.termination, "retained_process_group");
    assert.equal(result.processGroupRetained, false);
    const descendantPid = Number(result.stdout.trim());
    assert.equal(Number.isSafeInteger(descendantPid), true);
    assert.throws(() => process.kill(descendantPid, 0), { code: "ESRCH" });
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
