import assert from "node:assert/strict";
import { mkdtemp, mkdir, realpath, symlink, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import { Effect } from "effect";
import {
  isBroadServingRoot,
  resolveServingGrant as resolveServingGrantEffect,
  type ServingGrant,
} from "../src/serving/grant.js";
import { PathError } from "../src/errors.js";

const temporaryDirectories: string[] = [];

function resolveServingGrant(
  entry: string,
  options?: { readonly root?: string; readonly cwd?: string },
): Promise<ServingGrant> {
  return Effect.runPromise(resolveServingGrantEffect(entry, options));
}

async function fixtureDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "htmlview-grant-"));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("serving grants", () => {
  it("rejects roots equal to or broader than the user home", async () => {
    const home = await realpath(homedir());
    assert.equal(isBroadServingRoot(home, home), true);
    assert.equal(isBroadServingRoot(path.dirname(home), home), true);
    assert.equal(isBroadServingRoot(path.join(home, "projects"), home), false);

    const root = await fixtureDirectory();
    const entry = path.join(root, "report.html");
    await writeFile(entry, "fixture");
    await assert.rejects(
      resolveServingGrant(entry, { root: path.parse(home).root }),
      (error: unknown) =>
        error instanceof PathError && error.code === "path.root_too_broad",
    );
  });

  it("uses the supplied entry parent as the default grant", async () => {
    const root = await fixtureDirectory();
    await mkdir(path.join(root, "pages"));
    await writeFile(path.join(root, "pages", "report ü.html"), "fixture");
    const grant = await resolveServingGrant("pages/report ü.html", {
      cwd: root,
    });
    assert.equal(grant.root, await realpath(path.join(root, "pages")));
    assert.equal(grant.entryRelativePath, "report ü.html");
    assert.equal(grant.entryUrlPath, "/report%20%C3%BC.html");
  });

  it("accepts only an explicit broader grant", async () => {
    const root = await fixtureDirectory();
    await mkdir(path.join(root, "pages"));
    await writeFile(path.join(root, "pages", "report.html"), "fixture");
    const grant = await resolveServingGrant("pages/report.html", {
      cwd: root,
      root,
    });
    assert.equal(grant.root, await realpath(root));
    assert.equal(grant.entryUrlPath, "/pages/report.html");
  });

  it("rejects a default-root escape through an entry symlink", async () => {
    const base = await fixtureDirectory();
    const root = path.join(base, "root");
    await mkdir(root);
    await writeFile(path.join(base, "outside.html"), "outside");
    await symlink(
      path.join(base, "outside.html"),
      path.join(root, "entry.html"),
    );
    await assert.rejects(
      resolveServingGrant("entry.html", { cwd: root }),
      (error: unknown) =>
        error instanceof PathError &&
        error.code === "path.entry_symlink_escape",
    );
  });

  it("preserves an authorized in-root symlink as the public entry path", async () => {
    const root = await fixtureDirectory();
    await mkdir(path.join(root, "actual"));
    await writeFile(path.join(root, "actual", "target.html"), "fixture");
    await symlink(
      path.join(root, "actual", "target.html"),
      path.join(root, "report.html"),
    );
    const grant = await resolveServingGrant("report.html", { cwd: root });
    assert.equal(
      grant.entry,
      await realpath(path.join(root, "actual", "target.html")),
    );
    assert.equal(
      grant.routeEntry,
      await realpath(root).then((canonicalRoot) =>
        path.join(canonicalRoot, "report.html"),
      ),
    );
    assert.equal(grant.entryUrlPath, "/report.html");
  });

  it("rejects non-HTML and non-file entries", async () => {
    const root = await fixtureDirectory();
    await writeFile(path.join(root, "entry.txt"), "text");
    await mkdir(path.join(root, "entry.html"));
    await assert.rejects(
      resolveServingGrant("entry.txt", { cwd: root }),
      (error: unknown) =>
        error instanceof PathError && error.code === "path.entry_not_html",
    );
    await assert.rejects(
      resolveServingGrant("entry.html", { cwd: root }),
      (error: unknown) =>
        error instanceof PathError && error.code === "path.entry_not_file",
    );
  });
});
