import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { parseCommand } from "../src/command.js";

describe("command parsing", () => {
  it("accepts a structured top-level version query", () => {
    assert.deepEqual(parseCommand(["--version", "--json"]), {
      kind: "version",
      format: "json",
      help: false,
    });
    const conflict = parseCommand(["--version", "--help"]);
    assert.equal("exitCode" in conflict && conflict.exitCode, 2);
  });
  it("accepts format and optional home fields", () => {
    assert.deepEqual(parseCommand(["--fields", "entry,root", "--json"]), {
      kind: "home",
      format: "json",
      fields: ["entry", "root"],
      help: false,
    });
  });

  it("rejects repeated field selections instead of silently replacing them", () => {
    const result = parseCommand([
      "--fields",
      "entry",
      "--fields",
      "root",
      "--json",
    ]);
    assert.ok("exitCode" in result);
    assert.equal(result.exitCode, 2);
    assert.deepEqual(result.result.error, {
      code: "usage.duplicate_flag",
      message: "Flag --fields may be provided only once",
      valid_flags: ["--fields", "--json", "--help", "--version"],
    });
  });

  it("reports missing serve arguments with complete usage", () => {
    const result = parseCommand(["serve"]);
    assert.ok("exitCode" in result);
    assert.equal(result.exitCode, 2);
    assert.deepEqual(result.result.error, {
      code: "usage.missing_argument",
      message: "Missing required argument <entry.html> for `htmlview serve`",
      usage: "htmlview serve <entry.html> [--root <directory>] [--json]",
    });
  });

  it("reports unknown flags with the relevant valid set", () => {
    const result = parseCommand(["serve", "report.html", "--stat"]);
    assert.ok("exitCode" in result);
    assert.deepEqual(result.result.error, {
      code: "usage.unknown_flag",
      message: "Unknown flag --stat for `htmlview serve`",
      valid_flags: ["--root", "--json", "--help"],
    });
  });

  it("has no public or caller-selected bind option", () => {
    const result = parseCommand(["serve", "report.html", "--host", "0.0.0.0"]);
    assert.equal("exitCode" in result && result.exitCode, 2);
    if ("exitCode" in result)
      assert.equal(
        (result.result.error as Record<string, unknown>).code,
        "usage.unknown_flag",
      );
  });

  it("never treats a single-dash option as an entry path", () => {
    const result = parseCommand(["serve", "-x"]);
    assert.ok("exitCode" in result);
    assert.deepEqual(result.result.error, {
      code: "usage.unknown_flag",
      message: "Unknown flag -x for `htmlview serve`",
      valid_flags: ["--root", "--json", "--help"],
    });
  });

  it("reports unknown commands with valid commands", () => {
    const result = parseCommand(["launch"]);
    assert.ok("exitCode" in result);
    assert.deepEqual(result.result.error, {
      code: "usage.unknown_command",
      message: "Unknown command launch",
      valid_commands: ["serve", "stop"],
    });
  });

  it("does not require operational arguments for help", () => {
    assert.deepEqual(parseCommand(["serve", "--help"]), {
      kind: "serve",
      format: "toon",
      help: true,
    });
  });

  it("rejects conflicting stop selectors", () => {
    const result = parseCommand(["stop", "abc", "--all"]);
    assert.ok("exitCode" in result);
    assert.equal(result.exitCode, 2);
    assert.equal(
      (result.result.error as Record<string, unknown>).code,
      "usage.conflicting_arguments",
    );
  });
});
