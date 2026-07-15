import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  access,
  mkdtemp,
  mkdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execute = promisify(execFile);
const repository = process.cwd();
const packageMetadata = JSON.parse(
  await readFile(path.join(repository, "package.json"), "utf8"),
);
const temporary = await mkdtemp(path.join(tmpdir(), "htmlview-package-"));
const artifacts = path.join(temporary, "artifacts");
const repeatedArtifacts = path.join(temporary, "artifacts-repeat");
const prefix = path.join(temporary, "prefix");
const state = path.join(temporary, "state");
const fixture = path.join(temporary, "fixture");
const binary = path.join(prefix, "bin", "htmlview");
const environment = {
  ...process.env,
  HTMLVIEW_STATE_DIR: state,
  HTMLVIEW_IDLE_MS: "50",
};
delete environment.NO_COLOR;
delete environment.FORCE_COLOR;

async function npm(args) {
  return execute("npm", args, {
    cwd: repository,
    env: environment,
    maxBuffer: 10 * 1024 * 1024,
  });
}

async function installed(args) {
  return execute(binary, args, {
    cwd: fixture,
    env: environment,
    maxBuffer: 1024 * 1024,
  });
}

async function waitForSupervisorExit() {
  const discovery = path.join(state, "supervisor.json");
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    const present = await access(discovery)
      .then(() => true)
      .catch(() => false);
    if (!present) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("Installed supervisor did not exit after stop --all");
}

await Promise.all([mkdir(artifacts), mkdir(repeatedArtifacts), mkdir(fixture)]);
await writeFile(
  path.join(fixture, "report.html"),
  "<!doctype html><p>installed package</p>",
);

try {
  const packed = await npm(["pack", "--json", "--pack-destination", artifacts]);
  const packResult = JSON.parse(packed.stdout)[0];
  assert.equal(packResult.version, packageMetadata.version);
  const paths = new Set(packResult.files.map(({ path: file }) => file));
  for (const required of [
    "dist/cli.js",
    "dist/version.js",
    "docs/INSTALL.md",
    "LICENSE",
    "README.md",
  ])
    assert.equal(paths.has(required), true, `package is missing ${required}`);
  assert.equal(
    [...paths].some((file) => file.startsWith("validation/")),
    false,
  );
  const tarball = path.join(artifacts, packResult.filename);
  const repeatedPack = JSON.parse(
    (await npm(["pack", "--json", "--pack-destination", repeatedArtifacts]))
      .stdout,
  )[0];
  assert.equal(repeatedPack.integrity, packResult.integrity);
  assert.equal(repeatedPack.shasum, packResult.shasum);

  await npm(["install", "--global", tarball, "--prefix", prefix]);
  const version = await installed(["--version", "--json"]);
  assert.equal(version.stderr, "");
  assert.deepEqual(JSON.parse(version.stdout), {
    command: "htmlview",
    version: packageMetadata.version,
  });
  const empty = JSON.parse((await installed(["--json"])).stdout);
  assert.equal(empty.count, 0);

  const served = JSON.parse(
    (await installed(["serve", "report.html", "--json"])).stdout,
  );
  assert.equal(
    new URL(served.session.url).hostname.endsWith(".localhost"),
    true,
  );
  assert.equal(
    served.grant.root,
    await import("node:fs/promises").then(({ realpath }) => realpath(fixture)),
  );
  assert.equal(
    await fetch(served.session.url).then((response) => response.text()),
    "<!doctype html><p>installed package</p>",
  );
  await installed(["stop", "--all", "--json"]);
  await waitForSupervisorExit();

  await npm(["install", "--global", tarball, "--prefix", prefix]);
  assert.equal(
    JSON.parse((await installed(["--version", "--json"])).stdout).version,
    packageMetadata.version,
  );

  await npm(["uninstall", "--global", "htmlview", "--prefix", prefix]);
  await assert.rejects(access(binary));
  await assert.rejects(
    access(path.join(prefix, "lib", "node_modules", "htmlview")),
  );
  process.stdout.write(
    `${JSON.stringify({ platform: process.platform, version: packageMetadata.version, reproducible: "passed", install: "passed", upgrade: "passed", uninstall: "passed" })}\n`,
  );
} finally {
  await installed(["stop", "--all", "--json"]).catch(() => undefined);
  await waitForSupervisorExit().catch(() => undefined);
  await rm(temporary, { recursive: true, force: true });
}
