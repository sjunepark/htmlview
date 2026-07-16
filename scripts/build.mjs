import { readFile, rm } from "node:fs/promises";
import path from "node:path";
import { build } from "esbuild";

const root = process.cwd();
const outputDirectory = path.join(root, "dist");
const externalPackages = ["@toon-format/toon", "mime-types"];
const licensedBundledPackages = new Set([
  "@effect/platform-node",
  "@effect/platform-node-shared",
  "effect",
  "fast-check",
  "pure-rand",
]);

await rm(outputDirectory, { recursive: true, force: true });

const sharedOptions = {
  bundle: true,
  external: externalPackages,
  format: "esm",
  legalComments: "none",
  metafile: true,
  minify: true,
  platform: "node",
  sourcemap: "linked",
  sourcesContent: false,
  target: "node22.13",
};

const results = await Promise.all([
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

const packageMetadata = JSON.parse(
  await readFile(path.join(root, "package.json"), "utf8"),
);
const runtimeDependencies = new Set(
  Object.keys(packageMetadata.dependencies ?? {}),
);
if (externalPackages.some((dependency) => !runtimeDependencies.has(dependency)))
  throw new Error("Every external bundle import must be a runtime dependency");

function packageName(modulePath) {
  const marker = "node_modules/";
  const start = modulePath.lastIndexOf(marker);
  if (start === -1) return undefined;
  const parts = modulePath.slice(start + marker.length).split("/");
  return parts[0]?.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
}

const bundledPackages = new Set();
for (const result of results) {
  for (const input of Object.keys(result.metafile.inputs)) {
    const dependency = packageName(input);
    if (dependency !== undefined) bundledPackages.add(dependency);
  }
  for (const output of Object.values(result.metafile.outputs)) {
    for (const imported of output.imports) {
      if (!imported.external || imported.path.startsWith("node:")) continue;
      const dependency = packageName(`node_modules/${imported.path}`);
      if (dependency === undefined || !runtimeDependencies.has(dependency))
        throw new Error(`Undeclared external bundle import: ${imported.path}`);
    }
  }
}
if (
  bundledPackages.size !== licensedBundledPackages.size ||
  [...bundledPackages].some(
    (dependency) => !licensedBundledPackages.has(dependency),
  )
)
  throw new Error(
    `Bundled dependency licenses changed: ${[...bundledPackages].sort().join(", ")}`,
  );
