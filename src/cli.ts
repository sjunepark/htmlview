#!/usr/bin/env node
import { runApp } from "./app.js";

const exitCode = await runApp(process.argv.slice(2), {
  executablePath: process.argv[1] ?? "htmlview",
  listSessions: async () => [],
  stdout: (value) => process.stdout.write(value),
  stderr: (value) => process.stderr.write(value),
});

process.exitCode = exitCode;
