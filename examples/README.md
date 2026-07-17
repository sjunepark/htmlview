# Examples

These committed examples are both runnable demonstrations and black-box E2E
fixtures. From a source checkout, install dependencies and try one at a time:

```sh
pnpm install --frozen-lockfile
pnpm example:standalone
pnpm example:relative
pnpm example:root
pnpm example:review
```

Each command builds the current source and prints indented JSON containing a
ready, directly copyable `.localhost` URL.
The examples use dedicated per-user, per-checkout private state under the
operating system's temporary directory, isolated from ordinary htmlview
sessions and other checkouts. List or stop only this checkout's example
sessions with:

```sh
pnpm example:list
pnpm example:stop
```

`example:standalone` grants only its single-file fixture directory.

`example:relative` demonstrates relative CSS, SVG, JavaScript module, and JSON
requests. Edit `relative/data/message.json` and reload its URL to see source
changes without restarting htmlview.

`example:review` serves the relative fixture, creates or resumes its annotation
review, and prints the review URL plus both the review and raw-session IDs. Open
the review URL in a browser, then select elements or add page notes. Editing
`relative/index.html` automatically reloads only the instrumented review frame.

The wrappers keep their temporary private state internal. Use the feedback
wrapper to read or wait on the review returned by `example:review`:

```sh
review_result="$(pnpm --silent example:review)"
review_url="$(printf '%s' "$review_result" | node -e 'const v=JSON.parse(require("fs").readFileSync(0,"utf8")); process.stdout.write(v.review.url)')"
review_id="$(printf '%s' "$review_result" | node -e 'const v=JSON.parse(require("fs").readFileSync(0,"utf8")); process.stdout.write(v.review.id)')"
printf 'Open this URL in any browser: %s\n' "$review_url"
feedback_result="$(pnpm --silent example:feedback --wait --json "$review_id")"
printf '%s\n' "$feedback_result"
pnpm example:stop
```

Use **Send selected** to keep an iterative review open. The feedback result's
cursor can be acknowledged while waiting for the next batch:

```sh
cursor="$(printf '%s' "$feedback_result" | node -e 'const v=JSON.parse(require("fs").readFileSync(0,"utf8")); process.stdout.write(String(v.cursor))')"
pnpm --silent example:feedback --after "$cursor" --wait --json "$review_id"
```

`example:root` serves a nested entry with an explicit root. Its root-relative
CSS, JavaScript, and JSON files live outside the entry's parent but inside the
granted directory.
