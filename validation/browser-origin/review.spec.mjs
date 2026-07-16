import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { expect, test } from "@playwright/test";
import { entryPath, fixtureRoot } from "./fixture.mjs";

const execute = promisify(execFile);
const cli = path.resolve("dist/cli.js");
const baseEntryPath = path.join(fixtureRoot, "pages", "base.html");
const controlsEntryPath = path.join(fixtureRoot, "pages", "controls.html");

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
    await expect(page.locator("#content")).toHaveAttribute(
      "sandbox",
      "allow-scripts allow-same-origin",
    );
    await expect(content.locator("#title")).toHaveText("fixture");
    await expect(page.locator("#review-status")).toHaveText(
      "Annotation review",
    );
    await expect(page.locator("#live")).toHaveText("Annotation tools ready");

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
    expect(delivered.feedback[2].anchor.text).toContain(
      "BUTTON_VISIBLE_CANARY",
    );
    for (const excluded of [
      "STYLE_SOURCE_CANARY_MUST_NOT_PERSIST",
      "TEMPLATE_SOURCE_CANARY_MUST_NOT_PERSIST",
      "INPUT_VALUE_CANARY_MUST_NOT_PERSIST",
      "TEXTAREA_VALUE_CANARY_MUST_NOT_PERSIST",
      "SELECT_VALUE_CANARY_MUST_NOT_PERSIST",
      "CREDENTIAL_URL_CANARY",
      "DATA_ATTRIBUTE_CANARY_MUST_NOT_PERSIST",
    ])
      expect(JSON.stringify(delivered.feedback[2].anchor)).not.toContain(
        excluded,
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

test("hostile authored content cannot read comments or execute stored context", async ({
  page,
}) => {
  const stateParent = await mkdtemp(path.join(tmpdir(), "hv-review-hostile-"));
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
    const opened = await command(environment, "review", served.session.id);
    const shellOrigin = new URL(opened.review.url).origin;
    await page.goto(opened.review.url);
    const content = page.frameLocator("#content");
    await expect(content.locator("#title")).toHaveText("fixture");
    await content.locator("body").evaluate(() => {
      window.__reviewMessages = [];
      window.addEventListener("message", (event) => {
        window.__reviewMessages.push(event.data);
      });
    });

    const secret =
      '<img src=x onerror="window.__htmlviewXss=true">COMMENT_SECRET';
    await page.getByRole("button", { name: "Page note" }).click();
    await page.locator("#comment").fill(secret);
    const isolation = await content
      .locator("body")
      .evaluate(async (_, origin) => {
        let parentRead;
        try {
          parentRead = window.parent.document.body.textContent;
        } catch (error) {
          parentRead = error.name;
        }
        const request = (path, options) =>
          fetch(`${origin}${path}`, options).then(
            () => "readable",
            (error) => error.name,
          );
        return {
          parentRead,
          state: await request("/.htmlview/api/state"),
          jsonMutation: await request("/.htmlview/api/drafts", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: "{}",
          }),
          simpleMutation: await request("/.htmlview/api/drafts", {
            method: "POST",
            headers: { "content-type": "text/plain" },
            body: "{}",
          }),
        };
      }, shellOrigin);
    expect(isolation).toEqual({
      parentRead: "SecurityError",
      state: "TypeError",
      jsonMutation: "TypeError",
      simpleMutation: "TypeError",
    });
    await expect(page.locator(".draft")).toHaveCount(0);

    await page.getByRole("button", { name: "Explore" }).click();
    await page.getByRole("button", { name: "Annotate" }).click();
    const messages = await content
      .locator("body")
      .evaluate(() => window.__reviewMessages);
    expect(JSON.stringify(messages)).not.toContain("COMMENT_SECRET");
    expect(messages).toEqual(
      expect.arrayContaining([
        {
          channel: "htmlview.review",
          version: 1,
          type: "set_mode",
          mode: "explore",
        },
        {
          channel: "htmlview.review",
          version: 1,
          type: "set_mode",
          mode: "annotate",
        },
      ]),
    );

    await page.getByRole("button", { name: "Page note" }).click();
    await page.locator("#comment").fill(secret);
    await page.getByRole("button", { name: "Add draft" }).click();
    await expect(page.locator(".draft")).toHaveCount(1);
    await expect(page.locator(".draft p")).toHaveText(secret);
    await expect(page.locator(".draft img")).toHaveCount(0);
    expect(await page.evaluate(() => window.__htmlviewXss)).toBeUndefined();
    await expect(content.locator("body")).not.toContainText("COMMENT_SECRET");

    await content.locator("body").evaluate(() => {
      const base = {
        channel: "htmlview.review",
        version: 1,
        type: "target_selected",
        handle: "invalid-target",
        anchor: {
          selector: "body",
          dom_path: "html[0]/body[0]",
          tag: "body",
        },
        rect: { x: 0, y: 0, width: 10, height: 10 },
      };
      for (const value of [
        { ...base, version: 2 },
        { ...base, extra: "rejected" },
        { ...base, handle: "x".repeat(65) },
        { ...base, rect: { ...base.rect, width: -1 } },
      ])
        window.parent.postMessage(value, "*");
    });
    await expect(page.locator("#editor")).toBeHidden();

    await content.locator("body").evaluate(() => {
      window.parent.postMessage(
        {
          channel: "htmlview.review",
          version: 1,
          type: "target_selected",
          handle: "forged-target",
          anchor: {
            selector: '<img src=x onerror="window.__htmlviewXss=true">',
            dom_path: "html[0]/body[0]",
            tag: "<img>",
            text: "<script>window.__htmlviewXss=true</script>",
          },
          rect: { x: 0, y: 0, width: 10, height: 10 },
        },
        "*",
      );
    });
    await expect(page.locator("#target-label")).toContainText("<img>");
    await expect(page.locator("#target-label img")).toHaveCount(0);
    expect(await page.evaluate(() => window.__htmlviewXss)).toBeUndefined();

    await page.locator("#comment").fill("Forged target note");
    await page.getByRole("button", { name: "Add draft" }).click();
    await expect(page.locator(".draft")).toHaveCount(2);
    await page.getByRole("button", { name: "Send selected" }).click();
    await expect(page.locator("#live")).toHaveText("2 drafts sent");
    const delivered = await command(environment, "feedback", opened.review.id);
    expect(delivered.feedback).toMatchObject([
      { kind: "freeform", comment: secret },
      {
        kind: "element",
        comment: "Forged target note",
        anchor: {
          selector: '<img src=x onerror="window.__htmlviewXss=true">',
          dom_path: "html[0]/body[0]",
          tag: "<img>",
          text: "<script>window.__htmlviewXss=true</script>",
        },
      },
    ]);
    expect(await page.evaluate(() => window.__htmlviewXss)).toBeUndefined();

    await page.evaluate(() => {
      window.postMessage(
        {
          channel: "htmlview.review",
          version: 1,
          type: "target_selected",
          handle: "wrong-source",
          anchor: {
            selector: "body",
            dom_path: "html[0]/body[0]",
            tag: "body",
          },
          rect: { x: 0, y: 0, width: 10, height: 10 },
        },
        "*",
      );
    });
    await expect(page.locator("#editor")).toBeHidden();
  } finally {
    await execute(process.execPath, [cli, "stop", "--all", "--json"], {
      env: environment,
    }).catch(() => undefined);
    await rm(stateParent, { recursive: true, force: true });
  }
});

test("explicit instrumentation limitations preserve the raw page", async ({
  page,
}) => {
  const stateParent = await mkdtemp(path.join(tmpdir(), "hv-review-limits-"));
  const environment = {
    ...process.env,
    HTMLVIEW_STATE_DIR: path.join(stateParent, "state"),
    HTMLVIEW_IDLE_MS: "10000",
  };
  delete environment.NO_COLOR;
  delete environment.FORCE_COLOR;
  try {
    for (const [filename, reason] of [
      ["csp-blocked.html", "csp blocked"],
      ["unsupported-encoding.html", "unsupported encoding"],
      ["unsupported-markup.html", "unsupported markup"],
    ]) {
      const selected = path.join(fixtureRoot, "pages", filename);
      const served = await command(
        environment,
        "serve",
        selected,
        "--root",
        fixtureRoot,
      );
      const rawBefore = Buffer.from(
        await fetch(served.session.url).then((response) =>
          response.arrayBuffer(),
        ),
      );
      const opened = await command(environment, "review", served.session.id);
      await page.goto(opened.review.url);
      await expect(page.locator("#limitation")).toHaveText(
        `This page cannot be annotated: ${reason}. The raw page remains available.`,
      );
      await expect(
        page.getByRole("button", { name: "Annotate" }),
      ).toBeDisabled();
      await expect(
        page.getByRole("button", { name: "Page note" }),
      ).toBeDisabled();
      const rawAfter = Buffer.from(
        await fetch(served.session.url).then((response) =>
          response.arrayBuffer(),
        ),
      );
      expect(Buffer.compare(rawBefore, rawAfter)).toBe(0);
    }
  } finally {
    await execute(process.execPath, [cli, "stop", "--all", "--json"], {
      env: environment,
    }).catch(() => undefined);
    await rm(stateParent, { recursive: true, force: true });
  }
});

test("Annotate isolates native controls while Explore permits navigation", async ({
  page,
}) => {
  const stateParent = await mkdtemp(path.join(tmpdir(), "hv-review-controls-"));
  const environment = {
    ...process.env,
    HTMLVIEW_STATE_DIR: path.join(stateParent, "state"),
    HTMLVIEW_IDLE_MS: "10000",
  };
  delete environment.NO_COLOR;
  delete environment.FORCE_COLOR;
  let delayNextState = false;
  let releaseState;
  let stateInterceptedResolve;
  let stateCompletedResolve;
  let stateIntercepted;
  let stateCompleted;
  await page.route("**/.htmlview/api/state", async (route) => {
    if (!delayNextState) {
      await route.continue();
      return;
    }
    delayNextState = false;
    stateInterceptedResolve();
    await new Promise((resolve) => {
      releaseState = resolve;
    });
    await route.continue();
    stateCompletedResolve();
  });
  try {
    const served = await command(
      environment,
      "serve",
      controlsEntryPath,
      "--root",
      fixtureRoot,
    );
    const opened = await command(environment, "review", served.session.id);
    await page.goto(opened.review.url);
    const shellUrl = page.url();
    const content = page.frameLocator("#content");
    await expect(content.locator("#controls-title")).toHaveText(
      "Review controls fixture",
    );
    await expect(page.locator("#live")).toHaveText("Annotation tools ready");
    await expect(content.locator("#frame-bust")).toHaveText("SecurityError");
    expect(page.url()).toBe(shellUrl);

    const counter = content.locator("#counter");
    await counter.click();
    await expect(page.locator("#editor")).toBeVisible();
    await expect(content.locator("#counter-value")).toHaveText("0");
    await page.getByRole("button", { name: "Cancel" }).click();

    await counter.focus();
    await counter.press("Enter");
    await expect(page.locator("#editor")).toBeVisible();
    await expect(content.locator("#counter-value")).toHaveText("0");
    await page.getByRole("button", { name: "Cancel" }).click();

    await counter.focus();
    await counter.press("Space");
    await expect(page.locator("#editor")).toBeVisible();
    await expect(content.locator("#counter-value")).toHaveText("0");
    await page.locator("#comment").fill("Keep the visible button label");
    await page.getByRole("button", { name: "Add draft" }).click();

    const checkbox = content.locator("#enabled");
    await checkbox.click();
    await expect(page.locator("#editor")).toBeVisible();
    await expect(checkbox).not.toBeChecked();
    await page.getByRole("button", { name: "Cancel" }).click();

    await page.getByRole("button", { name: "Explore" }).click();
    await counter.click();
    await expect(content.locator("#counter-value")).toHaveText("1");
    await checkbox.click();
    await expect(checkbox).toBeChecked();
    await content.locator("#field").fill("changed in Explore");
    await expect(content.locator("#field")).toHaveValue("changed in Explore");

    await content.locator("#navigate").click();
    await expect(content.locator("#navigated-title")).toHaveText(
      "Navigated document",
    );
    await expect(page.locator("#limitation")).toHaveText(
      "This page cannot be annotated: unsupported navigation. The raw page remains available.",
    );
    await expect(page.getByRole("button", { name: "Annotate" })).toBeDisabled();
    await expect(
      page.getByRole("button", { name: "Page note" }),
    ).toBeDisabled();
    expect(page.url()).toBe(shellUrl);

    await content.locator("body").evaluate(() => {
      location.href = "/pages/controls.html";
    });
    await expect(content.locator("#controls-title")).toHaveText(
      "Review controls fixture",
    );
    await expect(page.locator("#live")).toHaveText("Annotation tools ready");
    await expect(page.locator("#limitation")).toBeHidden();
    await expect(page.getByRole("button", { name: "Annotate" })).toBeEnabled();

    stateIntercepted = new Promise((resolve) => {
      stateInterceptedResolve = resolve;
    });
    stateCompleted = new Promise((resolve) => {
      stateCompletedResolve = resolve;
    });
    delayNextState = true;
    await page.getByRole("button", { name: "Explore" }).click();
    await content.locator("#navigate").click();
    await expect(content.locator("#navigated-title")).toHaveText(
      "Navigated document",
    );
    await stateIntercepted;
    await content.locator("body").evaluate(() => {
      location.href = "/pages/controls.html";
    });
    await expect(content.locator("#controls-title")).toHaveText(
      "Review controls fixture",
    );
    await expect(page.locator("#live")).toHaveText("Annotation tools ready");
    await page.waitForTimeout(2_200);
    releaseState();
    await stateCompleted;
    await page.waitForTimeout(100);
    await expect(page.locator("#limitation")).toBeHidden();
    await expect(page.getByRole("button", { name: "Annotate" })).toBeEnabled();
    await expect(page.getByRole("button", { name: "Page note" })).toBeEnabled();

    await page.getByRole("button", { name: "Send selected" }).click();
    const delivered = await command(environment, "feedback", opened.review.id);
    expect(delivered.feedback).toMatchObject([
      {
        kind: "element",
        comment: "Keep the visible button label",
        anchor: { selector: "#counter", tag: "button", text: "Save changes" },
      },
    ]);
    expect(JSON.stringify(delivered.feedback[0].anchor)).not.toContain(
      "private form value",
    );
  } finally {
    await execute(process.execPath, [cli, "stop", "--all", "--json"], {
      env: environment,
    }).catch(() => undefined);
    await rm(stateParent, { recursive: true, force: true });
  }
});

test("source reloads preserve drafts with their original revisions", async ({
  page,
}) => {
  const parent = await mkdtemp(path.join(tmpdir(), "hv-review-revisions-"));
  const root = path.join(parent, "root");
  const entry = path.join(root, "index.html");
  const environment = {
    ...process.env,
    HTMLVIEW_STATE_DIR: path.join(parent, "state"),
    HTMLVIEW_IDLE_MS: "10000",
  };
  delete environment.NO_COLOR;
  delete environment.FORCE_COLOR;
  try {
    await mkdir(root);
    await writeFile(
      entry,
      '<!doctype html><html><body><h1 id="target">First revision</h1></body></html>',
    );
    const served = await command(environment, "serve", entry, "--root", root);
    const opened = await command(environment, "review", served.session.id);
    await page.goto(opened.review.url);
    const content = page.frameLocator("#content");
    await expect(page.locator("#live")).toHaveText("Annotation tools ready");
    await page.getByRole("button", { name: "Page note" }).click();
    await page.locator("#comment").fill("Draft from the first revision");
    await page.getByRole("button", { name: "Add draft" }).click();

    await writeFile(
      entry,
      '<!doctype html><html><body><h1 id="target">Second revision</h1></body></html>',
    );
    await content.locator("body").evaluate(() => location.reload());
    await expect(content.locator("#target")).toHaveText("Second revision");
    await expect(page.locator("#live")).toHaveText("Annotation tools ready");
    await page.getByRole("button", { name: "Page note" }).click();
    await page.locator("#comment").fill("Draft from the second revision");
    await page.getByRole("button", { name: "Add draft" }).click();
    await expect(page.locator(".draft")).toHaveCount(2);
    await page.getByRole("button", { name: "Send selected" }).click();

    const delivered = await command(environment, "feedback", opened.review.id);
    expect(delivered.feedback.map(({ comment }) => comment)).toEqual([
      "Draft from the first revision",
      "Draft from the second revision",
    ]);
    expect(delivered.feedback[0].revision).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(delivered.feedback[1].revision).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(delivered.feedback[0].revision).not.toBe(
      delivered.feedback[1].revision,
    );
  } finally {
    await execute(process.execPath, [cli, "stop", "--all", "--json"], {
      env: environment,
    }).catch(() => undefined);
    await rm(parent, { recursive: true, force: true });
  }
});
