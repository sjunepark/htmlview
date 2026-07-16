import assert from "node:assert/strict";
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
  SessionSummary,
} from "../src/supervisor/protocol.js";

async function invoke(
  args: string[],
  sessions: SessionSummary[] = [],
  serveFailure?: unknown,
) {
  let stdout = "";
  let stderr = "";
  let listedFields: readonly OptionalSessionField[] | undefined;
  const stopCalls: string[] = [];
  const service = Layer.succeed(CommandService, {
    listSessions: (fields) =>
      Effect.sync(() => {
        listedFields = fields;
        return sessions;
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
    }).pipe(Effect.provide(service)),
  );
  return { exitCode, stdout, stderr, listedFields, stopCalls };
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
      "Run `htmlview stop <session>` to stop a session",
      "Run `htmlview --fields entry,root` to show session paths",
    ]);
    assert.deepEqual(expanded.help, [
      "Run `htmlview stop <session>` to stop a session",
    ]);
  });

  it("dispatches stop selectors through valid-by-construction operations", async () => {
    const session = await invoke(["stop", "abc123"]);
    const all = await invoke(["stop", "--all"]);
    assert.deepEqual(session.stopCalls, ["session:abc123"]);
    assert.deepEqual(all.stopCalls, ["all"]);
  });

  for (const args of [
    [],
    ["--help"],
    ["--version"],
    ["serve", "--help"],
    ["stop", "--help"],
    ["serve", "x.html"],
    ["stop", "missing"],
    ["serve"],
    ["serve", "x.html", "--bad"],
  ]) {
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

  it("preserves JSON in usage-error corrective commands", async () => {
    const result = await invoke(["serve", "x.html", "--bad", "--json"]);
    const value = decodeOutput(result.stdout, "json") as Record<
      string,
      unknown
    >;
    assert.deepEqual(value.help, [
      "Run `htmlview serve --help --json` for complete examples",
    ]);
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
    assert.match(result.stderr, /private internal detail/);
    assert.deepEqual(decodeOutput(result.stdout, "json"), {
      error: {
        code: "runtime.internal",
        message: "htmlview could not complete the request",
      },
    });
    assert.equal(result.stdout.includes("private internal detail"), false);
  });

  it("preserves interruption without rendering an internal error", async () => {
    let stdout = "";
    let stderr = "";
    const pending = Layer.succeed(CommandService, {
      listSessions: () => Effect.never,
      serve: () => Effect.never,
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
          }).pipe(Effect.provide(pending)),
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
