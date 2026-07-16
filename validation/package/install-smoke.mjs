import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  access,
  cp,
  mkdtemp,
  mkdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { marked } from "marked";

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
const source = path.join(temporary, "source");
const binary = path.join(prefix, "bin", "htmlview");
const controlSocket = path.join(state, "control.sock");
const supervisorLock = path.join(state, "supervisor.lock");
const installedPackage = path.join(
  prefix,
  "lib",
  "node_modules",
  ...packageMetadata.name.split("/"),
);
const environment = {
  ...process.env,
  HTMLVIEW_STATE_DIR: state,
  HTMLVIEW_IDLE_MS: "1000",
};
delete environment.NO_COLOR;
delete environment.FORCE_COLOR;

async function packageManager(args, cwd = repository) {
  return execute("pnpm", args, {
    cwd,
    env: environment,
    maxBuffer: 10 * 1024 * 1024,
  });
}

async function consumerNpm(args, cwd = repository) {
  return execute("npm", args, {
    cwd,
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

async function waitForSupervisorExit(pid) {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    const socketPresent = await access(controlSocket)
      .then(() => true)
      .catch(() => false);
    const lockPresent = await access(supervisorLock)
      .then(() => true)
      .catch(() => false);
    let processPresent = false;
    if (pid !== undefined) {
      try {
        process.kill(pid, 0);
        processPresent = true;
      } catch {
        processPresent = false;
      }
    }
    if (!socketPresent && !lockPresent && !processPresent) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(
    "Installed supervisor retained its process, socket, or lock after stop --all",
  );
}

await Promise.all([
  mkdir(artifacts),
  mkdir(repeatedArtifacts),
  mkdir(fixture),
  cp(repository, source, {
    recursive: true,
    filter: (candidate) => {
      const first = path.relative(repository, candidate).split(path.sep)[0];
      return ![
        ".git",
        "coverage",
        "dist",
        "node_modules",
        "playwright-report",
        "test-results",
      ].includes(first);
    },
  }),
]);
await symlink(
  path.join(repository, "node_modules"),
  path.join(source, "node_modules"),
);
await writeFile(
  path.join(fixture, "report.html"),
  "<!doctype html><p>installed package</p>",
);

let supervisorPid;
try {
  const packed = await packageManager(
    ["pack", "--json", "--pack-destination", artifacts],
    source,
  );
  const packResult = JSON.parse(packed.stdout);
  assert.equal(packResult.name, packageMetadata.name);
  assert.equal(packResult.version, packageMetadata.version);
  const launcher = await readFile(path.join(source, "dist", "cli.js"), "utf8");
  const activation = launcher.match(
    /^#!\/usr\/bin\/env node\nimport "\.\/(generations\/[0-9a-f]{64})\/cli\.js";\n$/,
  );
  assert.notEqual(activation, null, "package launcher is not atomic");
  const generation = path.posix.join("dist", activation[1]);
  const generationArtifacts = [
    `${generation}/cli.js`,
    `${generation}/cli.js.map`,
    `${generation}/supervisor-main.js`,
    `${generation}/supervisor-main.js.map`,
  ];
  const paths = new Set(packResult.files.map(({ path: file }) => file));
  for (const required of [
    "dist/cli.js",
    ...generationArtifacts,
    "docs/INSTALL.md",
    "LICENSE",
    "README.md",
    "THIRD_PARTY_NOTICES.md",
  ])
    assert.equal(paths.has(required), true, `package is missing ${required}`);
  const exactFiles = new Set([
    "ARCHITECTURE.md",
    "CONTEXT.md",
    "LICENSE",
    "README.md",
    "THIRD_PARTY_NOTICES.md",
    "dist/cli.js",
    ...generationArtifacts,
    "docs/CLI.md",
    "docs/README.md",
    "docs/decisions/0001-separate-serving-from-browser-control.md",
    "docs/decisions/0002-per-user-loopback-supervisor.md",
    "docs/decisions/0003-adopt-an-axi-output-contract.md",
    "docs/decisions/0004-treat-the-serving-root-as-a-disclosure-grant.md",
    "docs/decisions/0005-use-node-typescript-pnpm-and-the-npm-registry.md",
    "docs/decisions/0006-use-a-private-control-socket.md",
    "docs/decisions/0007-adopt-effect-v4.md",
    "docs/decisions/0008-separate-raw-serving-from-instrumented-review.md",
    "docs/decisions/0009-adopt-effect-cli-and-logging.md",
    "docs/decisions/README.md",
    "docs/INSTALL.md",
    "docs/INTEROPERABILITY.md",
    "docs/PRODUCT.md",
    "docs/SECURITY_VALIDATION.md",
    "docs/THREAT_MODEL.md",
    "docs/validation/browser-origin.md",
    "package.json",
  ]);
  for (const file of paths)
    assert.equal(
      exactFiles.has(file),
      true,
      `package contains unexpected file ${file}`,
    );
  assert.equal(paths.size, exactFiles.size, "package file set is incomplete");
  for (const file of [...paths].filter((candidate) =>
    candidate.endsWith(".md"),
  )) {
    const contents = await readFile(path.join(source, file), "utf8");
    marked.walkTokens(marked.lexer(contents), (token) => {
      if (token.type !== "link" && token.type !== "image") return;
      const reference = token.href.split("#", 1)[0] ?? "";
      if (
        reference === "" ||
        /^[a-z]+:/i.test(reference) ||
        reference.startsWith("//")
      )
        return;
      const target = path.posix.normalize(
        path.posix.join(path.posix.dirname(file), decodeURI(reference)),
      );
      assert.equal(
        paths.has(target),
        true,
        `packaged document ${file} links to excluded ${target}`,
      );
    });
  }
  for (const sourceMap of [
    `${generation}/cli.js.map`,
    `${generation}/supervisor-main.js.map`,
  ])
    assert.equal(
      Object.hasOwn(
        JSON.parse(await readFile(path.join(source, sourceMap), "utf8")),
        "sourcesContent",
      ),
      false,
      `${sourceMap} embeds source content`,
    );
  for (const executable of [
    `${generation}/cli.js`,
    `${generation}/supervisor-main.js`,
  ])
    assert.match(
      await readFile(path.join(source, executable), "utf8"),
      /\/\/# sourceMappingURL=[^\n]+\.js\.map\s*$/,
      `${executable} does not link its external source map`,
    );
  const tarball = path.resolve(artifacts, packResult.filename);
  const launcherBeforeFailedPack = await readFile(
    path.join(source, "dist", "cli.js"),
  );
  const inactiveGeneration = path.join(
    source,
    "dist",
    "generations",
    "0".repeat(64),
  );
  await mkdir(inactiveGeneration);
  await assert.rejects(
    packageManager(
      ["pack", "--json", "--pack-destination", repeatedArtifacts],
      source,
    ),
    /Package builds require clean output containing only the active htmlview generation/,
  );
  assert.deepEqual(
    await readFile(path.join(source, "dist", "cli.js")),
    launcherBeforeFailedPack,
  );
  await rm(inactiveGeneration, { recursive: true });

  const repeatedPack = JSON.parse(
    (
      await packageManager(
        ["pack", "--json", "--pack-destination", repeatedArtifacts],
        source,
      )
    ).stdout,
  );
  assert.deepEqual(
    await readFile(path.resolve(repeatedArtifacts, repeatedPack.filename)),
    await readFile(tarball),
  );

  await consumerNpm(["install", "--global", tarball, "--prefix", prefix]);
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
  supervisorPid = JSON.parse(
    await readFile(path.join(supervisorLock, "owner.json"), "utf8"),
  ).pid;
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
  await waitForSupervisorExit(supervisorPid);

  await consumerNpm(["install", "--global", tarball, "--prefix", prefix]);
  assert.equal(
    JSON.parse((await installed(["--version", "--json"])).stdout).version,
    packageMetadata.version,
  );

  await consumerNpm([
    "uninstall",
    "--global",
    packageMetadata.name,
    "--prefix",
    prefix,
  ]);
  await assert.rejects(access(binary));
  await assert.rejects(access(installedPackage));
  process.stdout.write(
    `${JSON.stringify({ platform: process.platform, version: packageMetadata.version, reproducible: "passed", install: "passed", reinstall: "passed", uninstall: "passed" })}\n`,
  );
} finally {
  await installed(["stop", "--all", "--json"]).catch(() => undefined);
  await waitForSupervisorExit(supervisorPid).catch(() => undefined);
  await rm(temporary, { recursive: true, force: true });
}
