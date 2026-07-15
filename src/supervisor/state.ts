import { randomBytes } from "node:crypto";
import { closeSync, fsyncSync, openSync, writeSync } from "node:fs";
import {
  chmod,
  mkdir,
  readFile,
  rename,
  rm,
  stat,
  unlink,
} from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { supervisorProtocol, type DiscoveryRecord } from "./protocol.js";

const maximumStateFileBytes = 16 * 1024;

export interface StatePaths {
  readonly directory: string;
  readonly discovery: string;
  readonly startupLock: string;
}

export function statePaths(
  environment: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): StatePaths {
  let directory: string;
  if (environment.HTMLVIEW_STATE_DIR !== undefined) {
    directory = path.resolve(environment.HTMLVIEW_STATE_DIR);
  } else if (platform === "darwin") {
    directory = path.join(
      homedir(),
      "Library",
      "Application Support",
      "htmlview",
    );
  } else {
    const xdgStateHome = environment.XDG_STATE_HOME;
    const stateHome =
      xdgStateHome !== undefined && path.isAbsolute(xdgStateHome)
        ? xdgStateHome
        : path.join(homedir(), ".local", "state");
    directory = path.join(stateHome, "htmlview");
  }
  return {
    directory,
    discovery: path.join(directory, "supervisor.json"),
    startupLock: path.join(directory, "startup.lock"),
  };
}

export async function ensurePrivateStateDirectory(
  paths: StatePaths,
): Promise<void> {
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

function isDiscoveryRecord(value: unknown): value is DiscoveryRecord {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    record.protocol === supervisorProtocol &&
    typeof record.instanceId === "string" &&
    typeof record.pid === "number" &&
    Number.isSafeInteger(record.pid) &&
    typeof record.port === "number" &&
    Number.isInteger(record.port) &&
    record.port > 0 &&
    record.port <= 65_535 &&
    typeof record.token === "string" &&
    record.token.length >= 43 &&
    typeof record.version === "string"
  );
}

export async function readDiscovery(
  paths: StatePaths,
): Promise<DiscoveryRecord | undefined> {
  try {
    const body = await readFile(paths.discovery);
    if (body.length > maximumStateFileBytes) return undefined;
    const value: unknown = JSON.parse(body.toString("utf8"));
    return isDiscoveryRecord(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

export async function removeDiscovery(
  paths: StatePaths,
  instanceId?: string,
): Promise<void> {
  if (instanceId !== undefined) {
    const current = await readDiscovery(paths);
    if (current?.instanceId !== instanceId) return;
  }
  await unlink(paths.discovery).catch(() => undefined);
}

export interface StartupLock {
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

interface StartupLockOwner {
  readonly pid: number;
  readonly createdAt: number;
  readonly nonce: string;
}

async function readLockOwner(
  paths: StatePaths,
): Promise<StartupLockOwner | undefined> {
  try {
    const value: unknown = JSON.parse(
      await readFile(path.join(paths.startupLock, "owner.json"), "utf8"),
    );
    if (typeof value !== "object" || value === null) return undefined;
    const owner = value as Record<string, unknown>;
    if (
      typeof owner.pid !== "number" ||
      !Number.isSafeInteger(owner.pid) ||
      typeof owner.createdAt !== "number" ||
      !Number.isFinite(owner.createdAt) ||
      typeof owner.nonce !== "string" ||
      owner.nonce.length < 16
    )
      return undefined;
    return owner as unknown as StartupLockOwner;
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
  const metadata = await stat(paths.startupLock, { bigint: true }).catch(
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
  const claim = path.join(paths.startupLock, ".reclaim");
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
      stat(paths.startupLock, { bigint: true }).catch(() => undefined),
      readLockOwner(paths),
    ]);
    if (
      metadata === undefined ||
      metadata.dev !== snapshot.device ||
      metadata.ino !== snapshot.inode ||
      owner?.nonce !== snapshot.ownerNonce
    )
      return false;
    await rm(paths.startupLock, { recursive: true, force: true });
    reclaimed = true;
    return true;
  } finally {
    if (!reclaimed) await rm(claim, { recursive: true, force: true });
  }
}

export async function acquireStartupLock(
  paths: StatePaths,
  timeoutMilliseconds = 10_000,
): Promise<StartupLock> {
  const deadline = Date.now() + timeoutMilliseconds;
  while (Date.now() < deadline) {
    try {
      await mkdir(paths.startupLock, { mode: 0o700 });
      const nonce = randomBytes(16).toString("hex");
      try {
        await writePrivateJson(path.join(paths.startupLock, "owner.json"), {
          pid: process.pid,
          createdAt: Date.now(),
          nonce,
        });
      } catch (error) {
        await rm(paths.startupLock, { recursive: true, force: true });
        throw error;
      }
      return {
        release: async () => {
          const owner = await readLockOwner(paths);
          if (owner?.nonce !== nonce) return;
          await rm(paths.startupLock, { recursive: true, force: true });
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
  throw new Error("Timed out waiting for the supervisor startup lock");
}
