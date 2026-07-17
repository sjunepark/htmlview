import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

async function read(relativePath) {
  return readFile(new URL(`../../${relativePath}`, import.meta.url), "utf8");
}

test("Effect CLI and logging remain the accepted target boundary", async () => {
  const [cli, adr, grantAdr, threatModel, effectPlan] = await Promise.all([
    read("docs/CLI.md"),
    read("docs/decisions/0009-adopt-effect-cli-and-logging.md"),
    read("docs/decisions/0004-treat-the-serving-root-as-a-disclosure-grant.md"),
    read("docs/THREAT_MODEL.md"),
    read("docs/plans/effect-v4-adoption.md"),
  ]);

  assert.match(cli, /`effect\/unstable\/cli` API is the sole parser/);
  assert.match(cli, /`--completions <bash\|zsh\|fish\|sh>`/);
  assert.match(cli, /There is no exit `2` contract/);
  assert.match(cli, /`--json` does not alter a native usage failure/);
  assert.match(cli, /bounded, rotated JSONL/);

  assert.match(adr, /- Status: Accepted/);
  assert.match(adr, /remove the custom parser/);
  assert.match(adr, /logs remain diagnostics only/);
  assert.match(adr, /closed diagnostic-event type/);
  assert.match(adr, /`0700` directory and\s+`0600` file permissions/);
  assert.match(adr, /pinned Effect source/);

  assert.match(
    grantAdr,
    /canonical overlap between the serving root and\s+htmlview's private state directory/,
  );
  assert.match(
    grantAdr,
    /neither may equal, contain, or be contained\s+by the other/,
  );
  assert.match(threatModel, /Never log comments\s+or prompt text/);
  assert.match(threatModel, /Logs never deliver feedback/);

  assert.match(effectPlan, /^## Phase 10: Effect CLI and diagnostic logging$/m);
  assert.match(effectPlan, /exact pinned source/);
});
