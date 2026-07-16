#!/usr/bin/env node
import { runMain } from "@effect/platform-node/NodeRuntime";
import { Effect, Layer } from "effect";
import { runApp } from "./app.js";
import { CommandService, makeCommandService } from "./service.js";

const CommandServiceLive = Layer.succeed(CommandService, makeCommandService());

const program = runApp(process.argv.slice(2), {
  executablePath: process.argv[1] ?? "htmlview",
  stdout: (value) => process.stdout.write(`${value}\n`),
  stderr: (value) => process.stderr.write(value),
}).pipe(
  Effect.provide(CommandServiceLive),
  Effect.tap((exitCode) =>
    Effect.sync(() => {
      process.exitCode = exitCode;
    }),
  ),
);

runMain(program);
