import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";

const execute = promisify(execFile);
const repository = process.cwd();
const buildScript = path.join(repository, "scripts", "build.mjs");
const outputDirectory = path.join(repository, "dist");
const cli = path.join(outputDirectory, "cli.js");
const generationArtifacts = [
  "supervisor-main.js.map",
  "supervisor-main.js",
  "cli.js.map",
  "cli.js",
];
const packageVersion = JSON.parse(
  await readFile(path.join(repository, "package.json"), "utf8"),
).version;

async function build() {
  await execute(process.execPath, [buildScript], {
    cwd: repository,
    encoding: "utf8",
  });
}

async function assertPublishedCliRuns() {
  const result = await execute(process.execPath, [cli, "--version"], {
    cwd: repository,
    encoding: "utf8",
  });
  assert.equal(result.stderr, "");
  assert.equal(result.stdout, `htmlview v${packageVersion}\n`);
}

async function assertActiveGenerationIsComplete() {
  const launcher = await readFile(cli, "utf8");
  const match = launcher.match(
    /^#!\/usr\/bin\/env node\nimport "\.\/generations\/([0-9a-f]{64})\/cli\.js";\n$/,
  );
  assert.notEqual(match, null, "launcher does not select one generation");
  const identifier = match[1];
  const generation = path.join(outputDirectory, "generations", identifier);
  assert.deepEqual(
    (await readdir(generation)).sort(),
    [...generationArtifacts].sort(),
  );
  const hash = createHash("sha256");
  for (const artifact of generationArtifacts) {
    hash.update(artifact);
    hash.update("\0");
    hash.update(await readFile(path.join(generation, artifact)));
  }
  assert.equal(hash.digest("hex"), identifier);
  return identifier;
}

async function assertPublishedLifecycleRuns(site, stateDirectory) {
  const environment = {
    ...process.env,
    HTMLVIEW_STATE_DIR: stateDirectory,
    HTMLVIEW_IDLE_MS: "500",
  };
  try {
    const served = await execute(
      process.execPath,
      [cli, "serve", "index.html", "--json"],
      { cwd: site, encoding: "utf8", env: environment },
    );
    assert.equal(served.stderr, "");
    const result = JSON.parse(served.stdout);
    assert.equal(result.session.status, "ready");
    assert.equal(
      await fetch(result.session.url).then((response) => response.text()),
      "<!doctype html><p>build validation</p>\n",
    );
  } finally {
    const stopped = await execute(
      process.execPath,
      [cli, "stop", "--all", "--json"],
      {
        cwd: site,
        encoding: "utf8",
        env: environment,
      },
    );
    assert.equal(stopped.stderr, "");
    assert.equal(JSON.parse(stopped.stdout).stop.scope, "all");
  }
}

test(
  "concurrent builds preserve a runnable published CLI",
  { timeout: 60_000 },
  async () => {
    const temporary = await mkdtemp(path.join(tmpdir(), "hv-build-"));
    const site = path.join(temporary, "site");
    let builds = Promise.resolve();
    await mkdir(site);
    await writeFile(
      path.join(site, "index.html"),
      "<!doctype html><p>build validation</p>\n",
    );
    try {
      await build();
      await assertActiveGenerationIsComplete();

      let buildsComplete = false;
      let buildFailure;
      builds = Promise.all(Array.from({ length: 4 }, () => build())).then(
        () => {
          buildsComplete = true;
        },
        (error) => {
          buildFailure = error;
          buildsComplete = true;
        },
      );

      let reads = 0;
      do {
        await assertActiveGenerationIsComplete();
        await assertPublishedCliRuns();
        await assertPublishedLifecycleRuns(
          site,
          path.join(temporary, `s-${reads}`),
        );
        reads += 1;
      } while (!buildsComplete);
      await builds;
      if (buildFailure !== undefined) throw buildFailure;
      assert.ok(reads > 0);

      const outputResidue = (await readdir(outputDirectory)).filter(
        (entry) => entry.startsWith("cli.js.") && entry.endsWith(".tmp"),
      );
      const stagingResidue = (await readdir(repository)).filter((entry) =>
        entry.startsWith(".dist-build-"),
      );
      assert.deepEqual(
        { outputResidue, stagingResidue },
        {
          outputResidue: [],
          stagingResidue: [],
        },
      );
    } finally {
      await builds;
      await rm(temporary, { recursive: true, force: true });
    }
  },
);
