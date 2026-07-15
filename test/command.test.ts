import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseCommand } from "../src/command.js";

describe("command parsing", () => {
  it("accepts format and optional home fields", () => {
    assert.deepEqual(parseCommand(["--fields", "entry,root", "--json"]), {
      kind: "home",
      format: "json",
      fields: ["entry", "root"],
      help: false,
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
