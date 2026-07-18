import { execFile } from "node:child_process";
import { cp, mkdtemp, mkdir, rm, stat, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execute = promisify(execFile);
const repository = process.cwd();
const destinationArgument = process.argv[2];

if (destinationArgument === undefined) {
  throw new Error("Usage: node scripts/pack-release.mjs <artifact-directory>");
}

const destination = path.resolve(destinationArgument);
const relativeDestination = path.relative(repository, destination);
if (
  relativeDestination === "" ||
  (!relativeDestination.startsWith(`..${path.sep}`) &&
    relativeDestination !== "..")
) {
  throw new Error("Release artifacts must be written outside the repository");
}

const metadata = await stat(destination).catch(() => undefined);
if (metadata !== undefined && !metadata.isDirectory()) {
  throw new Error("Release artifact destination must be a directory");
}
await mkdir(destination, { recursive: true });

const temporary = await mkdtemp(
  path.join(tmpdir(), "htmlview-release-source-"),
);
const source = path.join(temporary, "source");

try {
  await cp(repository, source, {
    recursive: true,
    filter(candidate) {
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
  });
  await symlink(
    path.join(repository, "node_modules"),
    path.join(source, "node_modules"),
  );
  const { stdout } = await execute(
    "pnpm",
    ["pack", "--json", "--pack-destination", destination],
    { cwd: source, encoding: "utf8", maxBuffer: 10 * 1024 * 1024 },
  );
  const result = JSON.parse(stdout);
  const filename = Array.isArray(result)
    ? result[0]?.filename
    : result.filename;
  if (typeof filename !== "string" || filename.length === 0) {
    throw new Error("pnpm pack did not return an artifact filename");
  }
  process.stdout.write(path.resolve(destination, filename));
} finally {
  await rm(temporary, { recursive: true, force: true });
}
