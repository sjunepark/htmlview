import { execFile } from "node:child_process";
import { rm } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { build } from "esbuild";

const execute = promisify(execFile);
const root = process.cwd();
const outputDirectory = path.join(root, "dist");

await rm(outputDirectory, { recursive: true, force: true });
await execute(
  process.execPath,
  [
    path.join(root, "node_modules", "typescript", "bin", "tsc"),
    "-p",
    "tsconfig.build.json",
  ],
  { cwd: root },
);

const sharedOptions = {
  bundle: true,
  external: ["@toon-format/toon", "mime-types"],
  format: "esm",
  legalComments: "external",
  platform: "node",
  sourcemap: "linked",
  sourcesContent: false,
  target: "node22.13",
};

await Promise.all([
  build({
    ...sharedOptions,
    entryPoints: [path.join(root, "src", "cli.ts")],
    outfile: path.join(outputDirectory, "cli.js"),
  }),
  build({
    ...sharedOptions,
    entryPoints: [path.join(root, "src", "supervisor", "supervisor-main.ts")],
    outfile: path.join(outputDirectory, "supervisor-main.js"),
  }),
]);
