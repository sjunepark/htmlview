import { realpath, stat } from "node:fs/promises";
import path from "node:path";

export interface ServingGrant {
  readonly entry: string;
  readonly routeEntry: string;
  readonly root: string;
  readonly entryRelativePath: string;
  readonly entryUrlPath: string;
}

export class GrantError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "GrantError";
  }
}

export function isWithinRoot(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return (
    relative !== "" &&
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

function encodeRelativePath(relativePath: string): string {
  return `/${relativePath.split(path.sep).map(encodeURIComponent).join("/")}`;
}

async function canonicalDirectory(candidate: string): Promise<string> {
  let canonical: string;
  try {
    canonical = await realpath(candidate);
  } catch {
    throw new GrantError(
      "path.root_not_found",
      `Serving root does not exist: ${candidate}`,
    );
  }
  const metadata = await stat(canonical);
  if (!metadata.isDirectory()) {
    throw new GrantError(
      "path.root_not_directory",
      `Serving root is not a directory: ${candidate}`,
    );
  }
  return canonical;
}

export async function resolveServingGrant(
  entryArgument: string,
  options: { readonly root?: string; readonly cwd?: string } = {},
): Promise<ServingGrant> {
  const cwd = options.cwd ?? process.cwd();
  const suppliedEntry = path.resolve(cwd, entryArgument);
  const extension = path.extname(suppliedEntry).toLowerCase();
  if (extension !== ".html" && extension !== ".htm") {
    throw new GrantError(
      "path.entry_not_html",
      `Entry must have an .html or .htm extension: ${entryArgument}`,
    );
  }

  const candidateRoot =
    options.root === undefined
      ? path.dirname(suppliedEntry)
      : path.resolve(cwd, options.root);
  const canonicalRoot = await canonicalDirectory(candidateRoot);

  let canonicalEntry: string;
  try {
    canonicalEntry = await realpath(suppliedEntry);
  } catch {
    throw new GrantError(
      "path.entry_not_found",
      `Entry file does not exist: ${entryArgument}`,
    );
  }

  let entryMetadata;
  try {
    entryMetadata = await stat(canonicalEntry);
  } catch {
    throw new GrantError(
      "path.entry_not_found",
      `Entry file does not exist: ${entryArgument}`,
    );
  }
  if (!entryMetadata.isFile()) {
    throw new GrantError(
      "path.entry_not_file",
      `Entry is not a regular file: ${entryArgument}`,
    );
  }
  if (!isWithinRoot(canonicalRoot, canonicalEntry)) {
    const code =
      options.root === undefined
        ? "path.entry_symlink_escape"
        : "path.entry_outside_root";
    throw new GrantError(
      code,
      `Entry resolves outside the serving root: ${entryArgument}`,
    );
  }

  const entryRelativePath = path.relative(canonicalRoot, canonicalEntry);
  let routeRelativePath = entryRelativePath;
  const suppliedRelativePath = path.relative(candidateRoot, suppliedEntry);
  if (
    suppliedRelativePath !== "" &&
    suppliedRelativePath !== ".." &&
    !suppliedRelativePath.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(suppliedRelativePath)
  ) {
    const suppliedRoute = path.join(canonicalRoot, suppliedRelativePath);
    const suppliedRouteTarget = await realpath(suppliedRoute).catch(
      () => undefined,
    );
    if (suppliedRouteTarget === canonicalEntry)
      routeRelativePath = suppliedRelativePath;
  }
  return {
    entry: canonicalEntry,
    routeEntry: path.join(canonicalRoot, routeRelativePath),
    root: canonicalRoot,
    entryRelativePath: routeRelativePath,
    entryUrlPath: encodeRelativePath(routeRelativePath),
  };
}
