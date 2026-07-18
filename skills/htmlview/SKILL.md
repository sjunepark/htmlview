---
name: htmlview
description: "Manual htmlview workflow for serving and reviewing local HTML; use only when the user explicitly invokes $htmlview."
---

# htmlview

## CLI authority

Before constructing a command, run `htmlview <command> --help` and derive its
syntax and flags from that output. Run `htmlview --help` first when the request
does not identify a command. The live CLI is the source of truth for the
installed version.

Use an installed `htmlview` executable. If it is unavailable, report the
prerequisite. For the unpublished `0.1.0` candidate, require a source checkout
and use its candidate-tarball installation flow. Only after publication should
you suggest `npm install --global @sejunpark/htmlview`. Use default TOON for
direct agent reading and `--json` when shell code must extract fields. Treat
stdout as the single domain result and stderr as diagnostics. Continue only
after the executable responds and the relevant help has been inspected.

## Serve and hand off

1. Confirm that the task needs normal HTTP behavior for a local HTML entry,
   such as root-relative assets, modules, fetches, stable origins, readiness, or
   managed lifecycle. Use `file://` when it already satisfies the task and the
   user did not explicitly request htmlview. Route application-server and
   remote-sharing work to a tool that provides those capabilities.
2. Choose the narrowest serving grant. The default is the entry's parent; add
   `--root <directory>` only when required assets need another root and that
   complete disclosure is authorized. Every regular file beneath the grant,
   including hidden and unreferenced files, is browser-readable. For untrusted
   HTML, use an isolated artifact directory plus a disposable browser profile
   and suitable network restrictions.
3. After consulting `htmlview serve --help`, run:

   ```sh
   htmlview serve --json <entry.html>
   ```

   Add the authorized `--root <directory>` only when step 2 requires it. On a
   domain failure, use the structured `error.code` and `help`; on a syntax
   failure, use the native text diagnostic and generated help. Complete this
   step only when `session.status` is `ready` and `grant.root` matches the
   intended disclosure.

4. Pass `session.url` unchanged to the separately supplied browser controller
   or HTTP client and retain `session.id`. Use this raw URL for byte fidelity
   and end-to-end validation. `htmlview` manages serving, not browser
   installation or automation.

Complete the serving branch when the ready raw URL works for the intended
consumer and the returned session ID and grant have been recorded.

## Human review branch

For human annotation, feedback reads or waits, feedback-driven source edits,
cursor acknowledgement, or review deletion, read and follow
[`references/review-loop.md`](references/review-loop.md) before acting.

## Inspect and finish

- Consult the home help and run `htmlview --json` to inspect active sessions and
  retained reviews. Add `--fields entry,root` when path-to-session mapping is
  needed.
- Leave a session live while the user still needs its URL or review. Otherwise,
  consult the stop help and stop only the session created or selected for this
  task. Reserve `htmlview stop --all` for an explicit all-session teardown.
  Stopping preserves review drafts and unacknowledged feedback.
- Report the raw URL, session ID, serving grant, and whether the session remains
  live. Report any retained review that still needs feedback acknowledgement or
  deletion.

Complete the task only when requested browser or review work is validated and
every created htmlview lifecycle is either intentionally live or explicitly
stopped.
