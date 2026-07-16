import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

async function read(relativePath) {
  return readFile(new URL(`../../${relativePath}`, import.meta.url), "utf8");
}

test("public docs make annotation a required 0.1.0 feature", async () => {
  const [product, readme, plan] = await Promise.all([
    read("docs/PRODUCT.md"),
    read("README.md"),
    read("PLAN.md"),
  ]);

  assert.match(product, /^### Review and feedback$/m);
  assert.match(product, /separate instrumented surface/);
  assert.match(product, /element-targeted and freeform comments/);
  assert.doesNotMatch(product, /Annotation in version one/);
  assert.match(readme, /required `0\.1\.0` milestone/);
  assert.doesNotMatch(readme, /Human annotations are a possible later layer/);
  assert.match(plan, /Human annotation is a core first-release feature/);
});

test("CLI docs define the review, feedback, and explicit deletion contracts", async () => {
  const cli = await read("docs/CLI.md");

  assert.match(cli, /htmlview review \[--json\] <session>/);
  assert.match(
    cli,
    /htmlview feedback \[--wait\] \[--after <cursor>\] \[--json\] <review>/,
  );
  assert.match(
    cli,
    /htmlview review delete \[--discard-feedback\] \[--json\] <review>/,
  );
  assert.match(cli, /htmlview stop \[--json\] <session>/);
  assert.match(cli, /htmlview stop --all \[--json\]/);
  assert.doesNotMatch(cli, /htmlview stop \[--all\].*\[<session>\]/);
  assert.match(cli, /"fidelity": "instrumented_review"/);
  assert.match(cli, /feedback\.consumer_busy/);
  assert.match(cli, /feedback\.cursor_ahead/);
  assert.match(cli, /review\.pending_feedback/);
  assert.match(cli, /duplicate delivery over loss/);
  assert.match(cli, /review_count: 0/);
  assert.match(cli, /reviews\[2\]\{id,status,session,drafts,unacknowledged\}/);
  assert.match(cli, /stopped, unended review resumes its stable\s+review ID/);
  assert.match(
    cli,
    /Logs are diagnostics, not a feedback transport|logs are never a feedback transport/i,
  );
});

test("Effect CLI and logging are the accepted prerequisite boundary", async () => {
  const [cli, adr, grantAdr, plan, annotationPlan, threatModel] =
    await Promise.all([
      read("docs/CLI.md"),
      read("docs/decisions/0009-adopt-effect-cli-and-logging.md"),
      read(
        "docs/decisions/0004-treat-the-serving-root-as-a-disclosure-grant.md",
      ),
      read("PLAN.md"),
      read("docs/plans/annotation-mvp.md"),
      read("docs/THREAT_MODEL.md"),
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
  assert.match(
    grantAdr,
    /canonical overlap between the serving root and\s+htmlview's runtime state directory/,
  );
  assert.match(
    grantAdr,
    /neither may equal, contain, or be contained\s+by the other/,
  );

  assert.match(plan, /Implement Phase 10 of the Effect adoption plan/);
  assert.match(
    annotationPlan,
    /Effect CLI and\s+logging slice is the next prerequisite/,
  );
  assert.match(threatModel, /Never log comments\s+or prompt text/);
  assert.match(threatModel, /Logs never deliver feedback/);
});

test("architecture and threat model preserve raw fidelity and isolate review authority", async () => {
  const [architecture, threatModel] = await Promise.all([
    read("ARCHITECTURE.md"),
    read("docs/THREAT_MODEL.md"),
  ]);

  assert.match(architecture, /\*\*Raw file bodies are unmodified\.\*\*/);
  assert.match(architecture, /^### Review service \(`0\.1\.0` target\)$/m);
  assert.match(architecture, /trusted shell origin/);
  assert.match(architecture, /instrumented-content origin/);
  assert.match(architecture, /never opens a served file for writing/);
  assert.doesNotMatch(architecture, /optional annotation surface \(later\)/);
  assert.match(
    architecture,
    /0008-separate-raw-serving-from-instrumented-review\.md/,
  );

  assert.match(threatModel, /exact shell `Origin`/);
  assert.match(threatModel, /schema-validated `postMessage` boundary/);
  assert.match(threatModel, /can still forge valid-looking target context/i);
  assert.match(threatModel, /private Unix-domain control socket/);
  assert.match(threatModel, /raw remains the fidelity reference/);
});

test("ADR and domain language lock anchoring, durability, and lifecycle terms", async () => {
  const [adr, context, product] = await Promise.all([
    read(
      "docs/decisions/0008-separate-raw-serving-from-instrumented-review.md",
    ),
    read("CONTEXT.md"),
    read("docs/PRODUCT.md"),
  ]);

  assert.match(adr, /- Status: Accepted/);
  assert.match(adr, /Keep the raw session and `session\.url` unchanged/);
  assert.match(adr, /anchor schema version 1/);
  assert.match(adr, /SHA-256 revision/);
  assert.match(adr, /24-hour retry tombstone/);
  assert.match(adr, /One agent consumer per review/);
  assert.match(product, /Text-range selection or quote anchoring in `0\.1\.0`/);
  assert.match(adr, /non-tombstone review summaries/);

  for (const term of [
    "Serving grant",
    "Raw session",
    "Raw URL",
    "Review URL",
    "Review shell",
    "Review content",
    "Annotation draft",
    "Feedback event",
    "Feedback cursor",
    "Diagnostic log",
  ]) {
    assert.match(context, new RegExp(`\\*\\*${term}\\*\\*:`));
  }
});
