import { randomBytes } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  openSync,
  readSync,
  writeSync,
} from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  rename,
  rm,
  stat,
  unlink,
} from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

const maximumStateFileBytes = 16 * 1024;
const maximumPortableSocketPathBytes = 100;

export interface StatePaths {
  readonly directory: string;
  readonly controlSocket: string;
  readonly supervisorLock: string;
  readonly configurationError?: string;
}

export function statePaths(
  environment: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): StatePaths {
  let directory: string;
  let configurationError: string | undefined;
  if (
    environment.HTMLVIEW_STATE_DIR !== undefined &&
    path.isAbsolute(environment.HTMLVIEW_STATE_DIR)
  ) {
    directory = path.resolve(environment.HTMLVIEW_STATE_DIR);
  } else if (platform === "darwin") {
    if (environment.HTMLVIEW_STATE_DIR !== undefined)
      configurationError = "HTMLVIEW_STATE_DIR must be an absolute path";
    directory = path.join(
      homedir(),
      "Library",
      "Application Support",
      "htmlview",
    );
  } else {
    if (environment.HTMLVIEW_STATE_DIR !== undefined)
      configurationError = "HTMLVIEW_STATE_DIR must be an absolute path";
    const xdgStateHome = environment.XDG_STATE_HOME;
    const stateHome =
      xdgStateHome !== undefined && path.isAbsolute(xdgStateHome)
        ? xdgStateHome
        : path.join(homedir(), ".local", "state");
    directory = path.join(stateHome, "htmlview");
  }
  return {
    directory,
    controlSocket: path.join(directory, "control.sock"),
    supervisorLock: path.join(directory, "supervisor.lock"),
    ...(configurationError === undefined ? {} : { configurationError }),
  };
}

export async function ensurePrivateStateDirectory(
  paths: StatePaths,
): Promise<void> {
  if (paths.configurationError !== undefined)
    throw new Error(paths.configurationError);
  if (Buffer.byteLength(paths.controlSocket) > maximumPortableSocketPathBytes)
    throw new Error("The htmlview control-socket path is too long");
  await mkdir(paths.directory, { recursive: true, mode: 0o700 });
  await chmod(paths.directory, 0o700);
  const metadata = await stat(paths.directory);
  if (!metadata.isDirectory())
    throw new Error(`State path is not a directory: ${paths.directory}`);
  if (process.getuid !== undefined && metadata.uid !== process.getuid()) {
    throw new Error(
      `State directory is not owned by the current user: ${paths.directory}`,
    );
  }
}

export async function writePrivateJson(
  file: string,
  value: unknown,
): Promise<void> {
  const temporary = `${file}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
  try {
    const descriptor = openSync(temporary, "wx", 0o600);
    try {
      const body = Buffer.from(JSON.stringify(value));
      if (body.length > maximumStateFileBytes)
        throw new Error("State record exceeds size limit");
      writeSync(descriptor, body);
      fsyncSync(descriptor);
    } finally {
      closeSync(descriptor);
    }
    await rename(temporary, file);
    await chmod(file, 0o600);
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
}

export async function removeStaleControlSocket(
  paths: StatePaths,
): Promise<void> {
  const metadata = await lstat(paths.controlSocket).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  });
  if (metadata === undefined) return;
  if (!metadata.isSocket())
    throw new Error("The htmlview control-socket path is not a socket");
  await unlink(paths.controlSocket);
}

export interface SupervisorLock {
  readonly nonce: string;
  release(): Promise<void>;
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EPERM") return true;
    return false;
  }
}

interface SupervisorLockOwner {
  readonly pid: number;
  readonly nonce: string;
}

function readBoundedRegularFile(file: string): string | undefined {
  let descriptor: number | undefined;
  try {
    descriptor = openSync(
      file,
      constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW,
    );
    const metadata = fstatSync(descriptor);
    if (!metadata.isFile() || metadata.size > maximumStateFileBytes)
      return undefined;
    const body = Buffer.alloc(metadata.size);
    let offset = 0;
    while (offset < body.length) {
      const count = readSync(
        descriptor,
        body,
        offset,
        body.length - offset,
        offset,
      );
      if (count === 0) break;
      offset += count;
    }
    return body.subarray(0, offset).toString("utf8");
  } catch {
    return undefined;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

async function readLockOwner(
  paths: StatePaths,
): Promise<SupervisorLockOwner | undefined> {
  try {
    const text = readBoundedRegularFile(
      path.join(paths.supervisorLock, "owner.json"),
    );
    if (text === undefined) return undefined;
    const value: unknown = JSON.parse(text);
    if (typeof value !== "object" || value === null) return undefined;
    const owner = value as Record<string, unknown>;
    if (
      typeof owner.pid !== "number" ||
      !Number.isSafeInteger(owner.pid) ||
      owner.pid <= 0 ||
      typeof owner.nonce !== "string" ||
      owner.nonce.length < 16
    )
      return undefined;
    return owner as unknown as SupervisorLockOwner;
  } catch {
    return undefined;
  }
}

interface StaleLockSnapshot {
  readonly device: bigint;
  readonly inode: bigint;
  readonly ownerNonce?: string;
}

async function staleLockSnapshot(
  paths: StatePaths,
): Promise<StaleLockSnapshot | undefined> {
  const metadata = await stat(paths.supervisorLock, { bigint: true }).catch(
    () => undefined,
  );
  if (metadata === undefined) return undefined;
  const owner = await readLockOwner(paths);
  if (owner !== undefined && processIsAlive(owner.pid)) return undefined;
  if (
    owner === undefined &&
    Date.now() - Number(metadata.mtimeNs / 1_000_000n) <= 10_000
  )
    return undefined;
  return {
    device: metadata.dev,
    inode: metadata.ino,
    ...(owner === undefined ? {} : { ownerNonce: owner.nonce }),
  };
}

async function reclaimStaleLock(
  paths: StatePaths,
  snapshot: StaleLockSnapshot,
): Promise<boolean> {
  const claim = path.join(paths.supervisorLock, ".reclaim");
  try {
    await mkdir(claim, { mode: 0o700 });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EEXIST" || code === "ENOENT") return false;
    throw error;
  }

  let reclaimed = false;
  try {
    const [metadata, owner] = await Promise.all([
      stat(paths.supervisorLock, { bigint: true }).catch(() => undefined),
      readLockOwner(paths),
    ]);
    if (
      metadata === undefined ||
      metadata.dev !== snapshot.device ||
      metadata.ino !== snapshot.inode ||
      owner?.nonce !== snapshot.ownerNonce
    )
      return false;
    await rm(paths.supervisorLock, { recursive: true, force: true });
    reclaimed = true;
    return true;
  } finally {
    if (!reclaimed) await rm(claim, { recursive: true, force: true });
  }
}

export async function acquireSupervisorLock(
  paths: StatePaths,
  timeoutMilliseconds = 10_000,
): Promise<SupervisorLock> {
  const deadline = Date.now() + timeoutMilliseconds;
  while (Date.now() < deadline) {
    try {
      await mkdir(paths.supervisorLock, { mode: 0o700 });
      const nonce = randomBytes(16).toString("hex");
      try {
        await writePrivateJson(path.join(paths.supervisorLock, "owner.json"), {
          pid: process.pid,
          nonce,
        });
      } catch (error) {
        await rm(paths.supervisorLock, { recursive: true, force: true });
        throw error;
      }
      return {
        nonce,
        release: async () => {
          const owner = await readLockOwner(paths);
          if (owner?.nonce !== nonce) return;
          await rm(paths.supervisorLock, { recursive: true, force: true });
        },
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const stale = await staleLockSnapshot(paths);
      if (stale !== undefined && (await reclaimStaleLock(paths, stale)))
        continue;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  throw new Error("Timed out waiting for the supervisor ownership lock");
}

export async function transferSupervisorLock(
  paths: StatePaths,
  expectedNonce: string,
  owner: { readonly pid: number; readonly instanceId: string },
): Promise<SupervisorLock> {
  const current = await readLockOwner(paths);
  if (current?.nonce !== expectedNonce)
    throw new Error("The htmlview supervisor ownership lock changed owners");
  const nonce = owner.instanceId;
  await writePrivateJson(path.join(paths.supervisorLock, "owner.json"), {
    pid: owner.pid,
    nonce,
  });
  return {
    nonce,
    release: async () => {
      const latest = await readLockOwner(paths);
      if (latest?.nonce !== nonce) return;
      await rm(paths.supervisorLock, { recursive: true, force: true });
    },
  };
}
