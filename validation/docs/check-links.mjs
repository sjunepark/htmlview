import { readdir, stat, readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { marked } from "marked";

async function markdownFiles(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (["node_modules", ".git", "dist"].includes(entry.name)) continue;
    const candidate = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await markdownFiles(candidate)));
    else if (entry.name.endsWith(".md")) files.push(candidate);
  }
  return files;
}

export function markdownReferences(contents) {
  const references = [];
  marked.walkTokens(marked.lexer(contents), (token) => {
    if (token.type === "link" || token.type === "image")
      references.push(token.href);
  });
  return references;
}

export async function unresolvedMarkdownLinks(directory) {
  const failures = [];
  for (const file of await markdownFiles(directory)) {
    const contents = await readFile(file, "utf8");
    for (const reference of markdownReferences(contents)) {
      let target = reference.split("#", 1)[0] ?? "";
      if (target === "" || /^[a-z]+:/i.test(target) || target.startsWith("//"))
        continue;
      target = decodeURI(target);
      const resolved = path.resolve(path.dirname(file), target);
      if (!(await stat(resolved).catch(() => undefined)))
        failures.push(`${file}: ${reference}`);
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
    process.stdout.write("All relative Markdown links resolve\n");
  }
}
