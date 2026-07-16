# htmlview Domain

`htmlview` gives local HTML two deliberate browser representations: a faithful
serving surface and an optional human-review surface. These terms keep their
different fidelity and lifecycle contracts explicit.

## Language

**Serving grant**:
The canonical directory whose regular files may be disclosed through a raw or
review-content origin. It is canonically disjoint from htmlview private state.
_Avoid_: Project root, asset root

**Raw session**:
A live, root-confined serving lifecycle for one public entry route and serving
grant.
_Avoid_: Review session, server

**Raw URL**:
The byte-faithful URL of a raw session, used as the fidelity and browser-testing
reference.
_Avoid_: Preview URL, review URL

**Review**:
An optional lifecycle attached to a raw session through which a human can send
element-targeted or freeform feedback.
_Avoid_: Mode, annotation session

**Review URL**:
The instrumented URL shared by humans and agents during review. It is not a
fidelity-equivalent replacement for the raw URL.
_Avoid_: Raw URL, preview URL

**Review shell**:
The trusted browser surface that owns annotation controls, drafts, and feedback
submission while displaying review content separately.
_Avoid_: Overlay, injected UI

**Review content**:
The instrumented representation of the selected entry and its granted assets
shown inside the review shell.
_Avoid_: Raw content

**Annotation draft**:
A persisted human comment that has been queued in the review shell but not yet
sent to an agent.
_Avoid_: Feedback, prompt

**Feedback event**:
An immutable sent comment plus its capture-time document revision and optional
element anchor.
_Avoid_: Draft, log entry

**Feedback cursor**:
An ordered stream position returned with a feedback batch and later supplied to
acknowledge that batch. Delivery alone does not acknowledge it.
_Avoid_: Acknowledged cursor, session ID, credential

**Acknowledged cursor**:
The highest feedback cursor the single agent consumer has explicitly
acknowledged for a review.
_Avoid_: Feedback cursor, delivered cursor

**Private state**:
The user-only htmlview directory that owns supervisor control state,
annotations, and bounded diagnostic logs. It is canonically disjoint from every
serving grant.
_Avoid_: Project state, serving root

**Diagnostic log**:
A bounded operational record for troubleshooting foreground commands or the
detached supervisor. It contains allowlisted metadata, never annotation content,
and has no delivery or audit semantics.
_Avoid_: Feedback queue, prompt stream, audit log
