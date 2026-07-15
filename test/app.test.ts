import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { runApp } from "../src/app.js";
import { decodeOutput } from "../src/output.js";
import type { OutputFormat, SessionSummary } from "../src/contracts.js";

async function invoke(args: string[], sessions: SessionSummary[] = []) {
  let stdout = "";
  let stderr = "";
  const exitCode = await runApp(args, {
    executablePath: "/Users/example/.local/bin/htmlview",
    service: {
      listSessions: async () => sessions,
      serve: async () => ({
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
      }),
      stop: async (session, all) => ({
        stop: {
          scope: all === true ? "all" : "session",
          ...(session === undefined ? {} : { session }),
          stopped: 0,
          status: "already_stopped",
        },
      }),
    },
    stdout: (value) => {
      stdout += value;
    },
    stderr: (value) => {
      stderr += value;
    },
  });
  return { exitCode, stdout, stderr };
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

  for (const args of [
    [],
    ["--help"],
    ["serve", "--help"],
    ["stop", "--help"],
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
      if (args.length === 0) {
        assert.deepEqual(
          { ...toonValue, help: undefined },
          { ...jsonValue, help: undefined },
        );
      } else {
        assert.deepEqual(toonValue, jsonValue);
      }
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

  it("emits no format-breaking trailing newline", async () => {
    for (const format of ["toon", "json"] as OutputFormat[]) {
      const result = await invoke(format === "json" ? ["--json"] : []);
      assert.equal(result.stdout.endsWith("\n"), false);
    }
  });
});
