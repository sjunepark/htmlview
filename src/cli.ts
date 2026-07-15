#!/usr/bin/env node
import { runApp } from "./app.js";
import { HtmlviewService } from "./service.js";

const exitCode = await runApp(process.argv.slice(2), {
  executablePath: process.argv[1] ?? "htmlview",
  service: new HtmlviewService(),
  stdout: (value) => process.stdout.write(`${value}\n`),
  stderr: (value) => process.stderr.write(value),
});

process.exitCode = exitCode;
