import { readdir, stat, readFile } from "node:fs/promises";
import path from "node:path";

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

const failures = [];
for (const file of await markdownFiles(".")) {
  const contents = await readFile(file, "utf8");
  for (const match of contents.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) {
    const reference = match[1] ?? "";
    let target = reference.split("#", 1)[0] ?? "";
    if (target === "" || /^[a-z]+:/i.test(target)) continue;
    target = decodeURI(target.replace(/^<|>$/g, ""));
    const resolved = path.resolve(path.dirname(file), target);
    if (!(await stat(resolved).catch(() => undefined)))
      failures.push(`${file}: ${reference}`);
  }
}

if (failures.length > 0) {
  process.stderr.write(`${failures.join("\n")}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write("All relative Markdown links resolve\n");
}
