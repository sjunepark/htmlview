import { createHash } from "node:crypto";
import {
  ErrorCodes,
  parse,
  type DefaultTreeAdapterTypes,
  type ParserError,
} from "parse5";

export const reviewProbePathPrefix = "/.htmlview/probe/";
export const maximumInstrumentedEntryBytes = 8 * 1024 * 1024;

export type ReviewEntryLimitation =
  | "entry_too_large"
  | "unsupported_encoding"
  | "unsupported_markup"
  | "csp_blocked";

export type ReviewEntryTransform =
  | {
      readonly outcome: "instrumented";
      readonly body: Buffer;
      readonly revision: `sha256:${string}`;
    }
  | {
      readonly outcome: "unsupported";
      readonly reason: ReviewEntryLimitation;
      readonly revision: `sha256:${string}`;
    };

const utf8Bom = Buffer.from([0xef, 0xbb, 0xbf]);
const fatalParseErrors = new Set<ErrorCodes>([
  ErrorCodes.eofBeforeTagName,
  ErrorCodes.eofInTag,
  ErrorCodes.eofInScriptHtmlCommentLikeText,
  ErrorCodes.eofInComment,
  ErrorCodes.eofInCdata,
  ErrorCodes.eofInDoctype,
  ErrorCodes.eofInElementThatCanContainOnlyText,
  ErrorCodes.unexpectedNullCharacter,
]);
const rawTextElements = new Set([
  "iframe",
  "noembed",
  "noframes",
  "noscript",
  "script",
  "style",
  "textarea",
  "title",
  "xmp",
]);

function pushElementChildren(
  stack: DefaultTreeAdapterTypes.Element[],
  node: DefaultTreeAdapterTypes.ParentNode,
): void {
  for (let index = node.childNodes.length - 1; index >= 0; index -= 1) {
    const child = node.childNodes[index];
    if (child !== undefined && "tagName" in child) stack.push(child);
  }
}

function findElement(
  node: DefaultTreeAdapterTypes.ParentNode,
  tagName: string,
): DefaultTreeAdapterTypes.Element | undefined {
  const stack: DefaultTreeAdapterTypes.Element[] = [];
  pushElementChildren(stack, node);
  while (stack.length > 0) {
    const element = stack.pop();
    if (element === undefined) break;
    if (element.tagName === tagName) return element;
    pushElementChildren(stack, element);
  }
  return undefined;
}

function walkElements(
  node: DefaultTreeAdapterTypes.ParentNode,
  visit: (element: DefaultTreeAdapterTypes.Element) => boolean | void,
  includeTemplateContent = true,
): boolean {
  const stack: DefaultTreeAdapterTypes.Element[] = [];
  pushElementChildren(stack, node);
  while (stack.length > 0) {
    const element = stack.pop();
    if (element === undefined) break;
    if (visit(element) === false) return false;
    if (includeTemplateContent && element.tagName === "template")
      pushElementChildren(
        stack,
        (element as DefaultTreeAdapterTypes.Template).content,
      );
    pushElementChildren(stack, element);
  }
  return true;
}

function attribute(
  element: DefaultTreeAdapterTypes.Element,
  name: string,
): string | undefined {
  return element.attrs.find((candidate) => candidate.name === name)?.value;
}

function declaredEncodingIsUtf8(
  head: DefaultTreeAdapterTypes.Element,
): boolean {
  let supported = true;
  walkElements(
    head,
    (element) => {
      if (element.tagName !== "meta") return;
      const charset = attribute(element, "charset")?.trim().toLowerCase();
      if (charset !== undefined && charset !== "utf-8" && charset !== "utf8") {
        supported = false;
        return false;
      }
      if (
        attribute(element, "http-equiv")?.trim().toLowerCase() !==
        "content-type"
      )
        return;
      const content = attribute(element, "content") ?? "";
      const match = content.match(/(?:^|;)\s*charset\s*=\s*([^;\s]+)/i);
      if (
        match?.[1] !== undefined &&
        !["utf-8", "utf8"].includes(
          match[1].replace(/^['"]|['"]$/g, "").toLowerCase(),
        )
      ) {
        supported = false;
        return false;
      }
    },
    false,
  );
  return supported;
}

function policyAllowsProbe(content: string): boolean {
  const directives = new Map<string, string[]>();
  for (const part of content.split(";")) {
    const tokens = part.trim().split(/\s+/).filter(Boolean);
    const name = tokens.shift()?.toLowerCase();
    if (name !== undefined && !directives.has(name))
      directives.set(
        name,
        tokens.map((token) => token.toLowerCase()),
      );
  }
  const sources =
    directives.get("script-src-elem") ??
    directives.get("script-src") ??
    directives.get("default-src");
  if (sources === undefined) return true;
  if (sources.includes("'strict-dynamic'")) return false;
  // Authored files cannot predict the fresh content authority. Recognize only
  // origin-independent source expressions whose effect is unambiguous here.
  return sources.some(
    (source) => source === "'self'" || source === "*" || source === "http:",
  );
}

function cspAllowsProbe(head: DefaultTreeAdapterTypes.Element): boolean {
  let allowed = true;
  walkElements(
    head,
    (element) => {
      if (
        element.tagName !== "meta" ||
        attribute(element, "http-equiv")?.trim().toLowerCase() !==
          "content-security-policy"
      )
        return;
      if (!policyAllowsProbe(attribute(element, "content") ?? "")) {
        allowed = false;
        return false;
      }
    },
    false,
  );
  return allowed;
}

function hasUnsafeInsertionState(
  document: DefaultTreeAdapterTypes.Document,
): boolean {
  let unsafe = false;
  walkElements(document, (element) => {
    if (element.tagName === "frameset" || element.tagName === "plaintext") {
      unsafe = true;
      return false;
    }
    if (
      (rawTextElements.has(element.tagName) ||
        element.tagName === "template" ||
        element.namespaceURI !== "http://www.w3.org/1999/xhtml") &&
      element.sourceCodeLocation?.startTag !== undefined &&
      element.sourceCodeLocation.endTag === undefined
    ) {
      unsafe = true;
      return false;
    }
    if (
      element.tagName === "script" &&
      attribute(element, "src")?.startsWith(reviewProbePathPrefix) === true
    ) {
      unsafe = true;
      return false;
    }
  });
  return unsafe;
}

function insertionOffset(document: DefaultTreeAdapterTypes.Document): number {
  // The probe is a classic parser-blocking script. Placing it at the first
  // parser-created head position lets it capture browser intrinsics before any
  // authored script can replace them. Explicit head/html start tags preserve
  // preceding comments and the document mode selected by an authored doctype.
  const html = findElement(document, "html");
  const head = findElement(document, "head");
  if (head?.sourceCodeLocation?.startTag !== undefined)
    return head.sourceCodeLocation.startTag.endOffset;
  if (html?.sourceCodeLocation?.startTag !== undefined)
    return html.sourceCodeLocation.startTag.endOffset;

  const doctype = document.childNodes.find(
    (node) => node.nodeName === "#documentType",
  );
  if (doctype?.sourceCodeLocation != null)
    return doctype.sourceCodeLocation.endOffset;
  return 0;
}

function hasAuthoredElementBeforeProbe(
  document: DefaultTreeAdapterTypes.Document,
  offset: number,
): boolean {
  let authoredElement = false;
  walkElements(document, (element) => {
    const start = element.sourceCodeLocation?.startTag?.startOffset;
    if (
      start !== undefined &&
      start < offset &&
      element.tagName !== "html" &&
      element.tagName !== "head"
    ) {
      authoredElement = true;
      return false;
    }
  });
  return authoredElement;
}

function exactContentOrigin(value: string): URL {
  const origin = new URL(value);
  if (
    origin.origin !== value ||
    origin.protocol !== "http:" ||
    origin.username !== "" ||
    origin.password !== "" ||
    !/^c-[0-9a-f]{32}\.localhost$/.test(origin.hostname)
  )
    throw new TypeError("Invalid review content origin");
  return origin;
}

export function transformReviewEntry(
  source: Buffer,
  contentOrigin: string,
  probePath: string,
): ReviewEntryTransform {
  const revision =
    `sha256:${createHash("sha256").update(source).digest("hex")}` as const;
  if (source.length > maximumInstrumentedEntryBytes)
    return { outcome: "unsupported", reason: "entry_too_large", revision };
  if (
    (source[0] === 0xff && source[1] === 0xfe) ||
    (source[0] === 0xfe && source[1] === 0xff)
  )
    return { outcome: "unsupported", reason: "unsupported_encoding", revision };

  const bomBytes = source.subarray(0, 3).equals(utf8Bom) ? 3 : 0;
  const encoded = source.subarray(bomBytes);
  let decoded: string;
  try {
    decoded = new TextDecoder("utf-8", { fatal: true }).decode(encoded);
  } catch {
    return { outcome: "unsupported", reason: "unsupported_encoding", revision };
  }
  if (decoded.includes("\0"))
    return { outcome: "unsupported", reason: "unsupported_encoding", revision };

  const errors: ParserError[] = [];
  const document = parse(decoded, {
    sourceCodeLocationInfo: true,
    onParseError: (error) => errors.push(error),
  });
  if (
    errors.some((error) => fatalParseErrors.has(error.code)) ||
    hasUnsafeInsertionState(document)
  )
    return { outcome: "unsupported", reason: "unsupported_markup", revision };

  const head = findElement(document, "head");
  if (head !== undefined && !declaredEncodingIsUtf8(head))
    return { outcome: "unsupported", reason: "unsupported_encoding", revision };
  if (head !== undefined && !cspAllowsProbe(head))
    return { outcome: "unsupported", reason: "csp_blocked", revision };
  if (!/^\/\.htmlview\/probe\/[0-9a-f]{32}\.js$/.test(probePath))
    throw new TypeError("Invalid review probe path");
  const probeUrl = new URL(probePath, exactContentOrigin(contentOrigin));
  const script = Buffer.from(
    `<meta charset="utf-8"><script src="${probeUrl.href}" data-htmlview-revision="${revision}"></script>`,
  );
  const characterOffset = insertionOffset(document);
  if (hasAuthoredElementBeforeProbe(document, characterOffset))
    return { outcome: "unsupported", reason: "unsupported_markup", revision };
  const byteOffset =
    bomBytes + Buffer.byteLength(decoded.slice(0, characterOffset), "utf8");
  return {
    outcome: "instrumented",
    body: Buffer.concat([
      source.subarray(0, byteOffset),
      script,
      source.subarray(byteOffset),
    ]),
    revision,
  };
}
