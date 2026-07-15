import { realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { Effect } from "effect";
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

function pathPromise<A>(
  operation: () => Promise<A>,
  failure: (cause: unknown) => PathError,
): Effect.Effect<A, PathError> {
  return Effect.tryPromise({ try: operation, catch: failure });
}

function rootLookupFailure(candidate: string, cause: unknown): PathError {
  return new PathError({
    code: permissionDenied(cause)
      ? "path.root_unreadable"
      : "path.root_not_found",
    message: permissionDenied(cause)
      ? `Serving root is not accessible: ${candidate}`
      : `Serving root does not exist: ${candidate}`,
    cause,
  });
}

function canonicalDirectory(
  candidate: string,
): Effect.Effect<string, PathError> {
  return Effect.gen(function* () {
    const canonical = yield* pathPromise(
      () => realpath(candidate),
      (cause) => rootLookupFailure(candidate, cause),
    );
    const metadata = yield* pathPromise(
      () => stat(canonical),
      (cause) => rootLookupFailure(candidate, cause),
    );
    if (!metadata.isDirectory())
      return yield* new PathError({
        code: "path.root_not_directory",
        message: `Serving root is not a directory: ${candidate}`,
      });
    return canonical;
  });
}

function entryLookupFailure(entryArgument: string, cause: unknown): PathError {
  return new PathError({
    code: permissionDenied(cause)
      ? "path.entry_unreadable"
      : "path.entry_not_found",
    message: permissionDenied(cause)
      ? `Entry file is not accessible: ${entryArgument}`
      : `Entry file does not exist: ${entryArgument}`,
    cause,
  });
}

export function resolveServingGrant(
  entryArgument: string,
  options: { readonly root?: string; readonly cwd?: string } = {},
): Effect.Effect<ServingGrant, PathError> {
  return Effect.gen(function* () {
    const cwd = options.cwd ?? process.cwd();
    const suppliedEntry = path.resolve(cwd, entryArgument);
    const extension = path.extname(suppliedEntry).toLowerCase();
    if (extension !== ".html" && extension !== ".htm")
      return yield* new PathError({
        code: "path.entry_not_html",
        message: `Entry must have an .html or .htm extension: ${entryArgument}`,
      });

    const candidateRoot =
      options.root === undefined
        ? path.dirname(suppliedEntry)
        : path.resolve(cwd, options.root);
    const canonicalRoot = yield* canonicalDirectory(candidateRoot);
    const canonicalHome = yield* Effect.tryPromise(() =>
      realpath(homedir()),
    ).pipe(Effect.catch(() => Effect.succeed(path.resolve(homedir()))));
    if (isBroadServingRoot(canonicalRoot, canonicalHome))
      return yield* new PathError({
        code: "path.root_too_broad",
        message:
          "Serving root cannot be the user home directory or one of its ancestors",
      });

    const canonicalEntry = yield* pathPromise(
      () => realpath(suppliedEntry),
      (cause) => entryLookupFailure(entryArgument, cause),
    );
    const entryMetadata = yield* pathPromise(
      () => stat(canonicalEntry),
      (cause) => entryLookupFailure(entryArgument, cause),
    );
    if (!entryMetadata.isFile())
      return yield* new PathError({
        code: "path.entry_not_file",
        message: `Entry is not a regular file: ${entryArgument}`,
      });
    if (!isWithinRoot(canonicalRoot, canonicalEntry)) {
      const code =
        options.root === undefined
          ? "path.entry_symlink_escape"
          : "path.entry_outside_root";
      return yield* new PathError({
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
      const suppliedRouteTarget = yield* Effect.tryPromise(() =>
        realpath(suppliedRoute),
      ).pipe(Effect.catch(() => Effect.void));
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
  });
}
