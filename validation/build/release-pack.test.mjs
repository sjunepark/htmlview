import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

const execute = promisify(execFile);

test("release packing ignores checkout build state and emits the root package", async () => {
  const destination = await mkdtemp(
    path.join(tmpdir(), "htmlview-release-test-"),
  );
  try {
    const { stdout } = await execute(
      process.execPath,
      ["scripts/pack-release.mjs", destination],
      { cwd: process.cwd(), encoding: "utf8", maxBuffer: 10 * 1024 * 1024 },
    );
    const tarball = stdout.trim();
    assert.equal(path.dirname(tarball), destination);

    const { stdout: packageText } = await execute(
      "tar",
      ["-xOf", tarball, "package/package.json"],
      { encoding: "utf8", maxBuffer: 1024 * 1024 },
    );
    const packed = JSON.parse(packageText);
    const source = JSON.parse(await readFile("package.json", "utf8"));
    assert.equal(packed.name, source.name);
    assert.equal(packed.version, source.version);
  } finally {
    await rm(destination, { recursive: true, force: true });
  }
});
