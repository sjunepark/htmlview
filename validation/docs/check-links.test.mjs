import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import {
  markdownFiles,
  markdownHeadingIds,
  markdownReferences,
  unresolvedMarkdownLinks,
} from "./check-links.mjs";

const execute = promisify(execFile);

test("extracts Markdown destinations without scanning code", () => {
  const fence = "```";
  const contents = [
    '[balanced](docs/a(b).md "Guide")',
    String.raw`[escaped](docs/a\(b\).md)`,
    '[angle](<docs/a b.md> "Title")',
    "`[inline](missing-inline.md)`",
    `${fence}md`,
    "[fenced](missing-fenced.md)",
    fence,
  ].join("\n");

  assert.deepEqual(markdownReferences(contents), [
    "docs/a(b).md",
    "docs/a(b).md",
    "docs/a b.md",
  ]);
});

test("derives heading identifiers from rendered inline text", () => {
  assert.deepEqual(
    [
      ...markdownHeadingIds(
        "# [Phase 10](elsewhere.md): `Effect` CLI\n## Phase 10: Effect CLI",
      ),
    ],
    ["phase-10-effect-cli", "phase-10-effect-cli-1"],
  );
});

test("reports missing files and heading fragments", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "htmlview-doc-links-"));
  try {
    const source = path.join(root, "source.md");
    const target = path.join(root, "target.md");
    await writeFile(target, "# Existing heading\n");
    await writeFile(
      source,
      [
        "[valid](target.md#existing-heading)",
        "[fragment](target.md#missing-heading)",
        "[file](missing.md)",
      ].join("\n"),
    );

    assert.deepEqual(await unresolvedMarkdownLinks(root, [source, target]), [
      `${source}: target.md#missing-heading (missing fragment)`,
      `${source}: missing.md`,
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("does not interpret non-Markdown fragments as headings", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "htmlview-doc-fragments-"));
  try {
    const source = path.join(root, "source.md");
    const target = path.join(root, "target.html");
    await writeFile(target, '<div id="content">content</div>\n');
    await writeFile(source, "[content](target.html#content)\n");

    assert.deepEqual(await unresolvedMarkdownLinks(root, [source]), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("scans tracked and nonignored untracked Markdown only", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "htmlview-doc-scope-"));
  try {
    await execute("git", ["init", "--quiet"], { cwd: root });
    await writeFile(path.join(root, ".gitignore"), ".tmp/\n");
    await writeFile(path.join(root, "tracked.md"), "# Tracked\n");
    await writeFile(path.join(root, "deleted.md"), "# Deleted\n");
    await writeFile(path.join(root, "untracked.md"), "# Untracked\n");
    await mkdir(path.join(root, ".tmp"));
    await writeFile(path.join(root, ".tmp", "ignored.md"), "# Ignored\n");
    await execute("git", ["add", ".gitignore", "tracked.md", "deleted.md"], {
      cwd: root,
    });
    await rm(path.join(root, "deleted.md"));

    assert.deepEqual(await markdownFiles(root), [
      path.join(root, "tracked.md"),
      path.join(root, "untracked.md"),
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
