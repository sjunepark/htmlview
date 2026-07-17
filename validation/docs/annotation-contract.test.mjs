import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

async function read(relativePath) {
  return readFile(new URL(`../../${relativePath}`, import.meta.url), "utf8");
}

test("public docs make annotation a required 0.1.0 feature", async () => {
  const [product, readme, install] = await Promise.all([
    read("docs/PRODUCT.md"),
    read("README.md"),
    read("docs/INSTALL.md"),
  ]);

  assert.match(product, /^### Review and feedback$/m);
  assert.match(product, /separate instrumented surface/);
  assert.match(product, /element-targeted and freeform comments/);
  assert.match(product, /accepted `0\.1\.0` target/);
  assert.match(readme, /trusted review surface\s+are implemented/);
  assert.match(
    readme,
    /Automatic refresh of a ready review.*next `0\.1\.0` implementation slice/s,
  );
  assert.doesNotMatch(readme, /runtime is not implemented/);
  assert.doesNotMatch(readme, /Human annotations are a possible later layer/);
  assert.match(
    install,
    /Annotation commands and the review runtime are.*implemented/s,
  );
  assert.match(install, /automatic selected-entry refresh.*remain/s);
});

test("public docs make automatic refresh review-owned and leave raw passive", async () => {
  const [product, architecture, adr, interoperability, plan] =
    await Promise.all([
      read("docs/PRODUCT.md"),
      read("ARCHITECTURE.md"),
      read(
        "docs/decisions/0008-separate-raw-serving-from-instrumented-review.md",
      ),
      read("docs/INTEROPERABILITY.md"),
      read("docs/plans/annotation-mvp.md"),
    ]);

  assert.match(
    product,
    /automatically reload only the instrumented review iframe/,
  );
  assert.match(product, /does not.*inject a client into raw\s+HTML/s);
  assert.match(
    architecture,
    /^### Automatic selected-entry refresh \(accepted, pending\)$/m,
  );
  assert.match(architecture, /already-loaded raw page.*under its own control/s);
  assert.match(adr, /make selected-entry refresh review-owned and automatic/);
  assert.match(
    interoperability,
    /external browser\/controller must reload any already-open raw page/,
  );
  assert.match(plan, /Phase 5 automatic refresh next/);
  assert.match(
    plan,
    /edits the original entry without calling `location\.reload\(\)`/,
  );
});

test("CLI docs define review, feedback, acknowledgement, and deletion", async () => {
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
  assert.match(cli, /delivery does\s+not acknowledge it/);
  assert.match(cli, /persisted acknowledged cursor/);
  assert.match(cli, /final batch unacknowledged for the agent/);
  assert.match(cli, /review_count: 0/);
  assert.match(cli, /reviews\[2\]\{id,status,session,drafts,unacknowledged\}/);
  assert.match(cli, /stopped, unended review resumes its stable\s+review ID/);
  assert.match(cli, /logs are never a feedback transport/i);
});

test("architecture and threat model preserve raw fidelity and review isolation", async () => {
  const [architecture, threatModel] = await Promise.all([
    read("ARCHITECTURE.md"),
    read("docs/THREAT_MODEL.md"),
  ]);

  assert.match(architecture, /\*\*Raw file bodies are unmodified\.\*\*/);
  assert.match(architecture, /^### Review service \(implemented\)$/m);
  assert.match(architecture, /trusted shell origin/);
  assert.match(architecture, /instrumented-content origin/);
  assert.match(architecture, /never opens a served file for writing/);
  assert.doesNotMatch(architecture, /\[target\]/);
  assert.match(
    architecture,
    /0008-separate-raw-serving-from-instrumented-review\.md|Decision index/,
  );

  assert.match(threatModel, /exact shell `Origin`/);
  assert.match(threatModel, /schema-validated `postMessage` boundary/);
  assert.match(threatModel, /authored scripts can forge it/i);
  assert.match(
    threatModel,
    /one random probe URL per instrumented navigation/i,
  );
  assert.match(threatModel, /private Unix-domain control socket/);
  assert.match(threatModel, /raw remains the fidelity reference/);
});

test("ADR and domain language lock anchoring, durability, and cursor terms", async () => {
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
  assert.match(adr, /non-tombstone review summaries/);
  assert.match(product, /Text-range selection or quote anchoring in `0\.1\.0`/);
  assert.match(context, /Delivery alone does not acknowledge it/);
  assert.match(context, /highest feedback cursor.*explicitly\s+acknowledged/s);

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
    "Acknowledged cursor",
    "Private state",
    "Diagnostic log",
  ]) {
    assert.match(context, new RegExp(`\\*\\*${term}\\*\\*:`));
  }
});

test("documentation map and ADR index define canonical ownership", async () => {
  const [map, decisions] = await Promise.all([
    read("docs/README.md"),
    read("docs/decisions/README.md"),
  ]);

  for (const owner of [
    "Product requirements",
    "CLI contract",
    "Domain language",
    "Architecture",
    "Threat model",
    "Security evidence",
    "Decision index",
  ])
    assert.match(map, new RegExp(`\\[${owner}\\]`, "i"));

  assert.match(
    map,
    /plans are the\s+source of truth for implementation progress/,
  );
  assert.match(decisions, /ADRs record why a durable choice was made/);
  assert.match(decisions, /0003.*Partially superseded/);
  assert.match(decisions, /0007.*Partially superseded/);
});
