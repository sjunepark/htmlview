import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, it } from "vitest";
import {
  maximumInstrumentedEntryBytes,
  reviewProbePath,
  transformReviewEntry,
} from "../src/serving/instrumented-entry.js";

const contentOrigin = `http://c-${"0".repeat(32)}.localhost:4321`;
const insertedTag = (revision: string) =>
  `<script src="${contentOrigin}${reviewProbePath}" data-htmlview-revision="${revision}"></script>`;

function instrumented(source: Buffer | string) {
  const bytes = typeof source === "string" ? Buffer.from(source) : source;
  const result = transformReviewEntry(bytes, contentOrigin);
  if (result.outcome !== "instrumented") throw new Error(result.reason);
  return { source: bytes, ...result };
}

function unsupported(source: Buffer | string, reason: string): void {
  const result = transformReviewEntry(
    typeof source === "string" ? Buffer.from(source) : source,
    contentOrigin,
  );
  assert.deepEqual(result, { outcome: "unsupported", reason });
}

describe("instrumented review entry transform", () => {
  it("inserts one external probe without changing any authored byte", () => {
    const original = Buffer.from(
      "<!doctype html>\r\n<html><head><title>한글</title></head><body>café</body></html>",
    );
    const result = instrumented(original);
    const expectedRevision = `sha256:${createHash("sha256").update(original).digest("hex")}`;
    assert.equal(result.revision, expectedRevision);
    const tag = Buffer.from(insertedTag(expectedRevision));
    const offset = result.body.indexOf(tag);
    assert.notEqual(offset, -1);
    assert.deepEqual(
      Buffer.concat([
        result.body.subarray(0, offset),
        result.body.subarray(offset + tag.length),
      ]),
      original,
    );
    assert.equal(
      result.body.subarray(offset + tag.length).toString(),
      "</body></html>",
    );
    assert.equal(result.body.indexOf(tag, offset + 1), -1);
  });

  it("preserves a UTF-8 BOM and maps Unicode source offsets to bytes", () => {
    const original = Buffer.concat([
      Buffer.from([0xef, 0xbb, 0xbf]),
      Buffer.from("<!doctype html><p>🙂 selected</p>"),
    ]);
    const result = instrumented(original);
    assert.deepEqual(result.body.subarray(0, 3), original.subarray(0, 3));
    assert.equal(
      result.body.subarray(3, original.length).includes(Buffer.from("🙂")),
      true,
    );
    assert.equal(result.body.subarray(-9).toString(), "</script>");
  });

  it("uses parser locations instead of body-like text in raw and inert content", () => {
    for (const source of [
      '<!doctype html><body><script>const x = "</body>"</script><p>ok</p></body>',
      "<!doctype html><body><!-- </body> --><p>ok</p></body>",
      '<!doctype html><body><textarea></body></textarea><p data-x="</body>">ok</p></body>',
      "<!doctype html><body><template><p>inert</p></template><svg><text>ok</text></svg></body>",
      "<!doctype html><BoDy><p>mixed</p></bOdY>",
    ]) {
      const result = instrumented(source);
      assert.match(
        result.body.toString(),
        /<script src="http:\/\/c-0{32}\.localhost:4321\/\.htmlview\/probe\.js"/,
      );
      assert.match(result.body.toString(), /<\/script><\/b[oO][dD][yY]>$/i);
    }
  });

  it("supports ordinary fragments and recoverable omitted end tags", () => {
    for (const source of [
      "<!doctype html><p>fragment",
      "<html><head></head><body><div>open",
      "<p>one<p>two",
    ]) {
      const result = instrumented(source);
      assert.equal(
        result.body.subarray(0, Buffer.byteLength(source)).toString(),
        source,
      );
      assert.equal(result.body.toString().endsWith("</script>"), true);
    }
  });

  it("uses an absolute content-origin probe URL despite an authored base", () => {
    const result = instrumented(
      '<!doctype html><head><base href="https://attacker.example/"></head><body>safe</body>',
    );
    assert.match(
      result.body.toString(),
      new RegExp(
        `<script src="${contentOrigin.replaceAll(".", "\\.")}\\/\\.htmlview\\/probe\\.js"`,
      ),
    );
    assert.doesNotMatch(
      result.body.toString(),
      /<script src="\/\.htmlview\/probe\.js"/,
    );
  });

  it("rejects unsupported byte encodings and declared charsets", () => {
    unsupported(Buffer.from([0xff, 0xfe, 0x3c, 0x00]), "unsupported_encoding");
    unsupported(Buffer.from([0xc3, 0x28]), "unsupported_encoding");
    unsupported("<!doctype html><body>\0</body>", "unsupported_encoding");
    unsupported(
      '<!doctype html><head><meta charset="windows-1252"></head><body></body>',
      "unsupported_encoding",
    );
    unsupported(
      '<!doctype html><head><meta http-equiv="content-type" content="text/html; charset=iso-8859-1"></head>',
      "unsupported_encoding",
    );
  });

  it("preserves CSP and instruments only when same-origin external scripts are clear", () => {
    for (const policy of [
      "default-src 'self'",
      "default-src 'none'; script-src 'self'",
      "script-src-elem http:",
      "img-src 'none'",
      "sandbox",
    ]) {
      const source = `<!doctype html><head><meta http-equiv="Content-Security-Policy" content="${policy}"></head><body></body>`;
      const result = instrumented(source);
      assert.equal(result.body.toString().includes(policy), true);
    }
    for (const policy of [
      "default-src 'none'",
      "script-src 'none'",
      "script-src 'nonce-test'",
      "script-src 'self' 'strict-dynamic'",
    ])
      unsupported(
        `<!doctype html><head><meta http-equiv="Content-Security-Policy" content="${policy}"></head><body></body>`,
        "csp_blocked",
      );
  });

  it("ignores policy and charset metadata inside inert templates", () => {
    instrumented(
      '<!doctype html><head><template><meta charset="windows-1252"><meta http-equiv="Content-Security-Policy" content="script-src \'none\'"></template></head><body></body>',
    );
  });

  it("rejects markup where an appended script is ambiguous, inert, or duplicated", () => {
    for (const source of [
      "<!doctype html><frameset><frame></frameset>",
      "<!doctype html><plaintext>everything is text",
      "<!doctype html><body><script>unterminated",
      "<!doctype html><body><noscript>unterminated",
      "<!doctype html><body><!-- unterminated",
      '<!doctype html PUBLIC "unterminated',
      '<!doctype html><body><div class="unterminated',
      "<!doctype html><body><template>unterminated",
      "<!doctype html><body><svg><text>unterminated",
      `<!doctype html><body><script src="${reviewProbePath}"></script></body>`,
    ])
      unsupported(source, "unsupported_markup");
  });

  it("handles adversarial depth without recursive tree walking", () => {
    const source = `<!doctype html>${"<div>".repeat(5_000)}deep`;
    const result = instrumented(source);
    assert.equal(result.body.toString().startsWith(source), true);
  });

  it("accepts the exact size boundary and rejects one byte beyond it", () => {
    const exact = instrumented(
      Buffer.alloc(maximumInstrumentedEntryBytes, 0x20),
    );
    assert.equal(exact.source.length, maximumInstrumentedEntryBytes);
    unsupported(
      Buffer.alloc(maximumInstrumentedEntryBytes + 1, 0x20),
      "entry_too_large",
    );
  });
});
