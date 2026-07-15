# ADR 0001: Separate serving from browser control

- Status: Accepted
- Date: 2026-07-15

## Context

The motivating failure occurs when an agent has a local HTML path but needs a
normal HTTP origin. Browser controllers vary: some reject `file://`, while
others support it directly or behind controller-specific flags. File origins
can still differ from HTTP in root-relative resolution, module loading, fetch
behavior, and security scope.

The product must remain useful across `agent-browser`, Playwright, Chrome
integrations, and future browser tools without treating any one controller's
limitations as its reason to exist.

The same project may later support human annotations, but annotation requires
instrumentation and state that can change page behavior.

## Decision

The core product converts an authorized local HTML entry file into an
unmodified loopback HTTP representation and manages that representation's
lifecycle.

Browser installation, launch, automation, and inspection are external. The
core returns a URL and makes no browser-controller API part of its architecture.
Documentation may use `agent-browser` as one example, but release
interoperability covers at least one other independently supplied controller.
Callers should use direct `file://` navigation when it already provides the
required behavior and safety.

Any future annotation surface is an optional consumer of the faithful serving
core. It may expose a separate instrumented review URL, but the raw URL and raw
handler remain available and unchanged.

## Consequences

- Agents can compose `htmlview` with whichever browser tool is available.
- The product's value is consistent, root-confined HTTP semantics and managed
  lifecycle rather than a workaround for one controller.
- The core can be tested with ordinary HTTP clients and browser-neutral
  fixtures.
- Browser-controller churn does not affect the serving contract.
- The product does not, by itself, prove that a page rendered or behaved
  correctly; callers need a browser tool for that.
- Annotation needs a separate trust and fidelity analysis before it is added.

## Rejected alternatives

- **Embed one browser controller.** This duplicates user-provided tooling and
  couples installation, profiles, and automation policy to a serving utility.
- **Treat annotation as a serving mode.** A mode flag would make the meaning of
  a served URL ambiguous and risks accidental instrumentation of agent
  inspection.
- **Open `file://` directly for every case.** This remains inconsistent across
  browser tools and does not provide the selected HTTP semantics. It is still
  the preferred simpler path when its behavior is sufficient.
- **Wrap one controller's local-file flag.** This would be smaller, but it
  would not provide browser-neutral HTTP semantics or a confined serving root.
