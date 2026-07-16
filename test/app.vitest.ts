import assert from "node:assert/strict";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, it } from "vitest";
import { Effect, Exit, Fiber, Layer } from "effect";
import { runApp } from "../src/app.js";
import { decodeOutput } from "../src/output.js";
import type { OutputFormat } from "../src/contracts.js";
import {
  ContentListenerError,
  ControlError,
  isOperationalError,
  RuntimeStateError,
  SupervisorError,
} from "../src/errors.js";
import { CommandService } from "../src/service.js";
import type {
  OptionalSessionField,
  ReviewSummary,
  SessionSummary,
} from "../src/supervisor/protocol.js";

async function invoke(
  args: string[],
  sessions: SessionSummary[] = [],
  serveFailure?: unknown,
  reviews: ReviewSummary[] = [],
) {
  let stdout = "";
  let stderr = "";
  let listedFields: readonly OptionalSessionField[] | undefined;
  const stopCalls: string[] = [];
  const annotationCalls: string[] = [];
  const service = Layer.succeed(CommandService, {
    listState: (fields) =>
      Effect.sync(() => {
        listedFields = fields;
        return { sessions, reviews };
      }),
    serve: () => {
      if (serveFailure !== undefined)
        return isOperationalError(serveFailure)
          ? Effect.fail(serveFailure)
          : Effect.die(serveFailure);
      return Effect.succeed({
        session: {
          id: "served1",
          status: "ready",
          url: "http://h-served.localhost:4000/report.html",
          reused: false,
        },
        grant: {
          root: "/tmp",
          access: "read_all_regular_files_beneath_root",
        },
      });
    },
    review: (session) =>
      Effect.sync(() => {
        annotationCalls.push(`review:${session}`);
        return {
          review: {
            id: "rv_example",
            status: "ready",
            url: "http://r-example.localhost:4001/",
            reused: false,
          },
          session: {
            id: session,
            url: "http://h-example.localhost:4000/report.html",
          },
          grant: {
            root: "/tmp",
            access: "read_all_regular_files_beneath_root",
          },
          fidelity: "instrumented_review",
        };
      }),
    feedback: (review, options) =>
      Effect.sync(() => {
        annotationCalls.push(
          `feedback:${review}:${String(options?.wait ?? false)}:${String(options?.after ?? "")}`,
        );
        return {
          review: { id: review, status: "ready" },
          cursor: 2,
          count: 0,
          feedback: [],
        };
      }),
    deleteReview: (review, discard) =>
      Effect.sync(() => {
        annotationCalls.push(`delete:${review}:${String(discard)}`);
        return {
          delete: {
            review,
            deleted: 1,
            status: "deleted",
            discarded: { drafts: 0, feedback: 0 },
          },
        };
      }),
    stopSession: (session) =>
      Effect.sync(() => {
        stopCalls.push(`session:${session}`);
        return {
          stop: {
            scope: "session",
            session,
            stopped: 0,
            status: "already_stopped",
          },
        };
      }),
    stopAll: () =>
      Effect.sync(() => {
        stopCalls.push("all");
        return {
          stop: {
            scope: "all",
            stopped: 0,
            status: "already_stopped",
          },
        };
      }),
  });
  const exitCode = await Effect.runPromise(
    runApp(args, {
      executablePath: "/Users/example/.local/bin/htmlview",
      stdout: (value) => {
        stdout += value;
      },
      stderr: (value) => {
        stderr += value;
      },
    }).pipe(Effect.provide(Layer.merge(service, NodeServices.layer))),
  );
  return {
    exitCode,
    stdout,
    stderr,
    listedFields,
    stopCalls,
    annotationCalls,
  };
}

function normalizeContextualHelp(
  value: Record<string, unknown>,
): Record<string, unknown> {
  return {
    ...value,
    ...(Array.isArray(value.help)
      ? {
          help: value.help.map((item) =>
            typeof item === "string" ? item.replaceAll(" --json", "") : item,
          ),
        }
      : {}),
  };
}

describe("CLI application contract", () => {
  it("returns a definitive empty home result", async () => {
    const result = await invoke([]);
    assert.equal(result.exitCode, 0);
    assert.equal(result.stderr, "");
    assert.deepEqual(decodeOutput(result.stdout, "toon"), {
      bin: "/Users/example/.local/bin/htmlview",
      description: "Serve local HTML through confined loopback HTTP",
      count: 0,
      sessions: [],
      review_count: 0,
      reviews: [],
      help: ["Run `htmlview serve <entry.html>`"],
    });
  });

  it("keeps default session rows minimal and adds selected fields", async () => {
    const sessions: SessionSummary[] = [
      {
        id: "abc123",
        status: "ready",
        url: "http://h-example.localhost:4000/report.html",
        entry: "/tmp/report.html",
        root: "/tmp",
      },
    ];
    const minimal = await invoke([], sessions);
    const expanded = await invoke(["--fields", "entry,root"], sessions);
    assert.deepEqual(minimal.listedFields, []);
    assert.deepEqual(expanded.listedFields, ["entry", "root"]);
    assert.deepEqual(
      (decodeOutput(minimal.stdout, "toon") as Record<string, unknown>)
        .sessions,
      [
        {
          id: "abc123",
          status: "ready",
          url: "http://h-example.localhost:4000/report.html",
        },
      ],
    );
    assert.deepEqual(
      (decodeOutput(expanded.stdout, "toon") as Record<string, unknown>)
        .sessions,
      sessions,
    );
  });

  it("keeps retained pending feedback discoverable without a raw session", async () => {
    const reviews: ReviewSummary[] = [
      {
        id: `rv_${"r".repeat(22)}`,
        status: "stopped",
        session: "session1",
        drafts: 1,
        unacknowledged: 2,
      },
    ];
    const result = decodeOutput(
      (await invoke([], [], undefined, reviews)).stdout,
      "toon",
    ) as Record<string, unknown>;
    assert.equal(result.review_count, 1);
    assert.deepEqual(result.reviews, reviews);
    assert.deepEqual(result.help, [
      "Run `htmlview feedback <review>` to read pending feedback",
    ]);
  });

  it("reveals path fields when multiple minimal session rows need disambiguation", async () => {
    const sessions: SessionSummary[] = [
      {
        id: "first1",
        status: "ready",
        url: "http://h-first.localhost:4000/report.html",
        entry: "/tmp/first/report.html",
        root: "/tmp/first",
      },
      {
        id: "second2",
        status: "ready",
        url: "http://h-second.localhost:4001/report.html",
        entry: "/tmp/second/report.html",
        root: "/tmp/second",
      },
    ];
    const minimal = decodeOutput(
      (await invoke([], sessions)).stdout,
      "toon",
    ) as Record<string, unknown>;
    const expanded = decodeOutput(
      (await invoke(["--fields", "entry,root"], sessions)).stdout,
      "toon",
    ) as Record<string, unknown>;
    assert.deepEqual(minimal.help, [
      "Run `htmlview review <session>` for human annotation",
      "Run `htmlview stop <session>` to stop a session",
      "Run `htmlview --fields entry,root` to show session paths",
    ]);
    assert.deepEqual(expanded.help, [
      "Run `htmlview review <session>` for human annotation",
      "Run `htmlview stop <session>` to stop a session",
    ]);
  });

  it("dispatches stop selectors through valid-by-construction operations", async () => {
    const session = await invoke(["stop", "abc123"]);
    const all = await invoke(["stop", "--all"]);
    assert.deepEqual(session.stopCalls, ["session:abc123"]);
    assert.deepEqual(all.stopCalls, ["all"]);
  });

  it("dispatches review, feedback, and nested deletion as domain commands", async () => {
    const review = await invoke(["review", "session1", "--json"]);
    assert.deepEqual(review.annotationCalls, ["review:session1"]);
    assert.equal(
      (decodeOutput(review.stdout, "json") as { review: { id: string } }).review
        .id,
      "rv_example",
    );

    const feedback = await invoke([
      "feedback",
      "--wait",
      "--after",
      "2",
      "rv_example",
      "--json",
    ]);
    assert.deepEqual(feedback.annotationCalls, ["feedback:rv_example:true:2"]);

    const deleted = await invoke([
      "review",
      "delete",
      "--discard-feedback",
      "rv_example",
      "--json",
    ]);
    assert.deepEqual(deleted.annotationCalls, ["delete:rv_example:true"]);
    assert.equal(
      (
        decodeOutput(deleted.stdout, "json") as {
          delete: { status: string };
        }
      ).delete.status,
      "deleted",
    );
  });

  for (const args of [[], ["serve", "x.html"], ["stop", "missing"]]) {
    it(`emits equivalent TOON and JSON for ${args.join(" ") || "home"}`, async () => {
      const toon = await invoke(args);
      const json = await invoke([...args, "--json"]);
      assert.equal(toon.exitCode, json.exitCode);
      const toonValue = decodeOutput(toon.stdout, "toon") as Record<
        string,
        unknown
      >;
      const jsonValue = decodeOutput(json.stdout, "json") as Record<
        string,
        unknown
      >;
      assert.deepEqual(
        normalizeContextualHelp(toonValue),
        normalizeContextualHelp(jsonValue),
      );
      assert.equal(toon.stderr, "");
      assert.equal(json.stderr, "");
    });
  }

  it("preserves JSON in contextual commands", async () => {
    const result = await invoke(["--json"]);
    const value = decodeOutput(result.stdout, "json") as Record<
      string,
      unknown
    >;
    assert.deepEqual(value.help, ["Run `htmlview serve <entry.html> --json`"]);
  });

  it("emits equivalent structured runtime errors", async () => {
    const failure = new RuntimeStateError({
      code: "state.unavailable",
      message: "The private htmlview runtime state directory is unavailable",
    });
    const toon = await invoke(["serve", "x.html"], [], failure);
    const json = await invoke(["serve", "x.html", "--json"], [], failure);
    assert.equal(toon.exitCode, 1);
    assert.equal(json.exitCode, 1);
    const toonValue = decodeOutput(toon.stdout, "toon") as Record<
      string,
      unknown
    >;
    const jsonValue = decodeOutput(json.stdout, "json") as Record<
      string,
      unknown
    >;
    assert.deepEqual(
      { ...toonValue, help: undefined },
      { ...jsonValue, help: undefined },
    );
    assert.deepEqual(toonValue.help, [
      "Run `htmlview serve <entry.html>` after correcting runtime-state permissions",
    ]);
    assert.deepEqual(jsonValue.help, [
      "Run `htmlview serve <entry.html> --json` after correcting runtime-state permissions",
    ]);
  });

  it("preserves format and explicit root choices in retry guidance", async () => {
    const failure = new ContentListenerError({
      code: "http.start_failed",
      message: "The loopback content listener could not start",
    });
    const result = await invoke(
      ["serve", "x.html", "--root", "public", "--json"],
      [],
      failure,
    );
    const value = decodeOutput(result.stdout, "json") as Record<
      string,
      unknown
    >;
    assert.deepEqual(value.help, [
      "Run `htmlview serve <entry.html> --root <directory> --json` to retry",
    ]);
  });

  it("suggests freeing capacity when the session limit is reached", async () => {
    const failure = new ControlError({
      code: "control.session_limit",
      message: "Concurrent session limit of 32 reached",
    });
    const result = await invoke(["serve", "x.html", "--json"], [], failure);
    const value = decodeOutput(result.stdout, "json") as Record<
      string,
      unknown
    >;
    assert.deepEqual(value.help, [
      "Run `htmlview stop <session> --json` before serving another entry",
    ]);
  });

  it("suggests the compatible stop path for a supervisor mismatch", async () => {
    const failure = new SupervisorError({
      code: "supervisor.incompatible",
      message:
        "The running htmlview supervisor uses an incompatible control protocol",
    });
    const result = await invoke(["serve", "x.html", "--json"], [], failure);
    const value = decodeOutput(result.stdout, "json") as Record<
      string,
      unknown
    >;
    assert.deepEqual(value.help, [
      "Run `htmlview stop --all --json` before retrying this command",
    ]);
  });

  it("sanitizes unexpected defects at the outer boundary", async () => {
    const result = await invoke(
      ["serve", "x.html", "--json"],
      [],
      new Error("private internal detail"),
    );
    assert.equal(result.exitCode, 1);
    assert.equal(result.stderr.includes("private internal detail"), false);
    assert.deepEqual(Object.keys(JSON.parse(result.stderr)).sort(), [
      "code",
      "internal_id",
      "level",
      "operation",
      "timestamp",
    ]);
    assert.deepEqual(decodeOutput(result.stdout, "json"), {
      error: {
        code: "runtime.internal",
        message: "htmlview could not complete the request",
      },
    });
    assert.equal(result.stdout.includes("private internal detail"), false);
  });

  it("honors --log-level none for sanitized defects", async () => {
    const result = await invoke(
      ["serve", "x.html", "--json", "--log-level", "none"],
      [],
      new Error("private internal detail"),
    );
    assert.equal(result.exitCode, 1);
    assert.equal(result.stderr, "");
    assert.deepEqual(decodeOutput(result.stdout, "json"), {
      error: {
        code: "runtime.internal",
        message: "htmlview could not complete the request",
      },
    });
  });

  it("preserves interruption without rendering an internal error", async () => {
    let stdout = "";
    let stderr = "";
    const pending = Layer.succeed(CommandService, {
      listState: () => Effect.never,
      serve: () => Effect.never,
      review: () => Effect.never,
      feedback: () => Effect.never,
      deleteReview: () => Effect.never,
      stopSession: () => Effect.never,
      stopAll: () => Effect.never,
    });
    const exit = await Effect.runPromise(
      Effect.gen(function* () {
        const fiber = yield* Effect.forkChild(
          runApp([], {
            executablePath: "htmlview",
            stdout: (value) => {
              stdout += value;
            },
            stderr: (value) => {
              stderr += value;
            },
          }).pipe(Effect.provide(Layer.merge(pending, NodeServices.layer))),
        );
        yield* Effect.yieldNow;
        yield* Fiber.interrupt(fiber);
        return yield* Fiber.await(fiber);
      }),
    );
    assert.equal(Exit.isFailure(exit), true);
    assert.equal(stdout, "");
    assert.equal(stderr, "");
  });

  it("emits no format-breaking trailing newline", async () => {
    for (const format of ["toon", "json"] as OutputFormat[]) {
      const result = await invoke(format === "json" ? ["--json"] : []);
      assert.equal(result.stdout.endsWith("\n"), false);
    }
  });
});
