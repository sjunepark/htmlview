import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { describe, it } from "vitest";
import { Result } from "effect";
import {
  decodeControlError,
  decodeCreateReviewRequest,
  decodeCreateSessionRequest,
  decodeDeleteReviewControlResult,
  decodeDeleteReviewRequest,
  decodeFeedbackControlResult,
  decodeFeedbackRequest,
  decodeCurrentSupervisorIdentity,
  decodeServeControlResult,
  decodeReviewControlResult,
  decodeSessionFieldSelection,
  decodeSessionListResult,
  decodeSupervisorStateResult,
  decodeShutdownRequest,
  decodeStopControlResult,
  decodeStopSessionRequest,
  decodeSupervisorIdentity,
  decodeTargetedStopControlResult,
  encodeControlError,
  encodeCreateReviewRequest,
  encodeCreateSessionRequest,
  encodeDeleteReviewControlResult,
  encodeDeleteReviewRequest,
  encodeFeedbackControlResult,
  encodeFeedbackRequest,
  encodeServeControlResult,
  encodeReviewControlResult,
  encodeSessionListResult,
  encodeSupervisorStateResult,
  encodeShutdownRequest,
  encodeStopControlResult,
  encodeStopSessionRequest,
  encodeSupervisorIdentity,
  encodeTargetedStopControlResult,
  maximumConcurrentSessions,
  maximumControlBodyBytes,
  maximumControlResponseBytes,
  maximumRetainedReviews,
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

const review = {
  id: "rv_0123456789abcdefABCDEF",
  status: "ready" as const,
  session: session.id,
  drafts: 0,
  unacknowledged: 0,
};

const reviewResult = {
  review: {
    id: review.id,
    status: "ready" as const,
    url: "http://r-fedcba9876543210fedcba9876543210.localhost:4322/",
    reused: false,
  },
  session: { id: session.id, url: session.url },
  grant: {
    root: session.root,
    access: "read_all_regular_files_beneath_root" as const,
  },
  fidelity: "instrumented_review" as const,
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
      accepted(
        decodeCreateReviewRequest(
          encodeCreateReviewRequest({ session: "arbitrary-missing-selector" }),
        ),
      ),
      { session: "arbitrary-missing-selector" },
    );
    assert.deepEqual(
      accepted(decodeShutdownRequest(encodeShutdownRequest({}))),
      {},
    );
    assert.deepEqual(
      accepted(
        decodeFeedbackRequest(
          encodeFeedbackRequest({
            review: "arbitrary-missing-selector",
            wait: true,
            after: 2,
          }),
        ),
      ),
      { review: "arbitrary-missing-selector", wait: true, after: 2 },
    );
    assert.deepEqual(
      accepted(
        decodeDeleteReviewRequest(
          encodeDeleteReviewRequest({
            review: "arbitrary-missing-selector",
            discardFeedback: true,
          }),
        ),
      ),
      { review: "arbitrary-missing-selector", discardFeedback: true },
    );

    const listed = accepted(
      decodeSessionListResult(encodeSessionListResult({ sessions: [session] })),
    );
    assert.deepEqual(listed.sessions, [session]);
    assert.deepEqual(
      accepted(
        decodeSupervisorStateResult(
          encodeSupervisorStateResult({
            sessions: [session],
            reviews: [review],
          }),
        ),
      ),
      { sessions: [session], reviews: [review] },
    );

    const served = accepted(
      decodeServeControlResult(
        encodeServeControlResult({ session, reused: false }),
      ),
    );
    assert.deepEqual(served, { session, reused: false });
    assert.deepEqual(
      accepted(
        decodeReviewControlResult(encodeReviewControlResult(reviewResult)),
      ),
      reviewResult,
    );
    assert.deepEqual(
      accepted(
        decodeStopControlResult(encodeStopControlResult({ stopped: 1 })),
      ),
      { stopped: 1 },
    );
    const feedback = {
      review: { id: review.id, status: "ready" as const },
      cursor: 1,
      count: 1,
      feedback: [
        {
          id: "fb_0123456789abcdefABCDEF",
          kind: "freeform" as const,
          comment: "Move the action",
          entry: "/report.html",
          revision: `sha256:${"0".repeat(64)}`,
        },
      ],
    };
    assert.deepEqual(
      accepted(
        decodeFeedbackControlResult(encodeFeedbackControlResult(feedback)),
      ),
      feedback,
    );
    const deleted = {
      delete: {
        review: review.id,
        deleted: 1 as const,
        status: "deleted" as const,
        discarded: { drafts: 1, feedback: 2 },
      },
    };
    assert.deepEqual(
      accepted(
        decodeDeleteReviewControlResult(
          encodeDeleteReviewControlResult(deleted),
        ),
      ),
      deleted,
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
    const pending = {
      error: {
        code: "review.pending_feedback" as const,
        message: "Pending feedback remains",
        details: { drafts: 1, unacknowledged: 2 },
      },
    };
    assert.deepEqual(
      accepted(decodeControlError(encodeControlError(pending))),
      pending,
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
      { sessions: [{ ...session, url: `${session.url}?query=forbidden` }] },
      { sessions: [{ ...session, url: `${session.url}#fragment` }] },
      { sessions: [{ ...session, url: session.url.replace("h-", "H-") }] },
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
      { sessions: [], reviews: [], extra: true },
      { sessions: [], reviews: [{ ...review, id: "rv_bad" }] },
      { sessions: [], reviews: [{ ...review, status: "pending" }] },
      { sessions: [], reviews: [{ ...review, drafts: -1 }] },
      {
        sessions: [],
        reviews: Array.from(
          { length: maximumRetainedReviews + 1 },
          () => review,
        ),
      },
    ])
      rejected(decodeSupervisorStateResult(value));

    for (const value of [
      {},
      { ...reviewResult, extra: true },
      {
        ...reviewResult,
        review: { ...reviewResult.review, url: session.url },
      },
      {
        ...reviewResult,
        review: {
          ...reviewResult.review,
          url: `${reviewResult.review.url}?query=forbidden`,
        },
      },
      {
        ...reviewResult,
        review: {
          ...reviewResult.review,
          url: reviewResult.review.url.replace("r-", "R-"),
        },
      },
      {
        ...reviewResult,
        fidelity: "raw",
      },
    ])
      rejected(decodeReviewControlResult(value));

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
    assert.deepEqual(
      accepted(decodeCreateReviewRequest({ session: "short" })),
      { session: "short" },
    );
    rejected(decodeCreateReviewRequest({ session: session.id, extra: true }));
    rejected(
      decodeFeedbackRequest({ review: review.id, wait: false, after: -1 }),
    );
    rejected(
      decodeFeedbackRequest({ review: review.id, wait: false, extra: true }),
    );
    rejected(
      decodeDeleteReviewRequest({
        review: review.id,
        discardFeedback: false,
        extra: true,
      }),
    );
  });
});
