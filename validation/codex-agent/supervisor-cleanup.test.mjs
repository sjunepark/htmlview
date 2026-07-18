import assert from "node:assert/strict";
import { test } from "node:test";
import {
  combineFailures,
  stopSupervisorSafely,
} from "./supervisor-cleanup.mjs";

function rejected(message) {
  return () => Promise.reject(new Error(message));
}

test("graceful supervisor cleanup needs no process signal", async () => {
  const signals = [];
  const result = await stopSupervisorSafely({
    pid: 42,
    requestStop: async () => undefined,
    waitForCleanExit: async () => undefined,
    waitForProcessExit: async () => undefined,
    signalProcess: (...signal) => signals.push(signal),
    inspectProcess: () => "running",
  });

  assert.deepEqual(result, { safeToRemove: true, failures: [] });
  assert.deepEqual(signals, []);
});

test("a failed stop is retained after the process exits cleanly", async () => {
  const result = await stopSupervisorSafely({
    pid: 42,
    requestStop: rejected("stop failed"),
    waitForCleanExit: async () => undefined,
    waitForProcessExit: async () => undefined,
    signalProcess: () => undefined,
    inspectProcess: () => "exited",
  });

  assert.equal(result.safeToRemove, true);
  assert.deepEqual(
    result.failures.map((failure) => failure.message),
    ["htmlview stop --all failed"],
  );
  assert.match(result.failures[0].cause.message, /stop failed/);
});

test("cleanup escalates from SIGTERM to SIGKILL", async () => {
  const signals = [];
  const cleanExit = [rejected("graceful timeout"), rejected("term timeout")];
  const result = await stopSupervisorSafely({
    pid: 42,
    requestStop: async () => undefined,
    waitForCleanExit: () => cleanExit.shift()(),
    waitForProcessExit: async () => undefined,
    signalProcess: (pid, signal) => signals.push([pid, signal]),
    inspectProcess: () => "running",
  });

  assert.equal(result.safeToRemove, true);
  assert.deepEqual(signals, [
    [42, "SIGTERM"],
    [42, "SIGKILL"],
  ]);
  assert.deepEqual(
    result.failures.map((failure) => failure.message),
    [
      "graceful supervisor cleanup failed",
      "supervisor cleanup after SIGTERM failed",
    ],
  );
});

test("cleanup preserves state when forced termination cannot be confirmed", async () => {
  const result = await stopSupervisorSafely({
    pid: 42,
    requestStop: async () => undefined,
    waitForCleanExit: rejected("cleanup timeout"),
    waitForProcessExit: rejected("process retained"),
    signalProcess: () => undefined,
    inspectProcess: () => "running",
  });

  assert.equal(result.safeToRemove, false);
  assert.deepEqual(
    result.failures.map((failure) => failure.message),
    [
      "graceful supervisor cleanup failed",
      "supervisor cleanup after SIGTERM failed",
      "supervisor exit after SIGKILL failed",
    ],
  );
});

test("cleanup refuses to signal an unverified process identity", async () => {
  const signals = [];
  const result = await stopSupervisorSafely({
    pid: 42,
    requestStop: async () => undefined,
    waitForCleanExit: rejected("cleanup timeout"),
    waitForProcessExit: async () => undefined,
    signalProcess: (...signal) => signals.push(signal),
    inspectProcess: () => "unverified",
  });

  assert.equal(result.safeToRemove, false);
  assert.deepEqual(signals, []);
  assert.deepEqual(
    result.failures.map((failure) => failure.message),
    [
      "graceful supervisor cleanup failed",
      "supervisor process identity could not be confirmed; refusing to signal it",
    ],
  );
});

test("cleanup preserves state when serve may have started without a PID", async () => {
  const result = await stopSupervisorSafely({
    pid: undefined,
    requestStop: rejected("serve result unavailable"),
    waitForCleanExit: rejected("cleanup unavailable"),
    waitForProcessExit: async () => undefined,
    signalProcess: () => undefined,
    inspectProcess: () => "unverified",
  });

  assert.equal(result.safeToRemove, false);
  assert.deepEqual(
    result.failures.map((failure) => failure.message),
    ["htmlview stop --all failed", "graceful supervisor cleanup failed"],
  );
});

test("primary and cleanup failures remain inspectable", () => {
  const primary = new Error("primary failure");
  const cleanup = new Error("cleanup failure");
  const combined = combineFailures(primary, [cleanup]);

  assert.equal(combined instanceof AggregateError, true);
  assert.deepEqual(combined.errors, [primary, cleanup]);
  assert.equal(combineFailures(primary, []), primary);
  assert.equal(combineFailures(undefined, []), undefined);
});
