import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { expect, test } from "@playwright/test";
import { entryPath, fixtureRoot, listenFixture } from "./fixture.mjs";

const execute = promisify(execFile);
const cli = path.resolve("dist/cli.js");
const baseEntryPath = path.join(fixtureRoot, "pages", "base.html");
const controlsEntryPath = path.join(fixtureRoot, "pages", "controls.html");
const preloadNavigationEntryPath = path.join(
  fixtureRoot,
  "pages",
  "preload-navigation.html",
);

async function command(environment, ...args) {
  const result = await execute(process.execPath, [cli, ...args, "--json"], {
    env: environment,
  });
  expect(result.stderr).toBe("");
  return JSON.parse(result.stdout);
}

async function reloadReviewFrame(page) {
  await page.locator("#content").evaluate(async (iframe) => {
    const response = await fetch("/.htmlview/api/navigation", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    const navigation = await response.json();
    iframe.src = navigation.navigation_url;
  });
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
    let entryPollRequests = 0;
    page.on("request", (request) => {
      if (request.url().endsWith("/.htmlview/api/entry"))
        entryPollRequests += 1;
    });

    await page.goto(opened.review.url);
    const content = page.frameLocator("#content");
    await expect(page.locator("#content")).toHaveAttribute(
      "sandbox",
      "allow-scripts allow-same-origin",
    );
    await expect(content.locator("#title")).toHaveText("fixture");
    expect(
      await content.locator("body").evaluate(() => ({
        pathname: window.location.pathname,
        search: window.location.search,
      })),
    ).toEqual({
      pathname: "/pages/report%20space%20%C3%BC.html",
      search: "",
    });
    await expect(page.locator("#review-status")).toHaveText(
      "Annotation review",
    );
    await expect(page.locator("#live")).toHaveText("Annotation tools ready");

    await page.setViewportSize({ width: 700, height: 800 });
    await expect(page.locator("#drafts")).toHaveAttribute("data-open", "true");
    await expect(page.locator("#draft-toggle")).toHaveAttribute(
      "aria-expanded",
      "true",
    );
    await page.locator("#draft-toggle").click();
    await expect(page.locator("#drafts")).toHaveAttribute("data-open", "false");
    await expect(page.locator("#draft-toggle")).toHaveAttribute(
      "aria-expanded",
      "false",
    );
    await expect
      .poll(() =>
        page.locator("#drafts").evaluate((panel) => {
          const transform = new DOMMatrix(getComputedStyle(panel).transform);
          return transform.m42;
        }),
      )
      .toBeGreaterThan(0);
    await page.locator("#draft-toggle").click();
    await expect(page.locator("#drafts")).toHaveAttribute("data-open", "true");
    await expect
      .poll(() =>
        page.locator("#drafts").evaluate((panel) => {
          const transform = new DOMMatrix(getComputedStyle(panel).transform);
          return transform.m42;
        }),
      )
      .toBe(0);
    await page.setViewportSize({ width: 1280, height: 720 });

    await content.locator("#title").click();
    await expect(page.locator("#editor")).toBeVisible();
    await reloadReviewFrame(page);
    await expect(page.locator("#editor")).toBeHidden();
    await expect(content.locator("#title")).toHaveText("fixture");
    await expect(page.locator("#live")).toHaveText("Annotation tools ready");
    await content.locator("#title").click();
    await expect(page.locator("#target-label")).toHaveText(
      "h1 · untrusted page context",
    );
    await page.locator("#comment").fill("Make the fixture title clearer");
    await page.getByRole("button", { name: "Add draft" }).click();
    await expect(page.locator(".draft")).toHaveCount(1);
    await page.getByRole("button", { name: "Page note" }).click();
    await page.locator("#comment").fill("Add a short source note");
    await expect(page.locator("#editor")).toBeVisible();
    await expect(page.locator("#comment")).toHaveValue(
      "Add a short source note",
    );
    await expect(page.getByRole("button", { name: "Add draft" })).toBeEnabled();
    await page.getByRole("button", { name: "Add draft" }).click();
    await expect(page.locator(".draft")).toHaveCount(2);
    await page.locator('.draft input[type="checkbox"]').first().uncheck();

    await content.locator("body").evaluate((body) => {
      body.tabIndex = -1;
    });
    await content.locator("body").focus();
    await content.locator("body").press("Enter");
    await expect(page.locator("#target-label")).toHaveText(
      "body · untrusted page context",
    );
    await page.locator("#comment").fill("Review the whole page");
    await page.getByRole("button", { name: "Add draft" }).click();
    await expect(page.locator(".draft")).toHaveCount(3);
    await expect(
      page.locator('.draft input[type="checkbox"]').first(),
    ).not.toBeChecked();
    await expect(
      page.locator('.draft input[type="checkbox"]').nth(2),
    ).toBeChecked();
    await expect(content.locator("body")).not.toContainText(
      "Make the fixture title clearer",
    );

    await page.getByRole("button", { name: "Send selected" }).click();
    await expect(page.locator("#live")).toHaveText("2 drafts sent");
    await expect(page.locator(".draft")).toHaveCount(1);
    await expect(page.locator(".draft p")).toHaveText(
      "Make the fixture title clearer",
    );
    await page.locator('.draft input[type="checkbox"]').check();
    await page.getByRole("button", { name: "Send selected" }).click();
    await expect(page.locator("#live")).toHaveText("1 draft sent");
    await expect(page.locator(".draft")).toHaveCount(0);

    const delivered = await command(environment, "feedback", opened.review.id);
    expect(delivered.count).toBe(3);
    expect(delivered.feedback).toMatchObject([
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
      {
        kind: "element",
        comment: "Make the fixture title clearer",
        entry: "/pages/report%20space%20%C3%BC.html",
        anchor: { selector: "#title", tag: "h1", text: "fixture" },
      },
    ]);
    expect(delivered.feedback[1].anchor.text).not.toContain(
      "INLINE_SCRIPT_CANARY_MUST_NOT_PERSIST",
    );
    expect(delivered.feedback[1].anchor.text).toContain(
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
      expect(JSON.stringify(delivered.feedback[1].anchor)).not.toContain(
        excluded,
      );

    for (const [index, comment] of [
      "Keep this final note",
      "Discard this draft",
    ].entries()) {
      await page.getByRole("button", { name: "Page note" }).click();
      await page.locator("#comment").fill(comment);
      await page.getByRole("button", { name: "Add draft" }).click();
      await expect(page.locator(".draft")).toHaveCount(index + 1);
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
    const requestsAfterEnd = entryPollRequests;
    await page.waitForTimeout(1_200);
    expect(entryPollRequests).toBe(requestsAfterEnd);

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

test("a foreign iframe cannot trigger review instrumentation", async ({
  page,
}) => {
  const stateParent = await mkdtemp(path.join(tmpdir(), "hv-review-foreign-"));
  const environment = {
    ...process.env,
    HTMLVIEW_STATE_DIR: path.join(stateParent, "state"),
    HTMLVIEW_IDLE_MS: "10000",
  };
  delete environment.NO_COLOR;
  delete environment.FORCE_COLOR;
  const foreign = await listenFixture({
    urlHost: "attacker-htmlview.localhost",
    label: "attacker",
  });
  try {
    const served = await command(
      environment,
      "serve",
      entryPath,
      "--root",
      fixtureRoot,
    );
    const opened = await command(environment, "review", served.session.id);
    await page.goto(opened.review.url);
    await expect(page.locator("#live")).toHaveText("Annotation tools ready");
    const contentUrl = await page.evaluate(() =>
      fetch("/.htmlview/api/state").then(
        async (response) => (await response.json()).content_url,
      ),
    );

    await page.goto(`${foreign.origin}/state.html`);
    const responsePromise = page.waitForResponse(
      (response) => response.url() === contentUrl,
    );
    await page.evaluate((url) => {
      const iframe = document.createElement("iframe");
      iframe.src = url;
      document.body.append(iframe);
    }, contentUrl);
    const response = await responsePromise;
    expect(response.status()).toBe(200);
    expect(await response.text()).not.toContain("/.htmlview/probe/");
  } finally {
    await execute(process.execPath, [cli, "stop", "--all", "--json"], {
      env: environment,
    }).catch(() => undefined);
    await foreign.close();
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
      window.__anchorWalks = 0;
      window.__originalCreateTreeWalker =
        document.createTreeWalker.bind(document);
      document.createTreeWalker = (...arguments_) => {
        window.__anchorWalks += 1;
        return window.__originalCreateTreeWalker(...arguments_);
      };
      const target = document.createElement("div");
      target.id = "large-preview-target";
      target.textContent = "Large preview target";
      for (let index = 0; index < 5_000; index += 1)
        target.append(document.createElement("span"));
      document.body.prepend(target);
    });

    await content.locator("#large-preview-target").hover();
    await page.waitForTimeout(50);
    expect(
      await content.locator("body").evaluate(() => window.__anchorWalks),
    ).toBe(0);
    await content.locator("#large-preview-target").click();
    await expect(page.locator("#editor")).toBeVisible();
    expect(
      await content.locator("body").evaluate(() => window.__anchorWalks),
    ).toBe(1);
    await page.getByRole("button", { name: "Cancel" }).click();
    await content.locator("body").evaluate(() => {
      document.createTreeWalker = window.__originalCreateTreeWalker;
      document.querySelector("#large-preview-target")?.remove();
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
    await expect(page.locator("#live")).toHaveText(
      "Save or cancel the current comment before exploring",
    );
    await page.getByRole("button", { name: "Cancel" }).click();
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
          version: 2,
          type: "set_mode",
          mode: "explore",
        },
        {
          channel: "htmlview.review",
          version: 2,
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
        version: 2,
        type: "target_selected",
        lease: "0".repeat(32),
        revision: `sha256:${"0".repeat(64)}`,
        handle: "invalid-target",
        anchor: {
          selector: "body",
          dom_path: "html[0]/body[0]",
          tag: "body",
        },
        rect: { x: 0, y: 0, width: 10, height: 10 },
      };
      for (const value of [
        { ...base, version: 3 },
        { ...base, extra: "rejected" },
        { ...base, handle: "x".repeat(65) },
        { ...base, rect: { ...base.rect, width: -1 } },
      ])
        window.parent.postMessage(value, "*");
    });
    await expect(page.locator("#editor")).toBeHidden();

    await content.locator("#title").click();
    await expect(page.locator("#editor")).toBeVisible();
    await expect(page.locator("#target-label")).toContainText("h1");
    await page.locator("#comment").fill("Protected target note");
    await expect(page.locator("#comment")).toBeFocused();

    await content.locator("body").evaluate(() => {
      const lease = "f".repeat(32);
      const revision = `sha256:${"f".repeat(64)}`;
      const selected = {
        channel: "htmlview.review",
        version: 2,
        type: "target_selected",
        lease,
        revision,
        handle: "forged-target",
        anchor: {
          selector: '<img src=x onerror="window.__htmlviewXss=true">',
          dom_path: "html[0]/body[0]",
          tag: "<img>",
          text: "<script>window.__htmlviewXss=true</script>",
        },
        rect: { x: 0, y: 0, width: 10, height: 10 },
      };
      for (let index = 0; index < 2_000; index += 1) {
        window.parent.postMessage(selected, "*");
        window.parent.postMessage(
          {
            channel: "htmlview.review",
            version: 2,
            type: "target_preview",
            lease,
            revision,
            handle: "forged-target",
            rect: selected.rect,
          },
          "*",
        );
        window.parent.postMessage(
          {
            channel: "htmlview.review",
            version: 2,
            type: "target_cleared",
            lease,
            revision,
          },
          "*",
        );
      }
      window.parent.postMessage(
        {
          channel: "htmlview.review",
          version: 2,
          type: "target_selected",
          lease,
          revision,
          handle: "forged-target",
          anchor: {
            selector: "x".repeat(1024 * 1024),
            dom_path: "html[0]/body[0]",
            tag: "body",
          },
          rect: { x: 0, y: 0, width: 10, height: 10 },
        },
        "*",
      );
    });
    await expect(page.locator("#comment")).toHaveValue("Protected target note");
    await expect(page.locator("#comment")).toBeFocused();
    await expect(page.locator("#target-label")).toContainText("h1");
    await expect(page.locator("#target-label img")).toHaveCount(0);
    expect(await page.evaluate(() => window.__htmlviewXss)).toBeUndefined();

    await page.getByRole("button", { name: "Add draft" }).click();
    await expect(page.locator(".draft")).toHaveCount(2);
    await page.getByRole("button", { name: "Send selected" }).click();
    await expect(page.locator("#live")).toHaveText("2 drafts sent");
    const delivered = await command(environment, "feedback", opened.review.id);
    expect(delivered.feedback).toMatchObject([
      { kind: "freeform", comment: secret },
      {
        kind: "element",
        comment: "Protected target note",
        anchor: {
          tag: "h1",
        },
      },
    ]);
    expect(await page.evaluate(() => window.__htmlviewXss)).toBeUndefined();

    let draftRequests = 0;
    let draftStartedResolve;
    let releaseDraft;
    const draftStarted = new Promise((resolve) => {
      draftStartedResolve = resolve;
    });
    const draftGate = new Promise((resolve) => {
      releaseDraft = resolve;
    });
    await page.route("**/.htmlview/api/drafts", async (route) => {
      draftRequests += 1;
      draftStartedResolve();
      await draftGate;
      await route.continue();
    });
    await page.getByRole("button", { name: "Page note" }).click();
    await page.locator("#comment").fill("Single-flight shortcut note");
    await page.locator("#comment").press("Control+Enter");
    await draftStarted;
    await page.locator("#comment").press("Control+Enter");
    await page.locator("#comment").press("Escape");
    await expect(page.locator("#editor")).toBeVisible();
    await expect(page.locator("#comment")).toHaveValue(
      "Single-flight shortcut note",
    );
    await expect(
      page.getByRole("button", { name: "Page note" }),
    ).toBeDisabled();
    await expect(page.getByRole("button", { name: "Explore" })).toBeDisabled();
    await expect(
      page.getByRole("button", { name: "Send & end" }),
    ).toBeDisabled();
    await expect(page.locator("#live")).toHaveText(
      "Wait for the current draft save to finish",
    );
    await expect(page.locator("#review-status")).toHaveText(
      "Annotation review",
    );
    releaseDraft();
    await expect(page.locator(".draft")).toHaveCount(1);
    expect(draftRequests).toBe(1);
    await page.unroute("**/.htmlview/api/drafts");

    await page.route("**/.htmlview/api/state", (route) => route.abort());
    await page.getByRole("button", { name: "Page note" }).click();
    await page.locator("#comment").fill("Committed before refresh failure");
    await page.getByRole("button", { name: "Add draft" }).click();
    await expect(page.locator("#editor")).toBeHidden();
    await expect(page.locator("#live")).toHaveText(
      "Draft saved privately; the draft list could not be refreshed",
    );
    await expect(page.locator(".draft")).toHaveCount(2);
    await page.unroute("**/.htmlview/api/state");
    const committedDrafts = await page.evaluate(() =>
      fetch("/.htmlview/api/state")
        .then((response) => response.json())
        .then((state) => state.drafts),
    );
    expect(
      committedDrafts.filter(
        (draft) => draft.comment === "Committed before refresh failure",
      ),
    ).toHaveLength(1);

    await page.getByRole("button", { name: "Page note" }).click();
    await page.locator("#comment").fill("Unsaved end guard");
    await page.getByRole("button", { name: "Send & end" }).click();
    await expect(page.locator("#live")).toHaveText(
      "Save or cancel the current comment before ending the review",
    );
    await expect(page.locator("#editor")).toBeVisible();
    await page.getByRole("button", { name: "Cancel" }).click();

    await content.locator("#title").evaluate((title) => {
      title.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await expect(page.locator("#editor")).toBeHidden();

    await page.evaluate(() => {
      window.postMessage(
        {
          channel: "htmlview.review",
          version: 2,
          type: "target_selected",
          lease: "0".repeat(32),
          revision: `sha256:${"0".repeat(64)}`,
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

    const compatible = path.join(fixtureRoot, "pages", "csp-upgrade.html");
    const served = await command(
      environment,
      "serve",
      compatible,
      "--root",
      fixtureRoot,
    );
    const opened = await command(environment, "review", served.session.id);
    await page.goto(opened.review.url);
    await expect(page.locator("#live")).toHaveText("Annotation tools ready");
    await expect(
      page.frameLocator("#content").locator("#csp-upgrade-title"),
    ).toHaveText("Potentially trustworthy localhost probe");
  } finally {
    await execute(process.execPath, [cli, "stop", "--all", "--json"], {
      env: environment,
    }).catch(() => undefined);
    await rm(stateParent, { recursive: true, force: true });
  }
});

test("networkless document replacement cannot forge probe readiness", async ({
  page,
}) => {
  const stateParent = await mkdtemp(path.join(tmpdir(), "hv-review-preload-"));
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
      preloadNavigationEntryPath,
      "--root",
      fixtureRoot,
    );
    const opened = await command(environment, "review", served.session.id);
    await page.goto(opened.review.url);
    const content = page.frameLocator("#content");
    await expect(content.locator("#replacement")).toHaveText(
      "Replaced before entry load",
    );
    await expect(content.locator("#shadowed")).toHaveText("shadowed");
    await expect(content.locator("#captured")).toHaveText("isolated");
    await expect(page.locator("#limitation")).toHaveText(
      "This page cannot be annotated: instrumentation unavailable. The raw page remains available.",
    );
    await expect(page.getByRole("button", { name: "Annotate" })).toBeDisabled();
    await expect(
      page.getByRole("button", { name: "Page note" }),
    ).toBeDisabled();
  } finally {
    await execute(process.execPath, [cli, "stop", "--all", "--json"], {
      env: environment,
    }).catch(() => undefined);
    await rm(stateParent, { recursive: true, force: true });
  }
});

test("an initially unsupported entry automatically recovers", async ({
  page,
}) => {
  const parent = await mkdtemp(path.join(tmpdir(), "hv-review-recovery-"));
  const root = path.join(parent, "root");
  const entry = path.join(root, "index.html");
  const supported =
    '<!doctype html><html><body><h1 id="target">Recovered</h1></body></html>';
  const environment = {
    ...process.env,
    HTMLVIEW_STATE_DIR: path.join(parent, "state"),
    HTMLVIEW_IDLE_MS: "10000",
  };
  delete environment.NO_COLOR;
  delete environment.FORCE_COLOR;
  const navigationStatuses = [];
  page.on("response", (response) => {
    if (response.url().includes("__htmlview_navigation="))
      navigationStatuses.push(response.status());
  });
  try {
    await mkdir(root);
    await writeFile(entry, Buffer.alloc(8 * 1024 * 1024 + 1, 0x20));
    const served = await command(environment, "serve", entry, "--root", root);
    const opened = await command(environment, "review", served.session.id);
    await page.goto(opened.review.url);
    await expect(page.locator("#limitation")).toContainText("entry too large");
    let navigationRequests = 0;
    await page.route("**/.htmlview/api/navigation", async (route) => {
      navigationRequests += 1;
      if (navigationRequests === 1) await route.abort();
      else await route.continue();
    });
    await writeFile(entry, supported);
    await expect
      .poll(() =>
        page.evaluate(() =>
          fetch("/.htmlview/api/entry").then((response) => response.json()),
        ),
      )
      .toMatchObject({ entry: { availability: "available" } });
    await expect
      .poll(() => navigationStatuses.length)
      .toBeGreaterThanOrEqual(2);
    expect(navigationRequests).toBeGreaterThanOrEqual(2);
    expect(navigationStatuses.at(-1)).toBe(200);
    await expect(page.frameLocator("#content").locator("#target")).toHaveText(
      "Recovered",
    );
    await expect(page.locator("#live")).toHaveText("Annotation tools ready");
    await expect(page.locator("#limitation")).toBeHidden();
  } finally {
    await execute(process.execPath, [cli, "stop", "--all", "--json"], {
      env: environment,
    }).catch(() => undefined);
    await rm(parent, { recursive: true, force: true });
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
    const response = await route.fetch();
    const staleState = await response.json();
    stateInterceptedResolve();
    await new Promise((resolve) => {
      releaseState = resolve;
    });
    await route.fulfill({
      response,
      json: { ...staleState, limitation: "csp_blocked" },
    });
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
    expect(
      await content
        .locator("body")
        .evaluate(() => window.__parentPostMessagePatch),
    ).toBe("SecurityError");
    const probeIdentity = await content.locator("body").evaluate(async () => ({
      revision: document.querySelector("script[data-htmlview-revision]")
        ?.dataset.htmlviewRevision,
      race: await window.__probeRace,
    }));
    expect(probeIdentity.revision).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(probeIdentity.race).toEqual({ status: 404, body: "Not Found" });
    expect(
      await content.locator("body").evaluate(() => window.__nestedProbe),
    ).toBe(false);
    const serviceWorker = await content.locator("body").evaluate(() =>
      navigator.serviceWorker
        .register("/pages/module%20%C3%BC.js", {
          type: "module",
        })
        .then(
          () => "registered",
          (error) => error.name,
        ),
    );
    expect(serviceWorker).not.toBe("registered");

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

    const field = content.locator("#field");
    await field.focus();
    await field.press("x");
    await expect(field).toHaveValue("private form value");
    expect(await field.evaluate(() => window.__fieldKeyEvents)).toEqual({
      keydown: 0,
      keyup: 0,
    });

    await page.getByRole("button", { name: "Explore" }).click();
    await counter.click();
    await expect(content.locator("#counter-value")).toHaveText("1");
    await checkbox.click();
    await expect(checkbox).toBeChecked();
    await field.fill("changed in Explore");
    await expect(field).toHaveValue("changed in Explore");

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
    const fetchedEntry = await content
      .locator("body")
      .evaluate(async () =>
        fetch("/pages/controls.html").then((response) => response.text()),
      );
    expect(fetchedEntry).not.toContain("data-htmlview-revision");
    await content.locator("body").evaluate((_, revision) => {
      window.parent.postMessage(
        {
          channel: "htmlview.review",
          version: 1,
          type: "probe_ready",
          lease: "0".repeat(32),
          revision,
        },
        "*",
      );
    }, probeIdentity.revision);
    await page.waitForTimeout(100);
    await expect(page.locator("#limitation")).toHaveText(
      "This page cannot be annotated: unsupported navigation. The raw page remains available.",
    );
    await expect(page.getByRole("button", { name: "Annotate" })).toBeDisabled();
    await expect(
      page.getByRole("button", { name: "Page note" }),
    ).toBeDisabled();

    await reloadReviewFrame(page);
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
    await reloadReviewFrame(page);
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
    await content.locator("#target").click();
    await expect(page.locator("#editor")).toBeVisible();
    await page.locator("#comment").fill("Unsaved context from the old DOM");

    await writeFile(
      entry,
      '<!doctype html><html><body><h1 id="target">Second revision</h1></body></html>',
    );
    await expect(content.locator("#target")).toHaveText("Second revision");
    await expect(page.locator("#live")).toHaveText("Annotation tools ready");
    await expect(page.locator("#editor")).toBeHidden();
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

test("automatic refresh binds navigation to the confirmed entry revision", async ({
  page,
}) => {
  const parent = await mkdtemp(
    path.join(tmpdir(), "hv-review-bound-revision-"),
  );
  const root = path.join(parent, "root");
  const entry = path.join(root, "index.html");
  const initial =
    '<!doctype html><html><body><h1 id="target">Initial</h1></body></html>';
  const expected =
    '<!doctype html><html><body><h1 id="target">Expected</h1></body></html>';
  const transient =
    '<!doctype html><html><body><h1 id="target">Transient</h1></body></html>';
  const expectedRevision = `sha256:${createHash("sha256").update(expected).digest("hex")}`;
  const environment = {
    ...process.env,
    HTMLVIEW_STATE_DIR: path.join(parent, "state"),
    HTMLVIEW_IDLE_MS: "10000",
  };
  delete environment.NO_COLOR;
  delete environment.FORCE_COLOR;
  try {
    await mkdir(root);
    await writeFile(entry, initial);
    const served = await command(environment, "serve", entry, "--root", root);
    const opened = await command(environment, "review", served.session.id);
    await page.goto(opened.review.url);
    const content = page.frameLocator("#content");
    await expect(page.locator("#live")).toHaveText("Annotation tools ready");

    let automaticNavigationRequests = 0;
    await page.route("**/.htmlview/api/navigation", async (route) => {
      automaticNavigationRequests += 1;
      expect(JSON.parse(route.request().postData() ?? "null")).toEqual({
        expected_revision: expectedRevision,
      });
      await route.continue();
    });
    let racedNavigation = false;
    let restoreExpected;
    let rejectObserved;
    let allowRestore;
    const expectedRestored = new Promise((resolve) => {
      restoreExpected = resolve;
    });
    const rejectedNavigation = new Promise((resolve) => {
      rejectObserved = resolve;
    });
    const restoreAllowed = new Promise((resolve) => {
      allowRestore = resolve;
    });
    const navigationStatuses = [];
    page.on("response", async (response) => {
      if (response.url().includes("__htmlview_navigation=")) {
        navigationStatuses.push(response.status());
        if (response.status() === 409 && restoreExpected !== undefined) {
          rejectObserved();
          await restoreAllowed;
          const restore = restoreExpected;
          restoreExpected = undefined;
          await writeFile(entry, expected);
          restore();
        }
      }
    });
    await page.route("**/*__htmlview_navigation=*", async (route) => {
      if (racedNavigation) {
        await route.continue();
        return;
      }
      racedNavigation = true;
      await writeFile(entry, transient);
      await route.continue();
    });

    await writeFile(entry, expected);
    await expect.poll(() => racedNavigation).toBe(true);
    await rejectedNavigation;
    await expect(content.locator("#target")).toHaveText("Initial");
    await expect(page.getByRole("button", { name: "Annotate" })).toBeDisabled();
    allowRestore();
    await expectedRestored;
    await expect(content.locator("#target")).toHaveText("Expected");
    await expect(page.locator("#live")).toHaveText("Annotation tools ready");
    await expect(page.locator("#limitation")).toBeHidden();
    expect(automaticNavigationRequests).toBeGreaterThanOrEqual(2);
    expect(navigationStatuses).toContain(409);
    expect(navigationStatuses.at(-1)).toBe(200);
    await expect(content.locator("body")).not.toContainText("Transient");
  } finally {
    await execute(process.execPath, [cli, "stop", "--all", "--json"], {
      env: environment,
    }).catch(() => undefined);
    await rm(parent, { recursive: true, force: true });
  }
});

test("failed refresh recovery keeps the rendered revision and retries restored bytes", async ({
  page,
}) => {
  test.setTimeout(45_000);
  const parent = await mkdtemp(path.join(tmpdir(), "hv-review-recovery-"));
  const root = path.join(parent, "root");
  const entry = path.join(root, "index.html");
  const moved = path.join(root, "index.moved.html");
  const initial =
    '<!doctype html><html><body><h1 id="target">Initial</h1></body></html>';
  const updated =
    '<!doctype html><html><body><h1 id="target">Updated</h1></body></html>';
  const delayed =
    '<!doctype html><html><body><h1 id="target">Delayed</h1></body></html>';
  const recovered =
    '<!doctype html><html><body><h1 id="target">Recovered</h1></body></html>';
  const environment = {
    ...process.env,
    HTMLVIEW_STATE_DIR: path.join(parent, "state"),
    HTMLVIEW_IDLE_MS: "10000",
  };
  delete environment.NO_COLOR;
  delete environment.FORCE_COLOR;
  try {
    await mkdir(root);
    await writeFile(entry, initial);
    const served = await command(environment, "serve", entry, "--root", root);
    const opened = await command(environment, "review", served.session.id);
    await page.goto(opened.review.url);
    const content = page.frameLocator("#content");
    await expect(page.locator("#live")).toHaveText("Annotation tools ready");
    await page.locator("#content").evaluate((iframe) => {
      window.__htmlviewActiveFrame = iframe;
    });

    let navigationMode = "exhaust";
    let navigationRequests = 0;
    let heldNavigationResolve;
    let releaseHeldNavigation;
    const heldNavigation = new Promise((resolve) => {
      heldNavigationResolve = resolve;
    });
    const heldNavigationRelease = new Promise((resolve) => {
      releaseHeldNavigation = resolve;
    });
    await page.route("**/.htmlview/api/navigation", async (route) => {
      navigationRequests += 1;
      if (navigationMode === "exhaust") {
        await route.abort();
        return;
      }
      if (navigationMode === "hold") {
        heldNavigationResolve();
        await heldNavigationRelease;
        await route.abort();
        return;
      }
      await route.continue();
    });

    await writeFile(entry, updated);
    await expect.poll(() => navigationRequests).toBeGreaterThanOrEqual(3);
    await expect(page.locator("#limitation")).toContainText(
      "instrumentation unavailable",
    );
    await expect(content.locator("#target")).toHaveText("Initial");
    expect(
      await page.evaluate(
        () =>
          document.querySelector("#content") === window.__htmlviewActiveFrame,
      ),
    ).toBe(true);

    await writeFile(entry, initial);
    await expect(page.locator("#limitation")).toBeHidden();
    await expect(page.getByRole("button", { name: "Annotate" })).toBeEnabled();
    await expect(page.getByRole("button", { name: "Page note" })).toBeEnabled();
    expect(
      await page.evaluate(
        () =>
          document.querySelector("#content") === window.__htmlviewActiveFrame,
      ),
    ).toBe(true);

    navigationMode = "allow";
    await writeFile(entry, "<!doctype html><plaintext>unsupported");
    await expect(page.locator("#limitation")).toContainText(
      "unsupported markup",
    );
    await expect(content.locator("#target")).toHaveText("Initial");
    await writeFile(entry, initial);
    await expect(page.locator("#limitation")).toBeHidden();
    await expect(page.getByRole("button", { name: "Annotate" })).toBeEnabled();
    expect(
      await page.evaluate(
        () =>
          document.querySelector("#content") === window.__htmlviewActiveFrame,
      ),
    ).toBe(true);

    navigationMode = "hold";
    await writeFile(entry, updated);
    await heldNavigation;
    await rename(entry, moved);
    releaseHeldNavigation();
    await expect(page.locator("#limitation")).toContainText(
      "temporarily unavailable",
    );
    await expect(content.locator("#target")).toHaveText("Initial");

    navigationMode = "allow";
    await rename(moved, entry);
    await expect(content.locator("#target")).toHaveText("Updated");
    await expect(page.locator("#live")).toHaveText("Annotation tools ready");
    await expect(page.locator("#limitation")).toBeHidden();
    expect(
      await page.evaluate(
        () =>
          document.querySelector("#content") !== window.__htmlviewActiveFrame,
      ),
    ).toBe(true);

    await page.locator("#content").evaluate((iframe) => {
      window.__htmlviewActiveFrame = iframe;
    });
    let delayedContentResolve;
    let releaseDelayedContent;
    const delayedContent = new Promise((resolve) => {
      delayedContentResolve = resolve;
    });
    const delayedContentRelease = new Promise((resolve) => {
      releaseDelayedContent = resolve;
    });
    const contentNavigationPattern = "**/*__htmlview_navigation=*";
    const delayContentNavigation = async (route) => {
      delayedContentResolve();
      await delayedContentRelease;
      await route.continue();
    };
    await page.route(contentNavigationPattern, delayContentNavigation);
    await writeFile(entry, delayed);
    await delayedContent;
    await page.waitForTimeout(2_000);
    await expect(content.locator("#target")).toHaveText("Updated");
    expect(
      await page.evaluate(
        () =>
          document.querySelector("#content") === window.__htmlviewActiveFrame,
      ),
    ).toBe(true);
    releaseDelayedContent();
    await expect(content.locator("#target")).toHaveText("Delayed");
    await page.unroute(contentNavigationPattern, delayContentNavigation);
    await page.unroute("**/.htmlview/api/navigation");

    let staleStateResolve;
    let releaseStaleState;
    let staleStateDoneResolve;
    const staleStateCaptured = new Promise((resolve) => {
      staleStateResolve = resolve;
    });
    const staleStateRelease = new Promise((resolve) => {
      releaseStaleState = resolve;
    });
    const staleStateDone = new Promise((resolve) => {
      staleStateDoneResolve = resolve;
    });
    const statePattern = "**/.htmlview/api/state";
    let captureNextState = true;
    const delayStaleState = async (route) => {
      if (!captureNextState) {
        await route.continue();
        return;
      }
      captureNextState = false;
      const response = await route.fetch();
      staleStateResolve();
      await staleStateRelease;
      await route.fulfill({ response });
      staleStateDoneResolve();
    };
    await page.route(statePattern, delayStaleState);
    await writeFile(entry, "<!doctype html><plaintext>stale limitation");
    await staleStateCaptured;
    await rename(entry, moved);
    await expect(page.locator("#limitation")).toContainText(
      "temporarily unavailable",
    );
    await writeFile(moved, recovered);
    await rename(moved, entry);
    await expect
      .poll(() =>
        page.evaluate(() =>
          fetch("/.htmlview/api/entry")
            .then((response) => response.json())
            .then((result) => result.entry.availability),
        ),
      )
      .toBe("available");
    await reloadReviewFrame(page);
    await expect(content.locator("#target")).toHaveText("Recovered");
    await expect(page.locator("#live")).toHaveText("Annotation tools ready");
    releaseStaleState();
    await staleStateDone;
    await page.unroute(statePattern, delayStaleState);
    await page.waitForTimeout(250);
    await expect(page.locator("#limitation")).toBeHidden();
    await expect(page.getByRole("button", { name: "Annotate" })).toBeEnabled();
  } finally {
    await execute(process.execPath, [cli, "stop", "--all", "--json"], {
      env: environment,
    }).catch(() => undefined);
    await rm(parent, { recursive: true, force: true });
  }
});

test("entry polling pauses, recovers transiently, and terminates after peer End", async ({
  page,
}) => {
  test.setTimeout(45_000);
  const parent = await mkdtemp(path.join(tmpdir(), "hv-review-polling-"));
  const root = path.join(parent, "root");
  const entry = path.join(root, "index.html");
  const environment = {
    ...process.env,
    HTMLVIEW_STATE_DIR: path.join(parent, "state"),
    HTMLVIEW_IDLE_MS: "10000",
  };
  delete environment.NO_COLOR;
  delete environment.FORCE_COLOR;
  let secondPage;
  try {
    await mkdir(root);
    await writeFile(entry, "<!doctype html><h1>Polling</h1>");
    const served = await command(environment, "serve", entry, "--root", root);
    const opened = await command(environment, "review", served.session.id);
    await page.goto(opened.review.url);
    await expect(page.locator("#live")).toHaveText("Annotation tools ready");
    await page.getByRole("button", { name: "Page note" }).click();
    await page.locator("#comment").fill("Draft visible during peer closure");
    await page.getByRole("button", { name: "Add draft" }).click();
    await expect(
      page.getByRole("button", { name: "Send selected" }),
    ).toBeEnabled();
    secondPage = await page.context().newPage();
    await secondPage.goto(opened.review.url);
    await expect(secondPage.locator("#live")).toHaveText(
      "Annotation tools ready",
    );

    let transientFailures = 0;
    let successfulPolls = 0;
    await page.route("**/.htmlview/api/entry", async (route) => {
      if (transientFailures < 2) {
        transientFailures += 1;
        await route.abort();
        return;
      }
      successfulPolls += 1;
      await route.continue();
    });
    await expect.poll(() => transientFailures).toBe(2);
    await expect.poll(() => successfulPolls).toBeGreaterThanOrEqual(1);
    await expect(page.getByRole("button", { name: "Annotate" })).toBeEnabled();
    await page.unroute("**/.htmlview/api/entry");

    let entryRequests = 0;
    page.on("request", (request) => {
      if (request.url().endsWith("/.htmlview/api/entry")) entryRequests += 1;
    });
    await page.evaluate(() => {
      let hidden = false;
      Object.defineProperties(document, {
        hidden: { configurable: true, get: () => hidden },
        visibilityState: {
          configurable: true,
          get: () => (hidden ? "hidden" : "visible"),
        },
      });
      window.__htmlviewSetTestVisibility = (nextHidden) => {
        hidden = nextHidden;
        document.dispatchEvent(new Event("visibilitychange"));
      };
    });
    await page.evaluate(() => window.__htmlviewSetTestVisibility(true));
    expect(await page.evaluate(() => document.hidden)).toBe(true);
    const requestsWhileHidden = entryRequests;
    await page.waitForTimeout(1_200);
    expect(entryRequests).toBe(requestsWhileHidden);
    await page.evaluate(() => window.__htmlviewSetTestVisibility(false));
    expect(await page.evaluate(() => document.visibilityState)).toBe("visible");
    await expect.poll(() => entryRequests).toBeGreaterThan(requestsWhileHidden);

    await page.evaluate(() =>
      window.dispatchEvent(
        new PageTransitionEvent("pagehide", { persisted: true }),
      ),
    );
    const requestsWhilePaused = entryRequests;
    await page.waitForTimeout(1_200);
    expect(entryRequests).toBe(requestsWhilePaused);
    await page.evaluate(() =>
      window.dispatchEvent(
        new PageTransitionEvent("pageshow", { persisted: true }),
      ),
    );
    await expect.poll(() => entryRequests).toBeGreaterThan(requestsWhilePaused);

    await secondPage.getByRole("button", { name: "Send & end" }).click();
    await expect(secondPage.locator("#review-status")).toHaveText(
      "Feedback sent · review ended",
    );
    await expect(page.locator("#review-status")).toHaveText(
      "Review unavailable",
      { timeout: 8_000 },
    );
    await expect(page.locator("#limitation")).toContainText(
      "Review connection closed",
    );
    await expect(page.locator("#live")).toHaveText(
      "Review connection closed. Ask for a new review link to continue.",
    );
    await expect(
      page.getByRole("checkbox", {
        name: /Draft visible during peer closure/,
      }),
    ).toBeDisabled();
    await expect(page.getByRole("button", { name: "Annotate" })).toBeDisabled();
    await expect(page.getByRole("button", { name: "Explore" })).toBeDisabled();
    await expect(
      page.getByRole("button", { name: "Send selected" }),
    ).toBeDisabled();
    const requestsAfterTerminal = entryRequests;
    await page.waitForTimeout(1_200);
    expect(entryRequests).toBe(requestsAfterTerminal);
  } finally {
    await secondPage?.close();
    await execute(process.execPath, [cli, "stop", "--all", "--json"], {
      env: environment,
    }).catch(() => undefined);
    await rm(parent, { recursive: true, force: true });
  }
});

test("entry observation is coalesced, recoverable, and shared by review clients", async ({
  page,
}) => {
  const parent = await mkdtemp(path.join(tmpdir(), "hv-review-observer-"));
  const root = path.join(parent, "root");
  const entry = path.join(root, "index.html");
  const moved = path.join(root, "index.moved.html");
  const replacement = path.join(root, "replacement.html");
  const initial =
    '<!doctype html><html><body><h1 id="target">Initial</h1></body></html>';
  const rapidFinal =
    '<!doctype html><html><body><h1 id="target">Rapid final</h1></body></html>';
  const atomic =
    '<!doctype html><html><body><h1 id="target">Atomic replacement</h1></body></html>';
  const environment = {
    ...process.env,
    HTMLVIEW_STATE_DIR: path.join(parent, "state"),
    HTMLVIEW_IDLE_MS: "10000",
  };
  delete environment.NO_COLOR;
  delete environment.FORCE_COLOR;
  let secondPage;
  try {
    await mkdir(root);
    await writeFile(entry, initial);
    const served = await command(environment, "serve", entry, "--root", root);
    const rawBeforeResponse = await fetch(served.session.url);
    const rawHeaders = (response) =>
      Object.fromEntries(
        ["cache-control", "content-type", "x-content-type-options"].map(
          (name) => [name, response.headers.get(name)],
        ),
      );
    const rawBeforeHeaders = rawHeaders(rawBeforeResponse);
    expect(await rawBeforeResponse.text()).toBe(initial);
    const opened = await command(environment, "review", served.session.id);
    await page.goto(opened.review.url);
    secondPage = await page.context().newPage();
    await secondPage.goto(opened.review.url);
    const content = page.frameLocator("#content");
    const secondContent = secondPage.frameLocator("#content");
    await expect(page.locator("#live")).toHaveText("Annotation tools ready");
    await expect(secondPage.locator("#live")).toHaveText(
      "Annotation tools ready",
    );
    await page.locator("#content").evaluate((iframe) => {
      window.__htmlviewActiveFrame = iframe;
    });
    let navigationRequests = 0;
    await page.route("**/.htmlview/api/navigation", async (route) => {
      navigationRequests += 1;
      if (navigationRequests <= 2) await route.abort();
      else await route.continue();
    });

    await writeFile(
      entry,
      '<!doctype html><html><body><h1 id="target">Rapid intermediate</h1></body></html>',
    );
    await writeFile(entry, rapidFinal);
    await expect.poll(() => navigationRequests).toBeGreaterThanOrEqual(1);
    await expect(page.getByRole("button", { name: "Annotate" })).toBeDisabled();
    await expect(content.locator("#target")).toHaveText("Rapid final");
    await expect(secondContent.locator("#target")).toHaveText("Rapid final");
    expect(
      await page.evaluate(
        () =>
          document.querySelector("#content") !== window.__htmlviewActiveFrame,
      ),
    ).toBe(true);
    await page.locator("#content").evaluate((iframe) => {
      window.__htmlviewActiveFrame = iframe;
    });
    expect(navigationRequests).toBeGreaterThanOrEqual(3);

    await writeFile(entry, rapidFinal);
    await page.waitForTimeout(1_500);
    expect(
      await page.evaluate(
        () =>
          document.querySelector("#content") === window.__htmlviewActiveFrame,
      ),
    ).toBe(true);

    await rename(entry, moved);
    await expect(page.locator("#limitation")).toContainText(
      "temporarily unavailable",
    );
    await expect(page.getByRole("button", { name: "Annotate" })).toBeDisabled();
    await expect(content.locator("#target")).toHaveText("Rapid final");
    await rename(moved, entry);
    await expect(page.locator("#limitation")).toBeHidden();
    await expect(page.locator("#live")).toHaveText("Annotation tools ready");
    expect(
      await page.evaluate(
        () =>
          document.querySelector("#content") === window.__htmlviewActiveFrame,
      ),
    ).toBe(true);

    await writeFile(entry, Buffer.alloc(8 * 1024 * 1024 + 1, 0x20));
    await expect(page.locator("#limitation")).toContainText("entry too large");
    await expect(page.getByRole("button", { name: "Annotate" })).toBeDisabled();
    await expect(content.locator("#target")).toHaveText("Rapid final");
    await writeFile(entry, rapidFinal);
    await expect(page.locator("#limitation")).toBeHidden();
    await expect(page.locator("#live")).toHaveText("Annotation tools ready");
    expect(
      await page.evaluate(
        () =>
          document.querySelector("#content") === window.__htmlviewActiveFrame,
      ),
    ).toBe(true);

    await writeFile(replacement, atomic);
    await rename(replacement, entry);
    await expect(content.locator("#target")).toHaveText("Atomic replacement");
    await expect(secondContent.locator("#target")).toHaveText(
      "Atomic replacement",
    );
    expect(
      await page.evaluate(
        () =>
          document.querySelector("#content") !== window.__htmlviewActiveFrame,
      ),
    ).toBe(true);
    const rawAfterResponse = await fetch(served.session.url);
    expect(rawHeaders(rawAfterResponse)).toEqual(rawBeforeHeaders);
    expect(await rawAfterResponse.text()).toBe(atomic);
  } finally {
    await secondPage?.close();
    await execute(process.execPath, [cli, "stop", "--all", "--json"], {
      env: environment,
    }).catch(() => undefined);
    await rm(parent, { recursive: true, force: true });
  }
});

test("served assets refresh without unrelated reloads or lost in-flight changes", async ({
  page,
}) => {
  const parent = await mkdtemp(path.join(tmpdir(), "hv-review-assets-"));
  const root = path.join(parent, "root");
  const assets = path.join(root, "assets");
  const entry = path.join(root, "index.html");
  const stylesheet = path.join(assets, "site.css");
  const unrelated = path.join(root, "unrelated.txt");
  const environment = {
    ...process.env,
    HTMLVIEW_STATE_DIR: path.join(parent, "state"),
    HTMLVIEW_IDLE_MS: "10000",
  };
  delete environment.NO_COLOR;
  delete environment.FORCE_COLOR;
  let releaseFirstProbe;
  let releaseStaleAssetNavigation;
  try {
    await mkdir(assets, { recursive: true });
    await writeFile(
      entry,
      '<!doctype html><html><head><link rel="stylesheet" href="/assets/site.css"></head><body><h1 id="target">Asset refresh</h1></body></html>',
    );
    await writeFile(stylesheet, "#target { color: rgb(0, 128, 0); }");
    const served = await command(environment, "serve", entry, "--root", root);
    const opened = await command(environment, "review", served.session.id);
    await page.goto(opened.review.url);
    const content = page.frameLocator("#content");
    const targetColor = () =>
      content
        .locator("#target")
        .evaluate((target) => getComputedStyle(target).color);
    const entryAssetRevision = () =>
      page.evaluate(async () => {
        const response = await fetch("/.htmlview/api/entry");
        const result = await response.json();
        return result.entry.asset_revision;
      });
    await expect(page.locator("#live")).toHaveText("Annotation tools ready");
    await expect.poll(targetColor).toBe("rgb(0, 128, 0)");
    await page.locator("#content").evaluate((iframe) => {
      window.__htmlviewAssetFrame = iframe;
    });

    await page.getByRole("button", { name: "Page note" }).click();
    await page.locator("#comment").fill("Unsaved asset review feedback");
    await writeFile(unrelated, "not requested by the review");
    await page.waitForTimeout(1_500);
    expect(
      await page.evaluate(
        () =>
          document.querySelector("#content") === window.__htmlviewAssetFrame,
      ),
    ).toBe(true);
    await expect(page.locator("#editor")).toBeVisible();
    await expect(page.locator("#comment")).toHaveValue(
      "Unsaved asset review feedback",
    );

    await writeFile(stylesheet, "#target { color: rgb(0, 0, 255); }");
    await page.waitForTimeout(1_500);
    expect(
      await page.evaluate(
        () =>
          document.querySelector("#content") === window.__htmlviewAssetFrame,
      ),
    ).toBe(true);
    await expect(page.locator("#comment")).toHaveValue(
      "Unsaved asset review feedback",
    );
    await expect.poll(targetColor).toBe("rgb(0, 128, 0)");
    await page.getByRole("button", { name: "Cancel" }).click();
    await expect.poll(targetColor).toBe("rgb(0, 0, 255)");
    expect(
      await page.evaluate(
        () =>
          document.querySelector("#content") !== window.__htmlviewAssetFrame,
      ),
    ).toBe(true);

    await page.waitForTimeout(1_000);
    const renderedBlueRevision = await entryAssetRevision();
    await page.locator("#content").evaluate((iframe) => {
      window.__htmlviewAssetFrame = iframe;
    });
    await page.getByRole("button", { name: "Page note" }).click();
    await page.locator("#comment").fill("Keep this while an asset reverts");
    await writeFile(stylesheet, "#target { color: rgb(0, 255, 255); }");
    await expect.poll(entryAssetRevision).not.toBe(renderedBlueRevision);
    await writeFile(stylesheet, "#target { color: rgb(0, 0, 255); }");
    await expect.poll(entryAssetRevision).toBe(renderedBlueRevision);
    await page.waitForTimeout(750);
    await expect(page.locator("#comment")).toHaveValue(
      "Keep this while an asset reverts",
    );
    await page.getByRole("button", { name: "Cancel" }).click();
    await page.waitForTimeout(1_000);
    expect(
      await page.evaluate(
        () =>
          document.querySelector("#content") === window.__htmlviewAssetFrame,
      ),
    ).toBe(true);
    await expect.poll(targetColor).toBe("rgb(0, 0, 255)");

    let probeRequests = 0;
    let firstProbeResolve;
    const firstProbe = new Promise((resolve) => {
      firstProbeResolve = resolve;
    });
    const firstProbeRelease = new Promise((resolve) => {
      releaseFirstProbe = resolve;
    });
    await page.route("**/.htmlview/api/probe", async (route) => {
      probeRequests += 1;
      if (probeRequests === 1) {
        firstProbeResolve();
        await firstProbeRelease;
      }
      await route.continue();
    });

    await writeFile(stylesheet, "#target { color: rgb(128, 0, 128); }");
    await firstProbe;
    await writeFile(stylesheet, "#target { color: rgb(255, 0, 0); }");
    await page.waitForTimeout(800);
    releaseFirstProbe();
    releaseFirstProbe = undefined;
    await expect.poll(() => probeRequests).toBeGreaterThanOrEqual(2);
    await expect.poll(targetColor).toBe("rgb(255, 0, 0)");
    await expect(page.locator("#live")).toHaveText("Annotation tools ready");
    await page.waitForTimeout(2_000);

    const renderedRedRevision = await entryAssetRevision();

    let failedNavigationRequests = 0;
    await page.route("**/.htmlview/api/navigation", async (route) => {
      failedNavigationRequests += 1;
      if (failedNavigationRequests <= 3) await route.abort();
      else await route.continue();
    });
    await writeFile(stylesheet, "#target { color: rgb(0, 255, 255); }");
    await expect.poll(() => failedNavigationRequests).toBeGreaterThanOrEqual(3);
    await expect(page.locator("#limitation")).toContainText(
      "instrumentation unavailable",
    );
    await writeFile(stylesheet, "#target { color: rgb(255, 0, 0); }");
    await expect.poll(entryAssetRevision).toBe(renderedRedRevision);
    await expect(page.locator("#limitation")).toBeHidden();
    await page.unroute("**/.htmlview/api/navigation");

    let supersededNavigationRequests = 0;
    const staleAssetNavigation = new Promise((resolve) => {
      releaseStaleAssetNavigation = resolve;
    });
    let markStaleAssetNavigationStarted;
    const staleAssetNavigationStarted = new Promise((resolve) => {
      markStaleAssetNavigationStarted = resolve;
    });
    await page.route("**/.htmlview/api/navigation", async (route) => {
      supersededNavigationRequests += 1;
      if (supersededNavigationRequests === 1) {
        markStaleAssetNavigationStarted();
        await staleAssetNavigation;
        await route.abort();
        return;
      }
      await route.continue();
    });
    await writeFile(stylesheet, "#target { color: rgb(0, 0, 0); }");
    await staleAssetNavigationStarted;
    await writeFile(
      entry,
      '<!doctype html><html><head><link rel="stylesheet" href="/assets/site.css"></head><body><h1 id="target">Entry supersedes stale asset navigation</h1></body></html>',
    );
    await expect(content.locator("#target")).toHaveText(
      "Entry supersedes stale asset navigation",
    );
    expect(supersededNavigationRequests).toBeGreaterThanOrEqual(2);
    releaseStaleAssetNavigation();
    releaseStaleAssetNavigation = undefined;
    await page.unroute("**/.htmlview/api/navigation");
  } finally {
    releaseFirstProbe?.();
    releaseStaleAssetNavigation?.();
    await execute(process.execPath, [cli, "stop", "--all", "--json"], {
      env: environment,
    }).catch(() => undefined);
    await rm(parent, { recursive: true, force: true });
  }
});
