import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { expect, test } from "@playwright/test";
import { entryPath, fixtureRoot } from "./fixture.mjs";

const execute = promisify(execFile);
const cli = path.resolve("dist/cli.js");
const baseEntryPath = path.join(fixtureRoot, "pages", "base.html");

async function command(environment, ...args) {
  const result = await execute(process.execPath, [cli, ...args, "--json"], {
    env: environment,
  });
  expect(result.stderr).toBe("");
  return JSON.parse(result.stdout);
}

test("a human can deliver durable element and page feedback without changing raw serving", async ({
  page,
}) => {
  const stateParent = await mkdtemp(path.join(tmpdir(), "hv-review-browser-"));
  const environment = {
    ...process.env,
    HTMLVIEW_STATE_DIR: path.join(stateParent, "state"),
    HTMLVIEW_IDLE_MS: "10000",
  };
  delete environment.NO_COLOR;
  delete environment.FORCE_COLOR;
  try {
    const served = await command(
      environment,
      "serve",
      entryPath,
      "--root",
      fixtureRoot,
    );
    const rawBefore = await fetch(served.session.url).then((response) =>
      response.arrayBuffer(),
    );
    const opened = await command(environment, "review", served.session.id);

    await page.goto(opened.review.url);
    const content = page.frameLocator("#content");
    await expect(content.locator("#title")).toHaveText("fixture");
    await expect(page.locator("#review-status")).toHaveText(
      "Annotation review",
    );

    await content.locator("#title").click();
    await expect(page.locator("#editor")).toBeVisible();
    await content.locator("#title").evaluate(() => location.reload());
    await expect(page.locator("#editor")).toBeHidden();
    await expect(content.locator("#title")).toHaveText("fixture");
    await expect(page.locator("#live")).toHaveText("Annotation tools ready");
    await content.locator("#title").click();
    await expect(page.locator("#target-label")).toHaveText(
      "h1 · untrusted page context",
    );
    await page.locator("#comment").fill("Make the fixture title clearer");
    await page.getByRole("button", { name: "Add draft" }).click();
    await page.getByRole("button", { name: "Page note" }).click();
    await page.locator("#comment").fill("Add a short source note");
    await expect(page.locator(".draft")).toHaveCount(1);
    await expect(page.locator("#editor")).toBeVisible();
    await expect(page.locator("#comment")).toHaveValue(
      "Add a short source note",
    );
    await expect(page.getByRole("button", { name: "Add draft" })).toBeEnabled();
    await page.getByRole("button", { name: "Add draft" }).click();
    await expect(page.locator(".draft")).toHaveCount(2);

    await content.locator("body").dispatchEvent("click");
    await expect(page.locator("#target-label")).toHaveText(
      "body · untrusted page context",
    );
    await page.locator("#comment").fill("Review the whole page");
    await page.getByRole("button", { name: "Add draft" }).click();
    await expect(page.locator(".draft")).toHaveCount(3);
    await expect(content.locator("body")).not.toContainText(
      "Make the fixture title clearer",
    );

    await page.getByRole("button", { name: "Send selected" }).click();
    await expect(page.locator("#live")).toHaveText("3 drafts sent");
    await expect(page.locator(".draft")).toHaveCount(0);

    const delivered = await command(environment, "feedback", opened.review.id);
    expect(delivered.count).toBe(3);
    expect(delivered.feedback).toMatchObject([
      {
        kind: "element",
        comment: "Make the fixture title clearer",
        entry: "/pages/report%20space%20%C3%BC.html",
        anchor: { selector: "#title", tag: "h1", text: "fixture" },
      },
      {
        kind: "freeform",
        comment: "Add a short source note",
        entry: "/pages/report%20space%20%C3%BC.html",
      },
      {
        kind: "element",
        comment: "Review the whole page",
        entry: "/pages/report%20space%20%C3%BC.html",
      },
    ]);
    expect(delivered.feedback[2].anchor.text).not.toContain(
      "INLINE_SCRIPT_CANARY_MUST_NOT_PERSIST",
    );

    for (const comment of ["Keep this final note", "Discard this draft"]) {
      await page.getByRole("button", { name: "Page note" }).click();
      await page.locator("#comment").fill(comment);
      await page.getByRole("button", { name: "Add draft" }).click();
    }
    await page.locator('.draft input[type="checkbox"]').nth(1).uncheck();
    await page.getByRole("button", { name: "Send & end" }).click();
    await expect(page.locator("#end-confirm")).toBeVisible();
    await page
      .getByRole("button", { name: "Discard unselected and end" })
      .click();
    await expect(page.locator("#review-status")).toHaveText(
      "Feedback sent · review ended",
    );

    const final = await command(
      environment,
      "feedback",
      opened.review.id,
      "--after",
      String(delivered.cursor),
    );
    expect(final).toMatchObject({
      review: { status: "ended" },
      count: 1,
      feedback: [{ kind: "freeform", comment: "Keep this final note" }],
    });
    await expect
      .poll(() =>
        fetch(opened.review.url).then(
          () => "open",
          () => "closed",
        ),
      )
      .toBe("closed");
    expect(
      Buffer.compare(
        Buffer.from(rawBefore),
        Buffer.from(
          await fetch(served.session.url).then((response) =>
            response.arrayBuffer(),
          ),
        ),
      ),
    ).toBe(0);
  } finally {
    await execute(process.execPath, [cli, "stop", "--all", "--json"], {
      env: environment,
    }).catch(() => undefined);
    await rm(stateParent, { recursive: true, force: true });
  }
});

test("an authored base URL cannot redirect the immutable review probe", async ({
  page,
}) => {
  const stateParent = await mkdtemp(path.join(tmpdir(), "hv-review-base-"));
  const environment = {
    ...process.env,
    HTMLVIEW_STATE_DIR: path.join(stateParent, "state"),
    HTMLVIEW_IDLE_MS: "10000",
  };
  delete environment.NO_COLOR;
  delete environment.FORCE_COLOR;
  const foreignRequests = [];
  page.on("request", (request) => {
    if (request.url().startsWith("https://attacker.invalid/"))
      foreignRequests.push(request.url());
  });
  try {
    const served = await command(
      environment,
      "serve",
      baseEntryPath,
      "--root",
      fixtureRoot,
    );
    const opened = await command(environment, "review", served.session.id);
    await page.goto(opened.review.url);
    const content = page.frameLocator("#content");
    await expect(content.locator("#base-title")).toHaveText(
      "The review probe stays local",
    );
    await expect(page.locator("#live")).toHaveText("Annotation tools ready");
    await page.getByRole("button", { name: "Page note" }).click();
    await page.locator("#comment").fill("Probe loaded from the content origin");
    await page.getByRole("button", { name: "Add draft" }).click();
    await expect(page.locator(".draft")).toHaveCount(1);
    expect(foreignRequests).toEqual([]);
  } finally {
    await execute(process.execPath, [cli, "stop", "--all", "--json"], {
      env: environment,
    }).catch(() => undefined);
    await rm(stateParent, { recursive: true, force: true });
  }
});
