import { execFile } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { marked } from "marked";

const execute = promisify(execFile);

export async function markdownFiles(directory) {
  const root = path.resolve(directory);
  const { stdout } = await execute(
    "git",
    ["-C", root, "ls-files", "-co", "--exclude-standard", "-z", "--", "*.md"],
    { encoding: "utf8", maxBuffer: 10 * 1024 * 1024 },
  );
  const candidates = [...new Set(stdout.split("\0").filter(Boolean))]
    .map((file) => path.resolve(root, file))
    .sort();
  const existing = await Promise.all(
    candidates.map(async (file) =>
      (await stat(file).catch(() => undefined))?.isFile() ? file : undefined,
    ),
  );
  return existing.filter((file) => file !== undefined);
}

export function markdownReferences(contents) {
  const references = [];
  marked.walkTokens(marked.lexer(contents), (token) => {
    if (token.type === "link" || token.type === "image")
      references.push(token.href);
  });
  return references;
}

function inlineText(tokens) {
  return tokens
    .map((token) => {
      if ("tokens" in token && Array.isArray(token.tokens))
        return inlineText(token.tokens);
      if ("text" in token && typeof token.text === "string") return token.text;
      return token.type === "br" ? " " : "";
    })
    .join("");
}

function headingSlug(value) {
  return value
    .toLowerCase()
    .replace(/<[^>]*>/g, "")
    .replace(/[`*_~]/g, "")
    .replace(/[^\p{L}\p{N}\s_-]/gu, "")
    .trim()
    .replace(/\s+/g, "-");
}

export function markdownHeadingIds(contents) {
  const identifiers = new Set();
  const occurrences = new Map();
  for (const token of marked.lexer(contents)) {
    if (token.type !== "heading") continue;
    const base = headingSlug(
      Array.isArray(token.tokens) ? inlineText(token.tokens) : token.text,
    );
    const occurrence = occurrences.get(base) ?? 0;
    occurrences.set(base, occurrence + 1);
    identifiers.add(occurrence === 0 ? base : `${base}-${occurrence}`);
  }
  return identifiers;
}

function localReference(reference) {
  if (/^[a-z]+:/i.test(reference) || reference.startsWith("//")) return;
  const hash = reference.indexOf("#");
  const target = hash === -1 ? reference : reference.slice(0, hash);
  const fragment = hash === -1 ? undefined : reference.slice(hash + 1);
  try {
    return {
      target: decodeURI(target),
      fragment:
        fragment === undefined || fragment === ""
          ? undefined
          : decodeURIComponent(fragment),
    };
  } catch {
    return { invalid: true };
  }
}

export async function unresolvedMarkdownLinks(
  directory,
  candidates = undefined,
) {
  const files = candidates ?? (await markdownFiles(directory));
  const failures = [];
  const headingCache = new Map();

  for (const file of files) {
    const contents = await readFile(file, "utf8");
    for (const reference of markdownReferences(contents)) {
      const parsed = localReference(reference);
      if (parsed === undefined) continue;
      if (parsed.invalid) {
        failures.push(`${file}: ${reference} (invalid URI)`);
        continue;
      }

      const resolved = path.resolve(path.dirname(file), parsed.target || file);
      const metadata = await stat(resolved).catch(() => undefined);
      if (metadata === undefined) {
        failures.push(`${file}: ${reference}`);
        continue;
      }

      if (
        parsed.fragment === undefined ||
        !metadata.isFile() ||
        path.extname(resolved).toLowerCase() !== ".md"
      )
        continue;
      let identifiers = headingCache.get(resolved);
      if (identifiers === undefined) {
        identifiers = markdownHeadingIds(await readFile(resolved, "utf8"));
        headingCache.set(resolved, identifiers);
      }
      if (!identifiers.has(parsed.fragment))
        failures.push(`${file}: ${reference} (missing fragment)`);
    }
  }
  return failures;
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  const failures = await unresolvedMarkdownLinks(".");
  if (failures.length > 0) {
    process.stderr.write(`${failures.join("\n")}\n`);
    process.exitCode = 1;
  } else {
    process.stdout.write(
      "All nonignored Markdown links and fragments resolve\n",
    );
  }
}
