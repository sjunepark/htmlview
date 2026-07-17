#!/usr/bin/env node
import { runMain } from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect, Layer } from "effect";
import { runApp } from "./app.js";
import { CommandService, makeCommandService } from "./service.js";

const CommandServiceLive = Layer.succeed(CommandService, makeCommandService());
const CliLive = Layer.merge(CommandServiceLive, NodeServices.layer);

const program = runApp(process.argv.slice(2), {
  executablePath: process.argv[1] ?? "htmlview",
  stdout: (value) => process.stdout.write(`${value}\n`),
  stderr: (value) => process.stderr.write(`${value}\n`),
}).pipe(
  Effect.provide(CliLive),
  Effect.tap((exitCode) =>
    Effect.sync(() => {
      process.exitCode = exitCode;
    }),
  ),
);

runMain(program, { disableErrorReporting: true });
