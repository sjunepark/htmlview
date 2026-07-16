import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { isBuiltin } from "node:module";
import path from "node:path";
import { build } from "esbuild";
import { publishGeneration } from "./build-publication.mjs";

const arguments_ = process.argv.slice(2);
if (
  arguments_.length > 1 ||
  (arguments_.length === 1 && arguments_[0] !== "--package")
)
  throw new Error("Usage: node scripts/build.mjs [--package]");
const packageBuild = arguments_[0] === "--package";
const root = process.cwd();
const outputDirectory = path.join(root, "dist");
const externalPackages = ["@toon-format/toon", "mime-types"];
const licensedBundledPackages = new Set([
  "@effect/platform-node",
  "@effect/platform-node-shared",
  "effect",
  "fast-check",
  "ini",
  "pure-rand",
  "toml",
  "yaml",
]);

const sharedOptions = {
  bundle: true,
  banner: {
    js: 'import { createRequire as __htmlviewCreateRequire } from "node:module"; const require = __htmlviewCreateRequire(import.meta.url);',
  },
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

function packageName(modulePath) {
  const marker = "node_modules/";
  const start = modulePath.lastIndexOf(marker);
  if (start === -1) return undefined;
  const parts = modulePath.slice(start + marker.length).split("/");
  return parts[0]?.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
}

async function validateBundles(results) {
  const packageMetadata = JSON.parse(
    await readFile(path.join(root, "package.json"), "utf8"),
  );
  const runtimeDependencies = new Set(
    Object.keys(packageMetadata.dependencies ?? {}),
  );
  if (
    externalPackages.some((dependency) => !runtimeDependencies.has(dependency))
  )
    throw new Error(
      "Every external bundle import must be a runtime dependency",
    );

  const bundledPackages = new Set();
  for (const result of results) {
    for (const input of Object.keys(result.metafile.inputs)) {
      const dependency = packageName(input);
      if (dependency !== undefined) bundledPackages.add(dependency);
    }
    for (const output of Object.values(result.metafile.outputs)) {
      for (const imported of output.imports) {
        if (!imported.external || isBuiltin(imported.path)) continue;
        const dependency = packageName(`node_modules/${imported.path}`);
        if (dependency === undefined || !runtimeDependencies.has(dependency))
          throw new Error(
            `Undeclared external bundle import: ${imported.path}`,
          );
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
}

const stagingDirectory = await mkdtemp(path.join(root, ".dist-build-"));
const stagedGeneration = path.join(stagingDirectory, "generations", "pending");
try {
  await mkdir(stagedGeneration, { recursive: true });
  const builds = await Promise.allSettled([
    build({
      ...sharedOptions,
      entryPoints: [path.join(root, "src", "cli.ts")],
      outfile: path.join(stagedGeneration, "cli.js"),
    }),
    build({
      ...sharedOptions,
      entryPoints: [path.join(root, "src", "supervisor", "supervisor-main.ts")],
      outfile: path.join(stagedGeneration, "supervisor-main.js"),
    }),
  ]);
  const failed = builds.find(({ status }) => status === "rejected");
  if (failed !== undefined) throw failed.reason;
  await validateBundles(builds.map(({ value }) => value));
  await publishGeneration({ stagedGeneration, outputDirectory, packageBuild });
} finally {
  await rm(stagingDirectory, { recursive: true, force: true });
}
