# ADR 0004: Treat the serving root as a disclosure grant

- Status: Accepted
- Date: 2026-07-15

## Context

An HTML entry commonly needs sibling and root-relative assets. A raw static
service therefore needs a directory root rather than an entry-only allowlist.
Any script running in the served page can make same-origin requests for other
files under that root, including files that the entry did not reference.

Traversal and symlink confinement protect files outside the root. They do not
protect secrets placed inside an authorized root.

## Decision

The canonical serving root is both the routing root and the disclosure grant:
every permitted regular file whose resolved target remains beneath it may be
requested. There is no filename or dotfile denylist in the faithful raw path.

`htmlview serve <entry>` derives the default root from the supplied path's
parent, then canonicalizes that root and the entry independently. If the entry
itself is a symlink whose resolved target escapes the canonical parent, the
request is rejected; the target's parent never becomes an implicit broader
root. `--root <directory>` explicitly selects a different, and potentially
broader, grant that must contain the resolved entry. The CLI returns the exact
resolved root and the grant meaning in every successful `serve` result.

Documentation tells callers to use an isolated artifact directory when the
page is untrusted or the surrounding project contains secrets. No command may
infer a root broader than the entry's parent.

Version one rejects a canonical root equal to or broader than the user's home
directory. It also rejects a root containing htmlview's runtime state
directory. These are root-level authorization constraints, not filename
denylists: directories below the home directory remain ordinary valid grants.

## Consequences

- Relative and root-relative assets work without parsing HTML or predicting
  dynamic requests.
- The authorization boundary is simple enough to explain, test, and enforce.
- A malicious page can read and exfiltrate any permitted file under the chosen
  root. Root selection is therefore a security decision, not a convenience
  default hidden from output.
- Hidden files and sensitive filenames receive no special protection when
  they are inside the selected root.
- Broad home disclosure must be narrowed by moving the entry and assets into a
  dedicated subdirectory; version one has no override for this safety check.

## Rejected alternatives

- **Entry-only serving.** It cannot reliably discover dynamic imports, fetches,
  generated URLs, or root-relative assets without transforming behavior.
- **Implicit project-root discovery.** It silently broadens authority beyond
  the path the caller supplied.
- **Sensitive-filename denylist.** It is incomplete, platform-dependent, and
  conflicts with faithful serving while creating false confidence.
