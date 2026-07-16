import assert from "node:assert/strict";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, it } from "vitest";
import { Effect, Layer } from "effect";
import { runApp } from "../src/app.js";
import { CommandService } from "../src/service.js";
import { htmlviewVersion } from "../src/version.js";

const service = Layer.succeed(CommandService, {
  listSessions: () => Effect.succeed([]),
  serve: () => Effect.die(new Error("serve handler should not run")),
  stopSession: () => Effect.die(new Error("stop handler should not run")),
  stopAll: () => Effect.die(new Error("stop handler should not run")),
});

async function invoke(args: string[]) {
  let stdout = "";
  let stderr = "";
  const exitCode = await Effect.runPromise(
    runApp(args, {
      executablePath: "/tmp/htmlview",
      stdout: (value) => {
        stdout += value;
      },
      stderr: (value) => {
        stderr += value;
      },
    }).pipe(Effect.provide(Layer.merge(service, NodeServices.layer))),
  );
  return { exitCode, stdout, stderr };
}

describe("native Effect CLI contract", () => {
  it("owns text help and exposes the command tree", async () => {
    for (const flag of ["--help", "-h"]) {
      const result = await invoke([flag]);
      assert.equal(result.exitCode, 0);
      assert.equal(result.stderr, "");
      assert.match(result.stdout, /USAGE/);
      assert.match(result.stdout, /\n {2}serve\s+/);
      assert.match(result.stdout, /\n {2}stop\s+/);
      assert.equal(result.stdout.startsWith("{"), false);
    }
  });

  it("owns text version output even when --json is present", async () => {
    for (const args of [["--version"], ["-v"], ["--version", "--json"]]) {
      const result = await invoke(args);
      assert.equal(result.exitCode, 0);
      assert.equal(result.stderr, "");
      assert.equal(result.stdout, `htmlview v${htmlviewVersion}`);
    }
  });

  it("generates native shell completions", async () => {
    for (const shell of ["bash", "sh", "zsh", "fish"]) {
      const result = await invoke(["--completions", shell]);
      assert.equal(result.exitCode, 0);
      assert.equal(result.stderr, "");
      assert.match(result.stdout, /htmlview/);
    }
  });

  it("writes native syntax help to stdout and diagnostics to stderr", async () => {
    for (const args of [
      ["serve"],
      ["serve", "report.html", "--host", "0.0.0.0"],
      ["launch"],
      ["--fields", "entry", "--fields", "root"],
      ["serve", "report.html", "--fields", "entry"],
      ["stop"],
      ["stop", "abc", "--all"],
    ]) {
      const result = await invoke(args);
      assert.equal(result.exitCode, 1, args.join(" "));
      assert.match(result.stdout, /USAGE/, args.join(" "));
      assert.notEqual(result.stderr, "", args.join(" "));
      assert.equal(result.stdout.startsWith("{"), false);
    }
  });

  it("does not let --json rewrite native syntax failures", async () => {
    const toon = await invoke(["serve"]);
    const json = await invoke(["serve", "--json"]);
    assert.equal(json.exitCode, 1);
    assert.equal(json.stdout, toon.stdout);
    assert.equal(json.stderr, toon.stderr);
  });
});
