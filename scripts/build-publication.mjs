import { createHash, randomUUID } from "node:crypto";
import {
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";

const generationArtifacts = [
  "supervisor-main.js.map",
  "supervisor-main.js",
  "cli.js.map",
  "cli.js",
];

async function generationId(directory) {
  const hash = createHash("sha256");
  for (const artifact of generationArtifacts) {
    hash.update(artifact);
    hash.update("\0");
    hash.update(await readFile(path.join(directory, artifact)));
  }
  return hash.digest("hex");
}

async function validateGeneration(directory, identifier) {
  const entries = (await readdir(directory)).sort();
  const expected = [...generationArtifacts].sort();
  if (
    entries.length !== expected.length ||
    entries.some((entry, index) => entry !== expected[index]) ||
    (await generationId(directory)) !== identifier
  )
    throw new Error(
      `htmlview generation ${identifier} does not match its content address`,
    );
}

async function installGeneration(
  generationsDirectory,
  stagedGeneration,
  identifier,
) {
  const publishedGeneration = path.join(generationsDirectory, identifier);
  try {
    await rename(stagedGeneration, publishedGeneration);
  } catch (error) {
    if (
      !(error instanceof Error) ||
      !("code" in error) ||
      (error.code !== "EEXIST" && error.code !== "ENOTEMPTY")
    )
      throw error;
    await validateGeneration(publishedGeneration, identifier);
  }
}

async function activateGeneration(outputDirectory, identifier) {
  const activationLauncher = path.join(outputDirectory, "cli.js");
  const temporaryLauncher = `${activationLauncher}.${randomUUID()}.tmp`;
  try {
    await writeFile(
      temporaryLauncher,
      `#!/usr/bin/env node\nimport "./generations/${identifier}/cli.js";\n`,
      { mode: 0o755 },
    );
    await rename(temporaryLauncher, activationLauncher);
  } finally {
    await rm(temporaryLauncher, { force: true });
  }
}

async function validatePackageOutput(
  outputDirectory,
  identifier,
  requireInstalled,
) {
  const outputEntries = await readdir(outputDirectory);
  const allowedOutputEntries = new Set(["cli.js", "generations"]);
  const generationsDirectory = path.join(outputDirectory, "generations");
  const generationEntries = await readdir(generationsDirectory);
  if (
    outputEntries.some((entry) => !allowedOutputEntries.has(entry)) ||
    generationEntries.some((entry) => entry !== identifier) ||
    (requireInstalled &&
      (outputEntries.length !== allowedOutputEntries.size ||
        generationEntries.length !== 1))
  )
    throw new Error(
      "Package builds require clean output containing only the active htmlview generation",
    );
}

export function makeGenerationPublisher({
  beforeActivation = () => Promise.resolve(),
} = {}) {
  // The injected adapter coordinates deterministic faults without adding a
  // production build flag or exposing installation and activation separately.
  return async function publishGeneration({
    stagedGeneration,
    outputDirectory,
    packageBuild = false,
  }) {
    const generationsDirectory = path.join(outputDirectory, "generations");
    await mkdir(generationsDirectory, { recursive: true });
    const identifier = await generationId(stagedGeneration);
    await validateGeneration(stagedGeneration, identifier);
    if (packageBuild)
      await validatePackageOutput(outputDirectory, identifier, false);
    await installGeneration(generationsDirectory, stagedGeneration, identifier);
    await beforeActivation();
    await activateGeneration(outputDirectory, identifier);
    if (packageBuild)
      await validatePackageOutput(outputDirectory, identifier, true);
    return identifier;
  };
}

export const publishGeneration = makeGenerationPublisher();
