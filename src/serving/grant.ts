import { realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { PathError } from "../errors.js";

export interface ServingGrant {
  readonly entry: string;
  readonly routeEntry: string;
  readonly root: string;
  readonly entryRelativePath: string;
  readonly entryUrlPath: string;
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

export function isBroadServingRoot(root: string, home: string): boolean {
  return root === home || isWithinRoot(root, home);
}

function encodeRelativePath(relativePath: string): string {
  return `/${relativePath.split(path.sep).map(encodeURIComponent).join("/")}`;
}

function permissionDenied(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  return code === "EACCES" || code === "EPERM";
}

async function canonicalDirectory(candidate: string): Promise<string> {
  let canonical: string;
  try {
    canonical = await realpath(candidate);
  } catch (error) {
    throw new PathError({
      code: permissionDenied(error)
        ? "path.root_unreadable"
        : "path.root_not_found",
      message: permissionDenied(error)
        ? `Serving root is not accessible: ${candidate}`
        : `Serving root does not exist: ${candidate}`,
      cause: error,
    });
  }
  let metadata;
  try {
    metadata = await stat(canonical);
  } catch (error) {
    throw new PathError({
      code: permissionDenied(error)
        ? "path.root_unreadable"
        : "path.root_not_found",
      message: permissionDenied(error)
        ? `Serving root is not accessible: ${candidate}`
        : `Serving root does not exist: ${candidate}`,
      cause: error,
    });
  }
  if (!metadata.isDirectory()) {
    throw new PathError({
      code: "path.root_not_directory",
      message: `Serving root is not a directory: ${candidate}`,
    });
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
    throw new PathError({
      code: "path.entry_not_html",
      message: `Entry must have an .html or .htm extension: ${entryArgument}`,
    });
  }

  const candidateRoot =
    options.root === undefined
      ? path.dirname(suppliedEntry)
      : path.resolve(cwd, options.root);
  const canonicalRoot = await canonicalDirectory(candidateRoot);
  const canonicalHome = await realpath(homedir()).catch(() =>
    path.resolve(homedir()),
  );
  if (isBroadServingRoot(canonicalRoot, canonicalHome))
    throw new PathError({
      code: "path.root_too_broad",
      message:
        "Serving root cannot be the user home directory or one of its ancestors",
    });

  let canonicalEntry: string;
  try {
    canonicalEntry = await realpath(suppliedEntry);
  } catch (error) {
    throw new PathError({
      code: permissionDenied(error)
        ? "path.entry_unreadable"
        : "path.entry_not_found",
      message: permissionDenied(error)
        ? `Entry file is not accessible: ${entryArgument}`
        : `Entry file does not exist: ${entryArgument}`,
      cause: error,
    });
  }

  let entryMetadata;
  try {
    entryMetadata = await stat(canonicalEntry);
  } catch (error) {
    throw new PathError({
      code: permissionDenied(error)
        ? "path.entry_unreadable"
        : "path.entry_not_found",
      message: permissionDenied(error)
        ? `Entry file is not accessible: ${entryArgument}`
        : `Entry file does not exist: ${entryArgument}`,
      cause: error,
    });
  }
  if (!entryMetadata.isFile()) {
    throw new PathError({
      code: "path.entry_not_file",
      message: `Entry is not a regular file: ${entryArgument}`,
    });
  }
  if (!isWithinRoot(canonicalRoot, canonicalEntry)) {
    const code =
      options.root === undefined
        ? "path.entry_symlink_escape"
        : "path.entry_outside_root";
    throw new PathError({
      code,
      message: `Entry resolves outside the serving root: ${entryArgument}`,
    });
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
