# Browser-origin validation

Validated on 2026-07-15 with Playwright 1.61.1 (Chromium) and independently
installed `agent-browser` 0.31.2. Both controllers consumed an ordinary HTTP
URL; neither supplies serving behavior to `htmlview`.

## Direct-file fixture matrix

| Case | Direct `file://` | Loopback HTTP |
| --- | --- | --- |
| Root-relative stylesheet | Missing (`file:///assets/...`) | Loaded from the granted root |
| JavaScript dynamic module | Blocked by file-origin CORS | Loaded with JavaScript MIME |
| Relative `fetch` with a space | Rejected for the file scheme | `200` JSON response |
| Space and Unicode entry/module paths | Entry opens; module is blocked | Both paths load |
| Unreferenced hidden in-root file | File-scheme fetch rejected | Readable by same-origin page code |

The last row proves that the selected root, not the entry or its authored
references, is the disclosure boundary.

## Browser-state evidence

- Three simultaneous listeners on `127.0.0.1` and different ports receive the
  same overlapping cookie, including the listener representing an unrelated
  service.
- Reusing an exact hostname and port after stopping its server revives its
  cookie, local storage value, cached response, and service-worker response.
- Reusing the port with a fresh `.localhost` label exposes none of that state.
  The new server receives both cache and service-worker probe requests.
- Chromium rejects a cookie scoped as `Domain=localhost`, so one session label
  cannot create a parent-domain cookie visible to another label.
- Binding arbitrary `127/8` addresses is not portable: macOS rejected
  `127.0.0.2` with `EADDRNOTAVAIL` unless the machine's loopback interface is
  mutated, so per-session numeric addresses were rejected.

Run `npm run validate:browser-origin` for the state and direct-file matrix and
`npm run validate:agent-browser` for the second-controller HTTP check.
