import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

const skillDirectory = path.join(process.cwd(), "skills", "htmlview");

test("the distributed htmlview skill preserves its agent contract", async () => {
  const [skill, review, metadata, install] = await Promise.all([
    readFile(path.join(skillDirectory, "SKILL.md"), "utf8"),
    readFile(path.join(skillDirectory, "references", "review-loop.md"), "utf8"),
    readFile(path.join(skillDirectory, "agents", "openai.yaml"), "utf8"),
    readFile(path.join(process.cwd(), "docs", "INSTALL.md"), "utf8"),
  ]);
  const frontmatter = skill.match(/^---\n([\s\S]*?)\n---\n/);

  assert.notEqual(frontmatter, null, "SKILL.md has no YAML frontmatter");
  assert.deepEqual(
    frontmatter[1].split("\n").map((line) => line.split(":", 1)[0]),
    ["name", "description"],
  );
  assert.match(frontmatter[1], /^name: htmlview$/m);
  assert.match(
    frontmatter[1],
    /^description: "Manual htmlview workflow for serving and reviewing local HTML; use only when the user explicitly invokes \$htmlview\."$/m,
  );
  assert.match(skill, /htmlview <command> --help/);
  assert.match(skill, /narrowest serving grant/);
  assert.match(skill, /references\/review-loop\.md/);
  assert.match(skill, /For a source-checkout candidate/);
  assert.match(skill, /node scripts\/pack-release\.mjs "\$candidate_dir"/);
  assert.match(skill, /npm install --global "\$tarball"/);
  assert.match(
    skill,
    /For a registry installation, suggest `npm install --global\s+@sjunepark\/htmlview`/,
  );
  assert.match(review, /Delivery does not\s+acknowledge the batch/);
  assert.match(review, /htmlview feedback --after <cursor>/);
  assert.match(review, /feedback returned by either acknowledgement command/);
  assert.match(
    review,
    /Use `--discard-feedback` only with explicit authorization/,
  );
  assert.match(metadata, /default_prompt: "Use \$htmlview /);
  assert.match(metadata, /policy:\n {2}allow_implicit_invocation: false/);

  const installSection = install.match(
    /^## Install the Agent Skill$[\s\S]*?(?=^## Review an installed page$)/m,
  )?.[0];
  const upgradeSection = install.match(
    /^## Upgrade$[\s\S]*?(?=^## Remove$)/m,
  )?.[0];
  assert.notEqual(installSection, undefined);
  assert.notEqual(upgradeSection, undefined);
  for (const section of [installSection, upgradeSection]) {
    assert.match(
      section,
      /^npx skills add "\$skill_source" --skill htmlview --copy$/m,
    );
    assert.match(
      section,
      /^npx skills add "\$skill_source" --skill htmlview --copy --global$/m,
    );
  }
});
