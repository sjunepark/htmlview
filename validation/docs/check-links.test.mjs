import assert from "node:assert/strict";
import test from "node:test";
import { markdownReferences } from "./check-links.mjs";

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
