const shellHtml = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>htmlview review</title>
  <link rel="stylesheet" href="/.htmlview/shell.css">
  <script src="/.htmlview/shell.js" defer></script>
</head>
<body>
  <header class="toolbar">
    <div class="identity"><strong>htmlview</strong><span id="review-status">Loading review…</span></div>
    <div class="mode-switch" role="group" aria-label="Review interaction mode">
      <button id="mode-explore" type="button" aria-pressed="false">Explore</button>
      <button id="mode-annotate" type="button" aria-pressed="true">Annotate</button>
    </div>
    <button id="draft-toggle" class="quiet" type="button" aria-expanded="true" aria-controls="drafts">Drafts <span id="draft-count">0</span></button>
  </header>
  <main>
    <section class="canvas" aria-label="Reviewed page">
      <iframe id="content" title="Page under review" sandbox="allow-scripts allow-same-origin" referrerpolicy="no-referrer"></iframe>
      <div id="highlight" aria-hidden="true"></div>
      <div id="limitation" class="notice" role="status" hidden></div>
      <section id="editor" class="editor" aria-label="New annotation" hidden>
        <p id="target-label">Page feedback</p>
        <label for="comment">Comment</label>
        <textarea id="comment" maxlength="4096" rows="4" placeholder="Describe what should change"></textarea>
        <div class="editor-actions">
          <button id="cancel-comment" class="quiet" type="button">Cancel</button>
          <button id="queue-comment" class="primary" type="button">Add draft</button>
        </div>
      </section>
    </section>
    <aside id="drafts" aria-label="Annotation drafts">
      <div class="draft-heading">
        <div><h1>Review notes</h1><p>Saved privately until you send them.</p></div>
        <button id="freeform" class="quiet" type="button">Page note</button>
      </div>
      <div id="draft-list" class="draft-list"></div>
      <p id="empty-drafts" class="empty">Select an element on the page, or add a page note.</p>
      <div id="end-confirm" class="confirm" hidden>
        <p>Some drafts are not selected. Ending now requires explicitly discarding them.</p>
        <button id="discard-and-end" class="danger" type="button">Discard unselected and end</button>
        <button id="cancel-end" class="quiet" type="button">Keep reviewing</button>
      </div>
      <div class="send-actions">
        <button id="send" class="primary" type="button">Send selected</button>
        <button id="end" class="quiet" type="button">Send &amp; end</button>
      </div>
    </aside>
  </main>
  <div id="live" class="sr-only" aria-live="polite"></div>
</body>
</html>`;

const shellCss = `:root {
  color-scheme: light;
  --bg: oklch(1 0 0);
  --surface: oklch(0.97 0.004 200);
  --surface-strong: oklch(0.93 0.008 200);
  --ink: oklch(0.2 0.018 220);
  --muted: oklch(0.48 0.025 215);
  --line: oklch(0.86 0.012 210);
  --primary: oklch(0.5 0.13 200);
  --primary-hover: oklch(0.44 0.13 200);
  --focus: oklch(0.75 0.08 200);
  --danger: oklch(0.5 0.17 28);
  --toolbar: 52px;
  font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  color: var(--ink);
  background: var(--bg);
}

* { box-sizing: border-box; }
html, body { height: 100%; margin: 0; }
body { overflow: hidden; font-size: 14px; }
button, textarea { font: inherit; }
button { min-height: 36px; border: 0; border-radius: 8px; padding: 0 12px; cursor: pointer; color: var(--ink); background: var(--surface-strong); }
button:hover { background: oklch(0.9 0.012 205); }
button:active { transform: translateY(1px); }
button:focus-visible, textarea:focus-visible { outline: 3px solid var(--focus); outline-offset: 2px; }
button:disabled { cursor: not-allowed; opacity: .48; transform: none; }
.primary { color: var(--bg); background: var(--primary); font-weight: 650; }
.primary:hover { background: var(--primary-hover); }
.quiet { background: transparent; border: 1px solid var(--line); }
.danger { color: var(--bg); background: var(--danger); font-weight: 650; }

.toolbar { height: var(--toolbar); display: flex; align-items: center; gap: 18px; padding: 0 14px; border-bottom: 1px solid var(--line); background: var(--bg); }
.identity { min-width: 0; display: flex; align-items: baseline; gap: 9px; }
.identity strong { font-size: 15px; letter-spacing: -.02em; }
.identity span { color: var(--muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.mode-switch { display: flex; padding: 3px; border-radius: 10px; background: var(--surface); }
.mode-switch button { min-height: 30px; background: transparent; }
.mode-switch button[aria-pressed="true"] { color: var(--bg); background: var(--primary); }
#draft-toggle { margin-left: auto; }
#draft-count { display: inline-grid; place-items: center; min-width: 20px; height: 20px; margin-left: 4px; padding: 0 5px; border-radius: 999px; background: var(--surface-strong); font-size: 12px; }

main { height: calc(100% - var(--toolbar)); display: grid; grid-template-columns: minmax(0, 1fr) 340px; }
.canvas { position: relative; min-width: 0; overflow: hidden; background: var(--surface); }
#content { display: block; width: 100%; height: 100%; border: 0; background: var(--bg); }
#highlight { position: absolute; pointer-events: none; border: 2px solid var(--primary); background: oklch(0.75 0.08 200 / .16); transition: transform 120ms ease-out, width 120ms ease-out, height 120ms ease-out; }
#highlight:not([data-visible="true"]) { display: none; }
.notice { position: absolute; inset: 18px auto auto 50%; translate: -50% 0; max-width: min(560px, calc(100% - 36px)); padding: 12px 14px; border-radius: 10px; color: var(--ink); background: var(--bg); border: 1px solid var(--line); }

.editor { position: absolute; z-index: 3; right: 16px; bottom: 16px; width: min(380px, calc(100% - 32px)); padding: 14px; border-radius: 12px; background: var(--bg); box-shadow: 0 4px 8px oklch(0.2 0.018 220 / .16); }
.editor p { margin: 0 0 10px; color: var(--muted); font-weight: 600; }
.editor label { display: block; margin-bottom: 6px; font-weight: 650; }
.editor textarea { width: 100%; resize: vertical; min-height: 96px; max-height: 240px; padding: 10px 11px; border: 1px solid var(--line); border-radius: 8px; color: var(--ink); background: var(--bg); }
.editor textarea::placeholder { color: oklch(0.42 0.02 215); }
.editor-actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 10px; }

aside { min-width: 0; display: flex; flex-direction: column; border-left: 1px solid var(--line); background: var(--bg); }
.draft-heading { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; padding: 18px 16px 14px; border-bottom: 1px solid var(--line); }
.draft-heading h1 { margin: 0; font-size: 17px; letter-spacing: -.02em; text-wrap: balance; }
.draft-heading p { margin: 4px 0 0; color: var(--muted); font-size: 12px; }
.draft-list { min-height: 0; overflow: auto; }
.draft { display: grid; grid-template-columns: 20px minmax(0, 1fr); gap: 10px; padding: 13px 16px; border-bottom: 1px solid var(--line); }
.draft input { width: 18px; height: 18px; accent-color: var(--primary); }
.draft p { margin: 0; white-space: pre-wrap; overflow-wrap: anywhere; line-height: 1.45; }
.draft small { display: block; margin-top: 5px; color: var(--muted); }
.empty { margin: auto 24px; color: var(--muted); text-align: center; line-height: 1.5; }
.confirm { margin-top: auto; padding: 14px 16px; border-top: 1px solid var(--line); background: oklch(0.97 0.015 28); }
.confirm p { margin: 0 0 10px; line-height: 1.45; }
.confirm button { width: 100%; margin-top: 6px; }
.send-actions { margin-top: auto; display: grid; grid-template-columns: 1fr 1fr; gap: 8px; padding: 12px 16px; border-top: 1px solid var(--line); }
.sr-only { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0, 0, 0, 0); white-space: nowrap; }

@media (max-width: 760px) {
  .toolbar { gap: 8px; }
  .identity span { display: none; }
  main { display: block; }
  aside { position: fixed; z-index: 4; left: 0; right: 0; bottom: 0; max-height: 68vh; border-left: 0; border-top: 1px solid var(--line); transform: translateY(100%); transition: transform 180ms cubic-bezier(.22, 1, .36, 1); }
  aside[data-open="true"] { transform: translateY(0); }
  button { min-height: 44px; }
  .mode-switch button { min-height: 38px; }
}

@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after { scroll-behavior: auto !important; transition-duration: .01ms !important; animation-duration: .01ms !important; }
}
`;

function embeddedJavaScript(source: string): string {
  return source.replaceAll("\\`", "`").replaceAll("\\${", "${");
}

const shellJs = embeddedJavaScript(String.raw`(() => {
  "use strict";
  const channel = "htmlview.review";
  const version = 1;
  const byId = (id) => document.getElementById(id);
  const iframe = byId("content");
  const status = byId("review-status");
  const limitation = byId("limitation");
  const live = byId("live");
  const draftsPanel = byId("drafts");
  const draftList = byId("draft-list");
  const emptyDrafts = byId("empty-drafts");
  const draftCount = byId("draft-count");
  const editor = byId("editor");
  const comment = byId("comment");
  const targetLabel = byId("target-label");
  const highlight = byId("highlight");
  const encoder = new TextEncoder();
  let state;
  let contentOrigin;
  let mode = "annotate";
  let revision;
  let selectedTarget;
  let editorGeneration = 0;
  let readyTimer;

  const announce = (message) => { live.textContent = message; };
  const exactKeys = (value, keys) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    const actual = Object.keys(value).sort();
    return actual.length === keys.length && keys.slice().sort().every((key, index) => actual[index] === key);
  };
  const bounded = (value, bytes, nonempty = true) =>
    typeof value === "string" && (!nonempty || value.length > 0) && encoder.encode(value).length <= bytes;
  const validAnchor = (anchor) => {
    if (!anchor || typeof anchor !== "object" || Array.isArray(anchor)) return false;
    const keys = Object.keys(anchor).sort().join(",");
    if (keys !== "dom_path,selector,tag" && keys !== "dom_path,selector,tag,text") return false;
    return bounded(anchor.selector, 2048) && bounded(anchor.dom_path, 4096) && bounded(anchor.tag, 128) && (anchor.text === undefined || bounded(anchor.text, 512, false));
  };
  const validRect = (rect) => exactKeys(rect, ["height", "width", "x", "y"]) &&
    [rect.x, rect.y, rect.width, rect.height].every((value) => Number.isFinite(value) && Math.abs(value) <= 100000) && rect.width >= 0 && rect.height >= 0;

  async function api(path, options = {}) {
    const response = await fetch(path, {
      ...options,
      headers: options.body === undefined ? undefined : { "content-type": "application/json" },
    });
    const value = await response.json().catch(() => ({ error: { message: "Invalid review response" } }));
    if (!response.ok) throw new Error(value.error?.message || "Review request failed");
    return value;
  }

  function publicDraft(draft) {
    const row = document.createElement("label");
    row.className = "draft";
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = true;
    checkbox.dataset.id = draft.id;
    const body = document.createElement("span");
    const text = document.createElement("p");
    text.textContent = draft.comment;
    const context = document.createElement("small");
    context.textContent = draft.kind === "element" ? \`Element · \${draft.anchor.tag} · untrusted page context\` : "Page note";
    body.append(text, context);
    row.append(checkbox, body);
    return row;
  }

  function render() {
    status.textContent = state.review.status === "ready" ? "Annotation review" : \`Review \${state.review.status}\`;
    draftCount.textContent = String(state.drafts.length);
    draftList.replaceChildren(...state.drafts.map(publicDraft));
    emptyDrafts.hidden = state.drafts.length !== 0;
    byId("send").disabled = state.drafts.length === 0;
    byId("end").disabled = state.review.status !== "ready";
    if (state.limitation) {
      limitation.hidden = false;
      limitation.textContent = \`This page cannot be annotated: \${state.limitation.replaceAll("_", " ")}. The raw page remains available.\`;
    }
  }

  async function refresh() {
    state = await api("/.htmlview/api/state");
    contentOrigin = new URL(state.content_url).origin;
    render();
    if (!iframe.hasAttribute("src")) iframe.src = state.content_url;
  }

  function sendMode() {
    iframe.contentWindow?.postMessage({ channel, version, type: "set_mode", mode }, contentOrigin);
  }

  function setMode(next) {
    mode = next;
    byId("mode-explore").setAttribute("aria-pressed", String(next === "explore"));
    byId("mode-annotate").setAttribute("aria-pressed", String(next === "annotate"));
    if (next === "explore") {
      selectedTarget = undefined;
      highlight.removeAttribute("data-visible");
      editor.hidden = true;
    }
    sendMode();
  }

  function placeHighlight(rect) {
    highlight.dataset.visible = "true";
    highlight.style.transform = \`translate(\${Math.max(0, rect.x)}px, \${Math.max(0, rect.y)}px)\`;
    highlight.style.width = \`\${Math.max(0, rect.width)}px\`;
    highlight.style.height = \`\${Math.max(0, rect.height)}px\`;
  }

  function openEditor(target) {
    editorGeneration += 1;
    selectedTarget = target;
    targetLabel.textContent = target ? \`\${target.anchor.tag} · untrusted page context\` : "Page feedback";
    comment.value = "";
    editor.hidden = false;
    comment.focus();
  }

  window.addEventListener("message", (event) => {
    if (event.source !== iframe.contentWindow || event.origin !== contentOrigin) return;
    const data = event.data;
    if (!data || data.channel !== channel || data.version !== version || typeof data.type !== "string") return;
    if (data.type === "probe_ready" && exactKeys(data, ["channel", "revision", "type", "version"]) && /^sha256:[0-9a-f]{64}$/.test(data.revision)) {
      const changed = revision !== data.revision;
      const replaced = revision !== undefined && changed;
      revision = data.revision;
      clearTimeout(readyTimer);
      limitation.hidden = true;
      if (replaced) {
        editorGeneration += 1;
        selectedTarget = undefined;
        editor.hidden = true;
        highlight.removeAttribute("data-visible");
      }
      if (changed) {
        announce("Annotation tools ready");
        sendMode();
      }
      return;
    }
    if ((data.type === "target_preview" || data.type === "target_selected") && exactKeys(data, ["anchor", "channel", "handle", "rect", "type", "version"]) && bounded(data.handle, 64) && validAnchor(data.anchor) && validRect(data.rect)) {
      if (mode !== "annotate") return;
      placeHighlight(data.rect);
      if (data.type === "target_selected") openEditor({ handle: data.handle, anchor: data.anchor });
      return;
    }
    if (data.type === "target_cleared" && exactKeys(data, ["channel", "type", "version"])) highlight.removeAttribute("data-visible");
  });

  iframe.addEventListener("load", () => {
    revision = undefined;
    editorGeneration += 1;
    selectedTarget = undefined;
    editor.hidden = true;
    highlight.removeAttribute("data-visible");
    announce("Loading annotation tools");
    clearTimeout(readyTimer);
    const interval = setInterval(sendMode, 100);
    readyTimer = setTimeout(() => {
      clearInterval(interval);
      refresh().catch(() => undefined).finally(() => {
        limitation.hidden = false;
        if (!state?.limitation) limitation.textContent = "Annotation probe did not start. Authored policy or navigation may have blocked instrumentation; the raw page remains available.";
      });
    }, 1800);
    setTimeout(() => clearInterval(interval), 2000);
  });

  async function queueDraft() {
    const value = comment.value.trim();
    if (!value || !revision) {
      announce(!revision ? "Wait for the page annotation tools to become ready" : "Enter a comment first");
      return;
    }
    const payload = selectedTarget ? { kind: "element", comment: value, revision, anchor: selectedTarget.anchor } : { kind: "freeform", comment: value, revision };
    const generation = editorGeneration;
    byId("queue-comment").disabled = true;
    try {
      await api("/.htmlview/api/drafts", { method: "POST", body: JSON.stringify(payload) });
      if (editorGeneration === generation) {
        editor.hidden = true;
        highlight.removeAttribute("data-visible");
      }
      await refresh();
      announce("Draft saved privately");
    } catch (error) { announce(error.message); }
    finally { byId("queue-comment").disabled = false; }
  }

  const selectedIds = () => [...draftList.querySelectorAll('input[type="checkbox"]:checked')].map((input) => input.dataset.id);
  async function publish(end, discardRemaining = false) {
    const ids = selectedIds();
    if (end && !discardRemaining && ids.length !== state.drafts.length) {
      byId("end-confirm").hidden = false;
      return;
    }
    const route = end ? "/.htmlview/api/end" : "/.htmlview/api/send";
    try {
      const result = await api(route, { method: "POST", body: JSON.stringify(end ? { drafts: ids, discard_remaining: discardRemaining } : { drafts: ids }) });
      if (end) {
        status.textContent = "Feedback sent · review ended";
        draftsPanel.replaceChildren();
        announce("Feedback sent and review ended");
      } else {
        await refresh();
        announce(\`\${result.sent} draft\${result.sent === 1 ? "" : "s"} sent\`);
      }
    } catch (error) { announce(error.message); }
  }

  byId("mode-explore").addEventListener("click", () => setMode("explore"));
  byId("mode-annotate").addEventListener("click", () => setMode("annotate"));
  byId("draft-toggle").addEventListener("click", () => {
    const open = draftsPanel.dataset.open !== "true";
    draftsPanel.dataset.open = String(open);
    byId("draft-toggle").setAttribute("aria-expanded", String(open));
  });
  byId("freeform").addEventListener("click", () => openEditor(undefined));
  byId("cancel-comment").addEventListener("click", () => { editorGeneration += 1; editor.hidden = true; });
  byId("queue-comment").addEventListener("click", queueDraft);
  byId("send").addEventListener("click", () => publish(false));
  byId("end").addEventListener("click", () => publish(true));
  byId("discard-and-end").addEventListener("click", () => publish(true, true));
  byId("cancel-end").addEventListener("click", () => { byId("end-confirm").hidden = true; });
  comment.addEventListener("keydown", (event) => {
    if (event.key === "Escape") editor.hidden = true;
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) { event.preventDefault(); queueDraft(); }
  });
  window.addEventListener("resize", () => highlight.removeAttribute("data-visible"));
  refresh().catch((error) => { limitation.hidden = false; limitation.textContent = error.message; });
})();`);

const probeJs = embeddedJavaScript(String.raw`(() => {
  "use strict";
  const channel = "htmlview.review";
  const version = 1;
  const script = document.currentScript;
  const revision = script?.dataset.htmlviewRevision;
  if (!/^sha256:[0-9a-f]{64}$/.test(revision || "")) return;
  const encoder = new TextEncoder();
  const excludedTextElements = new Set(["INPUT", "TEXTAREA", "SELECT", "OPTION", "BUTTON", "SCRIPT", "STYLE", "TEMPLATE"]);
  let parentOrigin;
  let mode = "annotate";
  let sequence = 0;
  const truncate = (value, bytes) => {
    let result = "";
    let size = 0;
    for (const character of String(value || "")) {
      const width = encoder.encode(character).length;
      if (size + width > bytes) break;
      result += character;
      size += width;
    }
    return result;
  };
  const normalizedText = (element) => {
    if (excludedTextElements.has(element.tagName)) return undefined;
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        if (node.nodeType === Node.ELEMENT_NODE && excludedTextElements.has(node.tagName)) return NodeFilter.FILTER_REJECT;
        return node.nodeType === Node.TEXT_NODE ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP;
      },
    });
    let value = "";
    let size = 0;
    let pendingSpace = false;
    let complete = true;
    while (complete) {
      const node = walker.nextNode();
      if (!node) break;
      for (const character of node.nodeValue || "") {
        if (/\s/u.test(character)) {
          if (value) pendingSpace = true;
          continue;
        }
        if (pendingSpace) {
          if (size + 1 > 512) { complete = false; break; }
          value += " ";
          size += 1;
          pendingSpace = false;
        }
        const width = encoder.encode(character).length;
        if (size + width > 512) { complete = false; break; }
        value += character;
        size += width;
      }
    }
    return value || undefined;
  };
  const segment = (element) => {
    const tag = element.tagName.toLowerCase();
    const siblings = element.parentElement ? [...element.parentElement.children].filter((candidate) => candidate.tagName === element.tagName) : [element];
    return \`\${tag}:nth-of-type(\${siblings.indexOf(element) + 1})\`;
  };
  const anchorFor = (element) => {
    const elements = [];
    for (let current = element; current && current.nodeType === Node.ELEMENT_NODE && elements.length < 12; current = current.parentElement) elements.unshift(current);
    const dom = elements.map((current) => {
      const siblings = current.parentElement ? [...current.parentElement.children].filter((candidate) => candidate.tagName === current.tagName) : [current];
      return \`\${current.tagName.toLowerCase()}[\${siblings.indexOf(current)}]\`;
    }).join("/");
    const selector = element.id ? \`#\${CSS.escape(element.id)}\` : elements.map(segment).join(" > ");
    const text = normalizedText(element);
    return {
      selector: truncate(selector, 2048),
      dom_path: truncate(dom, 4096),
      tag: truncate(element.tagName.toLowerCase(), 128),
      ...(text === undefined ? {} : { text }),
    };
  };
  const send = (type, element) => {
    if (!parentOrigin) return;
    if (!element) { parent.postMessage({ channel, version, type: "target_cleared" }, parentOrigin); return; }
    const rect = element.getBoundingClientRect();
    parent.postMessage({ channel, version, type, handle: \`target-\${++sequence}\`, anchor: anchorFor(element), rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height } }, parentOrigin);
  };
  addEventListener("message", (event) => {
    const data = event.data;
    if (event.source !== parent || !data || data.channel !== channel || data.version !== version || data.type !== "set_mode" || (data.mode !== "explore" && data.mode !== "annotate")) return;
    parentOrigin = event.origin;
    mode = data.mode;
    parent.postMessage({ channel, version, type: "probe_ready", revision }, parentOrigin);
  });
  addEventListener("pointermove", (event) => { if (mode === "annotate" && event.target instanceof Element) send("target_preview", event.target); }, { passive: true });
  addEventListener("pointerleave", () => { if (mode === "annotate") send("target_cleared"); }, { passive: true });
  addEventListener("click", (event) => {
    if (mode !== "annotate" || !(event.target instanceof Element)) return;
    event.preventDefault(); event.stopImmediatePropagation(); send("target_selected", event.target);
  }, true);
  addEventListener("keydown", (event) => {
    if (mode !== "annotate" || event.key !== "Enter" || !(event.target instanceof Element)) return;
    event.preventDefault(); event.stopImmediatePropagation(); send("target_selected", event.target);
  }, true);
})();`);

export interface ReviewAsset {
  readonly body: Buffer;
  readonly contentType: string;
}

export const reviewAssets = {
  shellHtml: {
    body: Buffer.from(shellHtml),
    contentType: "text/html; charset=utf-8",
  },
  shellCss: {
    body: Buffer.from(shellCss),
    contentType: "text/css; charset=utf-8",
  },
  shellJs: {
    body: Buffer.from(shellJs),
    contentType: "text/javascript; charset=utf-8",
  },
  probeJs: {
    body: Buffer.from(probeJs),
    contentType: "text/javascript; charset=utf-8",
  },
} as const satisfies Record<string, ReviewAsset>;
