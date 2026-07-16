# Examples

These committed examples are both runnable demonstrations and black-box E2E
fixtures. From a source checkout, install dependencies and try one at a time:

```sh
pnpm install --frozen-lockfile
pnpm example:standalone
pnpm example:relative
pnpm example:root
```

Each command builds the current source and prints indented JSON containing a
ready, directly copyable `.localhost` URL.
The examples use dedicated per-user runtime state under `/tmp`, isolated from
ordinary htmlview sessions. List or stop only the example sessions with:

```sh
pnpm example:list
pnpm example:stop
```

`example:relative` demonstrates relative CSS, SVG, JavaScript module, and JSON
requests. Edit `relative/data/message.json` and reload its URL to see source
changes without restarting htmlview.

`example:root` serves a nested entry with an explicit root. Its root-relative
CSS, JavaScript, and JSON files live outside the entry's parent but inside the
granted directory.
