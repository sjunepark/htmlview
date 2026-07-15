import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { describe, it } from "vitest";
import { Result } from "effect";
import {
  decodeControlError,
  decodeCreateSessionRequest,
  decodeCurrentSupervisorIdentity,
  decodeServeControlResult,
  decodeSessionFieldSelection,
  decodeSessionListResult,
  decodeShutdownRequest,
  decodeStopControlResult,
  decodeStopSessionRequest,
  decodeSupervisorIdentity,
  decodeTargetedStopControlResult,
  encodeControlError,
  encodeCreateSessionRequest,
  encodeServeControlResult,
  encodeSessionListResult,
  encodeShutdownRequest,
  encodeStopControlResult,
  encodeStopSessionRequest,
  encodeSupervisorIdentity,
  encodeTargetedStopControlResult,
  maximumConcurrentSessions,
  maximumControlBodyBytes,
  maximumControlResponseBytes,
  supervisorProtocol,
} from "../src/supervisor/protocol.js";

function accepted<A>(result: Result.Result<A, unknown>): A {
  assert.equal(Result.isSuccess(result), true);
  if (Result.isFailure(result)) throw result.failure;
  return result.success;
}

function rejected(result: Result.Result<unknown, unknown>): void {
  assert.equal(Result.isFailure(result), true);
}

const session = {
  id: "aB3_-xYz",
  status: "ready" as const,
  url: "http://h-0123456789abcdef0123456789abcdef.localhost:4321/report.html",
  entry: "/tmp/report.html",
  root: "/tmp",
};

describe("control protocol schemas", () => {
  it("round-trips every request and success response shape", () => {
    const identity = accepted(
      decodeCurrentSupervisorIdentity({
        protocol: supervisorProtocol,
        instanceId: randomUUID(),
        pid: process.pid,
        version: "0.1.0",
      }),
    );
    assert.deepEqual(
      accepted(decodeSupervisorIdentity(encodeSupervisorIdentity(identity))),
      identity,
    );

    const create = accepted(
      decodeCreateSessionRequest(
        encodeCreateSessionRequest({ entry: "/tmp/report.html", root: "/tmp" }),
      ),
    );
    assert.deepEqual(create, { entry: "/tmp/report.html", root: "/tmp" });

    const stop = accepted(
      decodeStopSessionRequest(
        encodeStopSessionRequest({ session: "arbitrary-missing-selector" }),
      ),
    );
    assert.equal(stop.session, "arbitrary-missing-selector");
    assert.deepEqual(
      accepted(decodeShutdownRequest(encodeShutdownRequest({}))),
      {},
    );

    const listed = accepted(
      decodeSessionListResult(encodeSessionListResult({ sessions: [session] })),
    );
    assert.deepEqual(listed.sessions, [session]);

    const served = accepted(
      decodeServeControlResult(
        encodeServeControlResult({ session, reused: false }),
      ),
    );
    assert.deepEqual(served, { session, reused: false });
    assert.deepEqual(
      accepted(
        decodeStopControlResult(encodeStopControlResult({ stopped: 1 })),
      ),
      { stopped: 1 },
    );

    const error = {
      error: {
        code: "control.invalid_request" as const,
        message: "Invalid control request",
      },
    };
    assert.deepEqual(
      accepted(decodeControlError(encodeControlError(error))),
      error,
    );
  });

  it("preserves semantic version and protocol mismatch detection", () => {
    const foreign = {
      protocol: "foreign-supervisor-v1",
      instanceId: randomUUID(),
      pid: process.pid,
      version: "9.9.9",
    };
    assert.equal(Result.isSuccess(decodeSupervisorIdentity(foreign)), true);
    rejected(decodeCurrentSupervisorIdentity(foreign));
  });

  it("rejects malformed, excess, and out-of-bound values", () => {
    for (const value of [
      null,
      {},
      { sessions: "not-an-array" },
      { sessions: [], extra: true },
      { sessions: [{ ...session, id: "bad" }] },
      { sessions: [{ ...session, id: "-B3_-xYz" }] },
      { sessions: [{ ...session, status: "starting" }] },
      { sessions: [{ ...session, url: "http://example.com/report.html" }] },
      {
        sessions: Array.from(
          { length: maximumConcurrentSessions + 1 },
          () => session,
        ),
      },
    ])
      rejected(decodeSessionListResult(value));

    for (const value of [
      {},
      { session, reused: "false" },
      { session, reused: false, extra: true },
    ])
      rejected(decodeServeControlResult(value));

    for (const value of [
      { stopped: -1 },
      { stopped: maximumConcurrentSessions + 1 },
      { stopped: 0, extra: true },
    ])
      rejected(decodeStopControlResult(value));

    assert.deepEqual(
      accepted(
        decodeTargetedStopControlResult(
          encodeTargetedStopControlResult({ stopped: 1 }),
        ),
      ),
      {
        stopped: 1,
      },
    );
    rejected(decodeTargetedStopControlResult({ stopped: 2 }));

    for (const value of [
      { error: { code: "control.unknown", message: "unknown" } },
      { error: { code: "control.invalid_request", message: 1 } },
      {
        error: {
          code: "control.invalid_request",
          message: "x".repeat(maximumControlResponseBytes + 1),
        },
      },
      {
        error: {
          code: "control.invalid_request",
          message: "valid",
          cause: "private",
        },
      },
    ])
      rejected(decodeControlError(value));
  });

  it("validates exact request shapes without narrowing stop no-ops", () => {
    assert.deepEqual(accepted(decodeStopSessionRequest({ session: "" })), {
      session: "",
    });
    assert.deepEqual(accepted(decodeSessionFieldSelection([])), []);
    assert.deepEqual(accepted(decodeSessionFieldSelection(["root", "entry"])), [
      "root",
      "entry",
    ]);

    for (const value of [
      {},
      { entry: "/tmp/report.html" },
      { entry: 1, root: "/tmp" },
      { entry: "/tmp/report.html", root: "/tmp", extra: true },
      { entry: "x".repeat(maximumControlBodyBytes + 1), root: "/tmp" },
    ])
      rejected(decodeCreateSessionRequest(value));

    rejected(decodeStopSessionRequest({ session: 1 }));
    rejected(decodeStopSessionRequest({ session: "missing", extra: true }));
    rejected(decodeShutdownRequest({ extra: true }));
    rejected(decodeSessionFieldSelection(["entry", "entry"]));
    rejected(decodeSessionFieldSelection(["unknown"]));
  });
});
