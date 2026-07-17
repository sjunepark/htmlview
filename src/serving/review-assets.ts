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
      <button id="mode-annotate" type="button" aria-pressed="true" disabled>Annotate</button>
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
    <aside id="drafts" data-open="true" aria-label="Annotation drafts">
      <div class="draft-heading">
        <div><h1>Review notes</h1><p>Saved privately until you send them.</p></div>
        <button id="freeform" class="quiet" type="button" disabled>Page note</button>
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
  const version = 2;
  const maximumEntryNavigationAttempts = 3;
  const maximumEntryPollFailures = 3;
  const entryPollRequestTimeoutMilliseconds = 2000;
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
  const annotateButton = byId("mode-annotate");
  const freeformButton = byId("freeform");
  const encoder = new TextEncoder();
  let state;
  let contentOrigin;
  let mode = "annotate";
  let revision;
  let activeProbeLease;
  let selectedTarget;
  let editorGeneration = 0;
  let editorDirty = false;
  let editorSaving = false;
  let draftSaveInFlight = false;
  let readyTimer;
  let readyInterval;
  let readyIntervalTimer;
  let navigationPending = false;
  let navigationInFlight = false;
  let pendingNavigationLoad;
  let entryPollTimer;
  let entryPollController;
  let entryPollEpoch = 0;
  let entryPollFailures = 0;
  let entryPollPhase = "active";
  let reviewConnectionClosed = false;
  let entryAvailable = true;
  let entryLimitation;
  let observedEntryRevision;
  let entryNavigationRevision;
  let entryNavigationAttempts = 0;
  let localLimitation;
  let loadGeneration = 0;
  let pendingTargetMessage;
  let targetMessageFrame;
  let selectionTokens = 8;
  let selectionRefillAt = performance.now();
  const activatingProbeLeases = new Set();
  const usedProbeLeases = new Set();

  const announce = (message) => {
    if (!reviewConnectionClosed) live.textContent = message;
  };
  const exactKeys = (value, keys) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    let count = 0;
    for (const key in value) {
      if (!Object.hasOwn(value, key)) continue;
      count += 1;
      if (count > keys.length || !keys.includes(key)) return false;
    }
    return count === keys.length;
  };
  const bounded = (value, bytes, nonempty = true) =>
    typeof value === "string" && (!nonempty || value.length > 0) && value.length <= bytes && encoder.encode(value).length <= bytes;
  const validAnchor = (anchor) => {
    if (!anchor || typeof anchor !== "object" || Array.isArray(anchor)) return false;
    if (!exactKeys(anchor, ["dom_path", "selector", "tag"]) && !exactKeys(anchor, ["dom_path", "selector", "tag", "text"])) return false;
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

  function publicDraft(draft, selected) {
    const row = document.createElement("label");
    row.className = "draft";
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = selected ?? true;
    checkbox.disabled = reviewConnectionClosed;
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

  function limitationReason() {
    return entryLimitation || localLimitation || state?.limitation;
  }

  function clearPendingTargetMessages() {
    pendingTargetMessage = undefined;
    if (targetMessageFrame !== undefined) cancelAnimationFrame(targetMessageFrame);
    targetMessageFrame = undefined;
  }

  function resetEditor() {
    editorGeneration += 1;
    editorDirty = false;
    editorSaving = false;
    selectedTarget = undefined;
    editor.hidden = true;
    highlight.removeAttribute("data-visible");
  }

  function cancelEditor() {
    if (draftSaveInFlight) {
      announce("Wait for the current draft save to finish");
      return;
    }
    resetEditor();
  }

  function entryRevisionPending() {
    return (
      entryNavigationAttempts > 0 &&
      entryNavigationRevision !== undefined &&
      entryNavigationRevision !== revision
    );
  }

  function suspendEntryPolling(phase) {
    if (entryPollPhase === "terminal") return;
    entryPollPhase = phase;
    entryPollEpoch += 1;
    clearTimeout(entryPollTimer);
    entryPollTimer = undefined;
    entryPollController?.abort();
    entryPollController = undefined;
  }

  function terminateReviewConnection(statusMessage, announcement) {
    if (entryPollPhase === "terminal") return;
    suspendEntryPolling("terminal");
    entryPollPhase = "terminal";
    reviewConnectionClosed = true;
    clearTimeout(readyTimer);
    stopModeRetry();
    clearPendingTargetMessages();
    resetEditor();
    byId("end-confirm").hidden = true;
    byId("send").disabled = true;
    byId("end").disabled = true;
    byId("queue-comment").disabled = true;
    for (const input of draftList.querySelectorAll('input[type="checkbox"]'))
      input.disabled = true;
    status.textContent = statusMessage;
    renderLimitation();
    live.textContent = announcement;
  }

  function renderAnnotationAvailability() {
    const unavailable = reviewConnectionClosed || !revision || !entryAvailable || navigationInFlight || entryRevisionPending() || Boolean(limitationReason());
    annotateButton.disabled = unavailable;
    freeformButton.disabled = unavailable || draftSaveInFlight;
    byId("mode-explore").disabled = reviewConnectionClosed || draftSaveInFlight;
    if (unavailable) {
      clearPendingTargetMessages();
      resetEditor();
    }
  }

  function renderLimitation() {
    const reason = limitationReason();
    limitation.hidden = !reviewConnectionClosed && entryAvailable && !reason;
    if (reviewConnectionClosed)
      limitation.textContent = "Review connection closed. Ask for a new review link to continue. The last rendered version remains visible.";
    else if (!entryAvailable && !entryLimitation)
      limitation.textContent = "The review entry is temporarily unavailable. The last rendered version remains visible.";
    else if (reason)
      limitation.textContent = \`This page cannot be annotated: \${reason.replaceAll("_", " ")}. The raw page remains available.\`;
    renderAnnotationAvailability();
  }

  function stopModeRetry() {
    clearInterval(readyInterval);
    clearTimeout(readyIntervalTimer);
    readyInterval = undefined;
    readyIntervalTimer = undefined;
  }

  function render() {
    const selectedDrafts = new Map(
      [...draftList.querySelectorAll('input[type="checkbox"]')].map((input) => [input.dataset.id, input.checked]),
    );
    if (!reviewConnectionClosed)
      status.textContent = state.review.status === "ready" ? "Annotation review" : \`Review \${state.review.status}\`;
    draftCount.textContent = String(state.drafts.length);
    draftList.replaceChildren(...state.drafts.map((draft) => publicDraft(draft, selectedDrafts.get(draft.id))));
    emptyDrafts.hidden = state.drafts.length !== 0;
    byId("send").disabled = reviewConnectionClosed || state.drafts.length === 0;
    byId("end").disabled =
      reviewConnectionClosed || state.review.status !== "ready" || draftSaveInFlight;
    byId("queue-comment").disabled =
      reviewConnectionClosed || draftSaveInFlight;
    renderLimitation();
  }

  async function refresh(expectedLoadGeneration) {
    const nextState = await api("/.htmlview/api/state");
    if (reviewConnectionClosed || (expectedLoadGeneration !== undefined && expectedLoadGeneration !== loadGeneration)) return;
    state = nextState;
    contentOrigin = new URL(state.content_url).origin;
    render();
    if (!iframe.hasAttribute("src")) await navigate();
  }

  async function navigate(expectedRevision) {
    if (reviewConnectionClosed) return;
    navigationInFlight = true;
    if (expectedRevision !== undefined) {
      if (entryNavigationRevision !== expectedRevision)
        entryNavigationAttempts = 0;
      entryNavigationRevision = expectedRevision;
      entryNavigationAttempts += 1;
    }
    clearPendingTargetMessages();
    resetEditor();
    renderAnnotationAvailability();
    try {
      const navigation = await api("/.htmlview/api/navigation", {
        method: "POST",
        body: JSON.stringify(
          expectedRevision === undefined
            ? {}
            : { expected_revision: expectedRevision },
        ),
      });
      if (reviewConnectionClosed) return;
      clearTimeout(readyTimer);
      stopModeRetry();
      pendingNavigationLoad =
        expectedRevision === undefined
          ? undefined
          : {
              revision: expectedRevision,
              attempt: entryNavigationAttempts,
            };
      iframe.src = navigation.navigation_url;
    } catch (error) {
      navigationInFlight = false;
      if (
        expectedRevision !== undefined &&
        entryNavigationAttempts >= maximumEntryNavigationAttempts
      ) {
        localLimitation = "instrumentation_unavailable";
        renderLimitation();
        announce("Updated review could not be loaded");
      } else renderAnnotationAvailability();
      throw error;
    }
  }

  async function pollEntry() {
    if (entryPollPhase !== "active" || entryPollController !== undefined) return;
    const epoch = entryPollEpoch;
    const controller = new AbortController();
    entryPollController = controller;
    const requestTimeout = setTimeout(
      () => controller.abort(),
      entryPollRequestTimeoutMilliseconds,
    );
    let validResponse = false;
    try {
      const result = await api("/.htmlview/api/entry", {
        signal: controller.signal,
      });
      if (epoch !== entryPollEpoch || entryPollPhase !== "active") return;
      const entry = result.entry;
      const checking =
        exactKeys(entry, ["availability"]) &&
        entry.availability === "checking";
      const unavailable =
        exactKeys(entry, ["availability"]) &&
        entry.availability === "unavailable";
      const unsupported =
        exactKeys(entry, ["availability", "limitation"]) &&
        entry.availability === "unsupported" &&
        entry.limitation === "entry_too_large";
      const available =
        exactKeys(entry, ["availability", "revision"]) &&
        entry.availability === "available" &&
        /^sha256:[0-9a-f]{64}$/.test(entry.revision || "");
      if (!checking && !unavailable && !unsupported && !available)
        throw new TypeError("Invalid review entry observation");
      validResponse = true;
      entryPollFailures = 0;
      if (checking) return;
      if (unavailable) {
        entryAvailable = false;
        entryLimitation = undefined;
        entryNavigationRevision = undefined;
        entryNavigationAttempts = 0;
        clearPendingTargetMessages();
        resetEditor();
        renderLimitation();
        announce("Review entry unavailable · showing last rendered version");
        return;
      }
      if (unsupported) {
        entryAvailable = false;
        entryLimitation = entry.limitation;
        entryNavigationRevision = undefined;
        entryNavigationAttempts = 0;
        clearPendingTargetMessages();
        resetEditor();
        renderLimitation();
        announce("Review entry cannot currently be instrumented");
        return;
      }
      const wasAvailable = entryAvailable;
      const observedRevisionChanged =
        observedEntryRevision === undefined
          ? !wasAvailable ||
            Boolean(state?.limitation) ||
            (revision !== undefined && revision !== entry.revision)
          : observedEntryRevision !== entry.revision;
      const canSupersedeLimitedNavigation =
        observedRevisionChanged &&
        (!wasAvailable || Boolean(state?.limitation));
      entryAvailable = true;
      entryLimitation = undefined;
      if (revision === entry.revision) {
        observedEntryRevision = entry.revision;
        entryNavigationRevision = entry.revision;
        entryNavigationAttempts = 0;
        renderLimitation();
        if (!wasAvailable) {
          announce("Annotation tools ready");
          sendMode();
        }
        return;
      }
      if (entryNavigationRevision !== entry.revision) {
        entryNavigationRevision = entry.revision;
        entryNavigationAttempts = 0;
      }
      if (!observedRevisionChanged && entryNavigationAttempts === 0) {
        observedEntryRevision = entry.revision;
        renderLimitation();
        return;
      }
      if (
        !iframe.hasAttribute("src") ||
        (navigationInFlight && !canSupersedeLimitedNavigation) ||
        entryNavigationAttempts >= maximumEntryNavigationAttempts
      ) {
        if (!observedRevisionChanged) observedEntryRevision = entry.revision;
        renderLimitation();
        return;
      }
      observedEntryRevision = entry.revision;
      localLimitation = undefined;
      renderLimitation();
      announce("Loading updated review");
      await navigate(entry.revision);
    } catch {
      if (
        !validResponse &&
        epoch === entryPollEpoch &&
        entryPollPhase === "active"
      ) {
        entryPollFailures += 1;
        if (entryPollFailures >= maximumEntryPollFailures)
          terminateReviewConnection(
            "Review unavailable",
            "Review connection closed. Ask for a new review link to continue.",
          );
      }
    } finally {
      clearTimeout(requestTimeout);
      if (entryPollController === controller) entryPollController = undefined;
      if (epoch === entryPollEpoch && entryPollPhase === "active")
        entryPollTimer = setTimeout(pollEntry, 500);
    }
  }

  function sendMode() {
    if (reviewConnectionClosed) return;
    iframe.contentWindow?.postMessage({ channel, version, type: "set_mode", mode }, contentOrigin);
  }

  function setMode(next) {
    if (reviewConnectionClosed) return;
    if (next === "explore" && (draftSaveInFlight || (!editor.hidden && (editorDirty || editorSaving)))) {
      announce("Save or cancel the current comment before exploring");
      return;
    }
    mode = next;
    byId("mode-explore").setAttribute("aria-pressed", String(next === "explore"));
    byId("mode-annotate").setAttribute("aria-pressed", String(next === "annotate"));
    if (next === "explore") {
      clearPendingTargetMessages();
      resetEditor();
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
    if (reviewConnectionClosed || draftSaveInFlight) return false;
    if (!editor.hidden) {
      if (editorDirty || editorSaving) return false;
      selectedTarget = target;
      targetLabel.textContent = target ? \`\${target.anchor.tag} · untrusted page context\` : "Page feedback";
      return true;
    }
    editorGeneration += 1;
    editorDirty = false;
    editorSaving = false;
    selectedTarget = target;
    targetLabel.textContent = target ? \`\${target.anchor.tag} · untrusted page context\` : "Page feedback";
    comment.value = "";
    editor.hidden = false;
    comment.focus();
    return true;
  }

  async function activateProbe(data) {
    if (reviewConnectionClosed || revision !== undefined || activatingProbeLeases.has(data.lease) || usedProbeLeases.has(data.lease) || activatingProbeLeases.size >= 8) return;
    const generation = loadGeneration;
    activatingProbeLeases.add(data.lease);
    try {
      const result = await api("/.htmlview/api/probe", { method: "POST", body: JSON.stringify({ lease: data.lease }) });
      usedProbeLeases.add(data.lease);
      if (usedProbeLeases.size > 8) usedProbeLeases.delete(usedProbeLeases.values().next().value);
      if (reviewConnectionClosed || generation !== loadGeneration || result.revision !== data.revision || !/^sha256:[0-9a-f]{64}$/.test(result.revision || "")) return;
      revision = result.revision;
      activeProbeLease = data.lease;
      navigationPending = false;
      navigationInFlight = false;
      entryNavigationRevision = result.revision;
      entryNavigationAttempts = 0;
      localLimitation = undefined;
      if (state) delete state.limitation;
      clearTimeout(readyTimer);
      stopModeRetry();
      announce("Annotation tools ready");
      sendMode();
      renderLimitation();
    } catch {
      // Forged, stale, and replayed leases fail closed without changing the shell.
    } finally {
      activatingProbeLeases.delete(data.lease);
    }
  }

  function annotationActive() {
    return !reviewConnectionClosed && mode === "annotate" && entryAvailable && !navigationInFlight && !entryRevisionPending() && revision !== undefined && activeProbeLease !== undefined && !limitationReason();
  }

  function takeSelectionToken() {
    const now = performance.now();
    selectionTokens = Math.min(8, selectionTokens + (now - selectionRefillAt) / 125);
    selectionRefillAt = now;
    if (selectionTokens < 1) return false;
    selectionTokens -= 1;
    return true;
  }

  function flushTargetMessage() {
    targetMessageFrame = undefined;
    const pending = pendingTargetMessage;
    pendingTargetMessage = undefined;
    if (!pending || pending.generation !== loadGeneration || !annotationActive()) return;
    const data = pending.data;
    if (data.type === "target_cleared") {
      if (exactKeys(data, ["channel", "lease", "revision", "type", "version"]) && editor.hidden) highlight.removeAttribute("data-visible");
      return;
    }
    if (data.type === "target_preview") {
      if (exactKeys(data, ["channel", "handle", "lease", "rect", "revision", "type", "version"]) && bounded(data.handle, 64) && validRect(data.rect) && editor.hidden) placeHighlight(data.rect);
      return;
    }
    if (!exactKeys(data, ["anchor", "channel", "handle", "lease", "rect", "revision", "type", "version"]) || !bounded(data.handle, 64) || !validAnchor(data.anchor) || !validRect(data.rect)) return;
    if (data.type === "target_selected") {
      if (draftSaveInFlight || (!editor.hidden && (editorDirty || editorSaving)) || !takeSelectionToken()) return;
      placeHighlight(data.rect);
      openEditor({ handle: data.handle, anchor: data.anchor });
      return;
    }
  }

  function scheduleTargetMessage(data) {
    if (data.type === "target_selected" || pendingTargetMessage?.data.type !== "target_selected")
      pendingTargetMessage = { data, generation: loadGeneration };
    if (targetMessageFrame === undefined)
      targetMessageFrame = requestAnimationFrame(flushTargetMessage);
  }

  window.addEventListener("message", (event) => {
    if (event.source !== iframe.contentWindow || event.origin !== contentOrigin) return;
    const data = event.data;
    if (!data || data.channel !== channel || data.version !== version || typeof data.type !== "string") return;
    if (data.type === "probe_ready" && exactKeys(data, ["channel", "lease", "revision", "type", "version"]) && /^[0-9a-f]{32}$/.test(data.lease) && /^sha256:[0-9a-f]{64}$/.test(data.revision)) {
      activateProbe(data);
      return;
    }
    if (
      (data.type === "target_preview" || data.type === "target_selected" || data.type === "target_cleared") &&
      annotationActive() &&
      data.lease === activeProbeLease &&
      data.revision === revision
    )
      scheduleTargetMessage(data);
  });

  iframe.addEventListener("load", () => {
    if (reviewConnectionClosed) return;
    const generation = ++loadGeneration;
    const navigationLoad = pendingNavigationLoad;
    pendingNavigationLoad = undefined;
    navigationPending = navigationPending || revision !== undefined;
    revision = undefined;
    activeProbeLease = undefined;
    clearPendingTargetMessages();
    renderAnnotationAvailability();
    resetEditor();
    announce("Loading annotation tools");
    clearTimeout(readyTimer);
    stopModeRetry();
    readyInterval = setInterval(sendMode, 100);
    readyTimer = setTimeout(() => {
      stopModeRetry();
      if (generation !== loadGeneration) return;
      refresh(generation).catch(() => undefined).finally(() => {
        if (generation !== loadGeneration || revision) return;
        navigationInFlight = false;
        if (
          state?.limitation &&
          navigationLoad !== undefined &&
          entryNavigationRevision === navigationLoad.revision &&
          entryNavigationAttempts === navigationLoad.attempt
        )
          entryNavigationAttempts = maximumEntryNavigationAttempts;
        if (!state?.limitation) localLimitation = navigationPending ? "unsupported_navigation" : "instrumentation_unavailable";
        renderLimitation();
      });
    }, 1800);
    readyIntervalTimer = setTimeout(stopModeRetry, 2000);
  });

  async function queueDraft() {
    if (reviewConnectionClosed) return;
    if (draftSaveInFlight) {
      announce("Draft save already in progress");
      return;
    }
    const value = comment.value.trim();
    if (!value || !revision) {
      announce(!revision ? "Wait for the page annotation tools to become ready" : "Enter a comment first");
      return;
    }
    const payload = selectedTarget ? { kind: "element", comment: value, revision, anchor: selectedTarget.anchor } : { kind: "freeform", comment: value, revision };
    const generation = editorGeneration;
    draftSaveInFlight = true;
    editorSaving = true;
    byId("queue-comment").disabled = true;
    render();
    try {
      const committed = await api("/.htmlview/api/drafts", { method: "POST", body: JSON.stringify(payload) });
      if (editorGeneration === generation) resetEditor();
      try {
        await refresh();
        announce("Draft saved privately");
      } catch {
        if (!state.drafts.some((draft) => draft.id === committed.draft.id))
          state = { ...state, drafts: [...state.drafts, committed.draft] };
        announce("Draft saved privately; the draft list could not be refreshed");
      }
    } catch (error) {
      if (editorGeneration === generation) {
        editorSaving = false;
        editorDirty = comment.value.length > 0;
      }
      announce(error.message);
    }
    finally {
      draftSaveInFlight = false;
      render();
    }
  }

  const selectedIds = () => [...draftList.querySelectorAll('input[type="checkbox"]:checked')].map((input) => input.dataset.id);
  async function publish(end, discardRemaining = false) {
    if (reviewConnectionClosed) return;
    if (end && (draftSaveInFlight || (!editor.hidden && (editorDirty || editorSaving)))) {
      announce("Save or cancel the current comment before ending the review");
      return;
    }
    const ids = selectedIds();
    if (end && !discardRemaining && ids.length !== state.drafts.length) {
      byId("end-confirm").hidden = false;
      return;
    }
    const route = end ? "/.htmlview/api/end" : "/.htmlview/api/send";
    try {
      const result = await api(route, { method: "POST", body: JSON.stringify(end ? { drafts: ids, discard_remaining: discardRemaining } : { drafts: ids }) });
      if (reviewConnectionClosed) return;
      if (end) {
        terminateReviewConnection(
          "Feedback sent · review ended",
          "Feedback sent and review ended",
        );
        draftsPanel.replaceChildren();
      } else {
        state = { ...state, drafts: state.drafts.filter((draft) => !ids.includes(draft.id)) };
        try {
          await refresh();
          announce(\`\${result.sent} draft\${result.sent === 1 ? "" : "s"} sent\`);
        } catch {
          render();
          announce(\`\${result.sent} draft\${result.sent === 1 ? "" : "s"} sent; the draft list could not be refreshed\`);
        }
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
  byId("freeform").addEventListener("click", () => {
    if (!openEditor(undefined))
      announce(draftSaveInFlight ? "Wait for the current draft save to finish" : "Save or cancel the current comment first");
  });
  byId("cancel-comment").addEventListener("click", cancelEditor);
  byId("queue-comment").addEventListener("click", queueDraft);
  byId("send").addEventListener("click", () => publish(false));
  byId("end").addEventListener("click", () => publish(true));
  byId("discard-and-end").addEventListener("click", () => publish(true, true));
  byId("cancel-end").addEventListener("click", () => { byId("end-confirm").hidden = true; });
  comment.addEventListener("keydown", (event) => {
    if (event.key === "Escape") cancelEditor();
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) { event.preventDefault(); queueDraft(); }
  });
  comment.addEventListener("input", () => {
    editorDirty = comment.value.length > 0;
  });
  window.addEventListener("resize", () => highlight.removeAttribute("data-visible"));
  window.addEventListener("pagehide", () => {
    if (entryPollPhase === "active") suspendEntryPolling("paused");
  });
  window.addEventListener("pageshow", () => {
    if (entryPollPhase !== "paused") return;
    entryPollPhase = "active";
    entryPollFailures = 0;
    pollEntry();
  });
  refresh()
    .then(pollEntry)
    .catch((error) => { limitation.hidden = false; limitation.textContent = error.message; });
})();`);

function probeJavaScript(lease: string): string {
  if (!/^[0-9a-f]{32}$/.test(lease))
    throw new TypeError("Invalid review probe lease");
  return embeddedJavaScript(String.raw`(() => {
  "use strict";
  const channel = "htmlview.review";
  const version = 2;
  const lease = "${lease}";
  const trustedWindow = window;
  const trustedParent = window.parent;
  const trustedAddEventListener = window.addEventListener;
  const trustedPostMessage = window.postMessage;
  const trustedApply = Reflect.apply;
  const trustedHistory = window.history;
  const trustedReplaceState = trustedHistory.replaceState;
  const trustedLocation = window.location;
  try {
    trustedApply(trustedReplaceState, trustedHistory, [trustedHistory.state, "", trustedLocation.pathname + trustedLocation.hash]);
  } catch {
    return;
  }
  const script = document.currentScript;
  const revision = script?.dataset.htmlviewRevision;
  if (!/^sha256:[0-9a-f]{64}$/.test(revision || "")) return;
  const encoder = new TextEncoder();
  const excludedTextElements = new Set(["INPUT", "TEXTAREA", "SELECT", "OPTION", "SCRIPT", "STYLE", "TEMPLATE"]);
  let parentOrigin;
  let mode = "annotate";
  let sequence = 0;
  let pendingPreviewElement;
  let previewFrame;
  let documentLoaded = document.readyState === "complete";
  const listen = (type, listener, options) => trustedApply(trustedAddEventListener, trustedWindow, [type, listener, options]);
  const postToParent = (data, origin) => trustedApply(trustedPostMessage, trustedParent, [data, origin]);
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
    let visitedNodes = 0;
    let inspectedCharacters = 0;
    while (complete) {
      const node = walker.nextNode();
      if (!node) break;
      visitedNodes += 1;
      if (visitedNodes > 4096) break;
      for (const character of node.nodeValue || "") {
        inspectedCharacters += 1;
        if (inspectedCharacters > 8192) { complete = false; break; }
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
  const siblingPosition = (element) => {
    let position = 1;
    let scanned = 0;
    for (let sibling = element.previousElementSibling; sibling; sibling = sibling.previousElementSibling) {
      scanned += 1;
      if (scanned > 2048) return undefined;
      if (sibling.tagName === element.tagName) position += 1;
    }
    return position;
  };
  const segment = (element) => {
    const tag = element.tagName.toLowerCase();
    const position = siblingPosition(element);
    return position === undefined ? tag : \`\${tag}:nth-of-type(\${position})\`;
  };
  const anchorFor = (element) => {
    const elements = [];
    for (let current = element; current && current.nodeType === Node.ELEMENT_NODE && elements.length < 12; current = current.parentElement) elements.unshift(current);
    const dom = elements.map((current) => {
      const position = siblingPosition(current);
      return \`\${current.tagName.toLowerCase()}[\${position === undefined ? "?" : position - 1}]\`;
    }).join("/");
    const selector = element.id ? \`#\${CSS.escape(truncate(element.id, 2048))}\` : elements.map(segment).join(" > ");
    const text = normalizedText(element);
    return {
      selector: truncate(selector, 2048),
      dom_path: truncate(dom, 4096),
      tag: truncate(element.tagName.toLowerCase(), 128),
      ...(text === undefined ? {} : { text }),
    };
  };
  const sendSelection = (element) => {
    if (!parentOrigin) return;
    const rect = element.getBoundingClientRect();
    postToParent({ channel, version, type: "target_selected", handle: \`target-\${++sequence}\`, lease, revision, anchor: anchorFor(element), rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height } }, parentOrigin);
  };
  const schedulePreview = (element) => {
    pendingPreviewElement = element;
    if (previewFrame !== undefined) return;
    previewFrame = requestAnimationFrame(() => {
      previewFrame = undefined;
      const preview = pendingPreviewElement;
      pendingPreviewElement = undefined;
      if (!parentOrigin || !preview || mode !== "annotate") return;
      const rect = preview.getBoundingClientRect();
      postToParent({ channel, version, type: "target_preview", handle: \`target-\${++sequence}\`, lease, revision, rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height } }, parentOrigin);
    });
  };
  listen("message", (event) => {
    const data = event.data;
    if (!event.isTrusted || event.source !== trustedParent || !data || data.channel !== channel || data.version !== version || data.type !== "set_mode" || (data.mode !== "explore" && data.mode !== "annotate")) return;
    parentOrigin = event.origin;
    mode = data.mode;
    if (!documentLoaded) return;
    postToParent({ channel, version, type: "probe_ready", lease, revision }, parentOrigin);
  });
  listen("load", () => { documentLoaded = true; }, { once: true });
  listen("pointermove", (event) => { if (event.isTrusted && mode === "annotate" && event.target instanceof Element) schedulePreview(event.target); }, { passive: true });
  listen("pointerleave", (event) => {
    if (!event.isTrusted || mode !== "annotate" || !parentOrigin) return;
    pendingPreviewElement = undefined;
    postToParent({ channel, version, type: "target_cleared", lease, revision }, parentOrigin);
  }, { passive: true });
  listen("click", (event) => {
    if (!event.isTrusted || mode !== "annotate" || !(event.target instanceof Element)) return;
    event.preventDefault(); event.stopImmediatePropagation(); sendSelection(event.target);
  }, true);
  const blockAuthoredKeyInput = (event) => {
    if (!event.isTrusted || mode !== "annotate") return;
    event.stopImmediatePropagation();
    if (event.type === "keydown" && (event.key === "Enter" || event.key === " ") && event.target instanceof Element) {
      event.preventDefault(); sendSelection(event.target); return;
    }
    if (event.type !== "keydown" || event.key !== "Tab") event.preventDefault();
  };
  listen("keydown", blockAuthoredKeyInput, true);
  listen("keypress", blockAuthoredKeyInput, true);
  listen("keyup", blockAuthoredKeyInput, true);
  listen("beforeinput", (event) => {
    if (!event.isTrusted || mode !== "annotate") return;
    event.preventDefault(); event.stopImmediatePropagation();
  }, true);
})();`);
}

export interface ReviewAsset {
  readonly body: Buffer;
  readonly contentType: string;
}

export function reviewProbeAsset(lease: string): ReviewAsset {
  return {
    body: Buffer.from(probeJavaScript(lease)),
    contentType: "text/javascript; charset=utf-8",
  };
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
} as const satisfies Record<string, ReviewAsset>;
