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

async function validatePublishedGeneration(directory, identifier) {
  const entries = (await readdir(directory)).sort();
  const expected = [...generationArtifacts].sort();
  if (
    entries.length !== expected.length ||
    entries.some((entry, index) => entry !== expected[index]) ||
    (await generationId(directory)) !== identifier
  )
    throw new Error(
      `Published htmlview generation ${identifier} does not match its content address`,
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
    await validatePublishedGeneration(publishedGeneration, identifier);
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

async function validatePackageGenerationSet(
  generationsDirectory,
  identifier,
  requireInstalled,
) {
  const entries = await readdir(generationsDirectory);
  if (
    entries.some((entry) => entry !== identifier) ||
    (requireInstalled && entries.length !== 1)
  )
    throw new Error(
      "Package builds require a clean checkout with no inactive htmlview generations",
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
    if (packageBuild)
      await validatePackageGenerationSet(
        generationsDirectory,
        identifier,
        false,
      );
    await installGeneration(generationsDirectory, stagedGeneration, identifier);
    await beforeActivation();
    await activateGeneration(outputDirectory, identifier);
    if (packageBuild)
      await validatePackageGenerationSet(
        generationsDirectory,
        identifier,
        true,
      );
    return identifier;
  };
}

export const publishGeneration = makeGenerationPublisher();
