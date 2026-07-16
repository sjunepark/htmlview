import assert from "node:assert/strict";
import {
  cp,
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  makeGenerationPublisher,
  publishGeneration,
} from "../../scripts/build-publication.mjs";

const generationArtifacts = [
  "cli.js",
  "cli.js.map",
  "supervisor-main.js",
  "supervisor-main.js.map",
];

async function stageGeneration(parent, name, contents = name) {
  const directory = path.join(parent, `stage-${name}`);
  await mkdir(directory);
  await Promise.all(
    generationArtifacts.map((artifact) =>
      writeFile(path.join(directory, artifact), `${contents}:${artifact}\n`),
    ),
  );
  return directory;
}

async function activeIdentifier(outputDirectory) {
  const launcher = await readFile(path.join(outputDirectory, "cli.js"), "utf8");
  const match = launcher.match(
    /^#!\/usr\/bin\/env node\nimport "\.\/generations\/([0-9a-f]{64})\/cli\.js";\n$/,
  );
  assert.notEqual(match, null, "launcher does not select one generation");
  return match[1];
}

async function assertGenerationComplete(outputDirectory, identifier) {
  assert.deepEqual(
    (
      await readdir(path.join(outputDirectory, "generations", identifier))
    ).sort(),
    [...generationArtifacts].sort(),
  );
}

async function withWorkspace(run) {
  const workspace = await mkdtemp(path.join(tmpdir(), "hv-publish-"));
  try {
    await run(workspace, path.join(workspace, "dist"));
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
}

test("failure after generation installation leaves the prior launcher active", () =>
  withWorkspace(async (workspace, outputDirectory) => {
    const first = await publishGeneration({
      stagedGeneration: await stageGeneration(workspace, "first"),
      outputDirectory,
    });
    const previousLauncher = await readFile(
      path.join(outputDirectory, "cli.js"),
    );
    const activationFailure = new Error("injected pre-activation failure");
    const failingPublisher = makeGenerationPublisher({
      beforeActivation: () => Promise.reject(activationFailure),
    });

    await assert.rejects(
      failingPublisher({
        stagedGeneration: await stageGeneration(workspace, "second"),
        outputDirectory,
      }),
      (error) => error === activationFailure,
    );
    assert.deepEqual(
      await readFile(path.join(outputDirectory, "cli.js")),
      previousLauncher,
    );
    assert.equal(await activeIdentifier(outputDirectory), first);
    assert.equal(
      (await readdir(path.join(outputDirectory, "generations"))).length,
      2,
    );
    await assertGenerationComplete(outputDirectory, first);
  }));

test("competing distinct generations activate only complete artifact sets", () =>
  withWorkspace(async (workspace, outputDirectory) => {
    const initial = await publishGeneration({
      stagedGeneration: await stageGeneration(workspace, "initial"),
      outputDirectory,
    });
    let reportInstalled;
    const installed = new Promise((resolve) => {
      reportInstalled = resolve;
    });
    let releaseActivation;
    const activationReleased = new Promise((resolve) => {
      releaseActivation = resolve;
    });
    const delayedPublisher = makeGenerationPublisher({
      beforeActivation: async () => {
        reportInstalled();
        await activationReleased;
      },
    });

    const delayed = delayedPublisher({
      stagedGeneration: await stageGeneration(workspace, "delayed"),
      outputDirectory,
    });
    await installed;
    try {
      assert.equal(await activeIdentifier(outputDirectory), initial);

      const competing = await publishGeneration({
        stagedGeneration: await stageGeneration(workspace, "competing"),
        outputDirectory,
      });
      assert.equal(await activeIdentifier(outputDirectory), competing);
      await assertGenerationComplete(outputDirectory, competing);
    } finally {
      releaseActivation();
    }
    const delayedIdentifier = await delayed;
    assert.equal(await activeIdentifier(outputDirectory), delayedIdentifier);
    await assertGenerationComplete(outputDirectory, delayedIdentifier);
  }));

test("tampered generation reuse fails without changing a valid launcher", () =>
  withWorkspace(async (workspace, outputDirectory) => {
    const baseline = await publishGeneration({
      stagedGeneration: await stageGeneration(workspace, "baseline"),
      outputDirectory,
    });
    const previousLauncher = await readFile(
      path.join(outputDirectory, "cli.js"),
    );

    const scratchOutput = path.join(workspace, "scratch-dist");
    const candidate = await publishGeneration({
      stagedGeneration: await stageGeneration(
        workspace,
        "candidate-source",
        "candidate",
      ),
      outputDirectory: scratchOutput,
    });
    const candidateDirectory = path.join(
      outputDirectory,
      "generations",
      candidate,
    );
    await cp(
      path.join(scratchOutput, "generations", candidate),
      candidateDirectory,
      { recursive: true },
    );
    await writeFile(path.join(candidateDirectory, "cli.js"), "tampered\n");

    await assert.rejects(
      publishGeneration({
        stagedGeneration: await stageGeneration(
          workspace,
          "candidate-retry",
          "candidate",
        ),
        outputDirectory,
      }),
      /does not match its content address/,
    );
    assert.deepEqual(
      await readFile(path.join(outputDirectory, "cli.js")),
      previousLauncher,
    );
    assert.equal(await activeIdentifier(outputDirectory), baseline);
    await assertGenerationComplete(outputDirectory, baseline);
  }));

test("fresh generations reject unexpected artifacts before activation", () =>
  withWorkspace(async (workspace, outputDirectory) => {
    const stagedGeneration = await stageGeneration(workspace, "unexpected");
    await writeFile(path.join(stagedGeneration, "unexpected.txt"), "extra\n");

    await assert.rejects(
      publishGeneration({ stagedGeneration, outputDirectory }),
      /does not match its content address/,
    );
    assert.deepEqual(
      await readdir(path.join(outputDirectory, "generations")),
      [],
    );
    await assert.rejects(readFile(path.join(outputDirectory, "cli.js")), {
      code: "ENOENT",
    });
  }));

test("package publication rejects stale flat output artifacts", () =>
  withWorkspace(async (workspace, outputDirectory) => {
    const baseline = await publishGeneration({
      stagedGeneration: await stageGeneration(workspace, "baseline"),
      outputDirectory,
      packageBuild: true,
    });
    const previousLauncher = await readFile(
      path.join(outputDirectory, "cli.js"),
    );
    await Promise.all(
      ["cli.js.map", "supervisor-main.js", "supervisor-main.js.map"].map(
        (artifact) =>
          writeFile(path.join(outputDirectory, artifact), "stale\n"),
      ),
    );

    await assert.rejects(
      publishGeneration({
        stagedGeneration: await stageGeneration(
          workspace,
          "baseline-retry",
          "baseline",
        ),
        outputDirectory,
        packageBuild: true,
      }),
      /clean output containing only the active htmlview generation/,
    );
    assert.deepEqual(
      await readFile(path.join(outputDirectory, "cli.js")),
      previousLauncher,
    );
    assert.equal(await activeIdentifier(outputDirectory), baseline);
  }));
