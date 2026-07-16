import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { errorResult } from "../src/contracts.js";
import {
  ContentListenerError,
  ControlError,
  operationalError,
  PathError,
  ReviewError,
  RuntimeStateError,
  SupervisorError,
  toPublicError,
} from "../src/errors.js";

describe("operational errors", () => {
  it("keeps required error fields authoritative over details", () => {
    assert.deepEqual(
      errorResult("path.entry_not_found", "Entry is missing", {
        code: "overridden",
        message: "overridden",
        entry: "report.html",
      }),
      {
        error: {
          code: "path.entry_not_found",
          message: "Entry is missing",
          entry: "report.html",
        },
      },
    );
  });

  it("projects every recovery category to only safe public fields", () => {
    const errors = [
      new PathError({
        code: "path.entry_not_found",
        message: "Entry file does not exist: report.html",
        cause: new Error("private filesystem detail"),
      }),
      new RuntimeStateError({
        code: "state.unavailable",
        message: "The private htmlview runtime state directory is unavailable",
      }),
      new ControlError({
        code: "control.invalid_request",
        message: "Invalid control request",
      }),
      new SupervisorError({
        code: "supervisor.unavailable",
        message: "The htmlview supervisor became unavailable",
      }),
      new ContentListenerError({
        code: "http.start_failed",
        message: "The loopback content listener could not start",
      }),
      new ReviewError({
        code: "review.session_not_found",
        message: "The raw session is not available",
      }),
    ];

    for (const error of errors) {
      assert.deepEqual(toPublicError(error), {
        code: error.code,
        message: error.message,
      });
      assert.deepEqual(Object.keys(toPublicError(error)).sort(), [
        "code",
        "message",
      ]);
    }
  });

  it("constructs only declared operational codes", () => {
    assert.ok(
      operationalError("path.entry_not_found", "missing") instanceof PathError,
    );
    assert.ok(
      operationalError("control.session_limit", "full") instanceof ControlError,
    );
    assert.ok(operationalError("review.limit", "full") instanceof ReviewError);
    assert.equal(operationalError("runtime.internal", "defect"), undefined);
    assert.equal(operationalError("control.future", "unknown"), undefined);
  });
});
