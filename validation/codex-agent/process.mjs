import { execFileSync, spawn } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";

const maximumTimerMilliseconds = 2_147_483_647;
const supportedPlatforms = new Set(["darwin", "linux"]);

export function assertProcessGroupPlatform(platform = process.platform) {
  if (!supportedPlatforms.has(platform))
    throw new Error("Codex acceptance process groups require macOS or Linux");
}

function positiveTimer(name, value) {
  if (
    !Number.isSafeInteger(value) ||
    value < 1 ||
    value > maximumTimerMilliseconds
  )
    throw new Error(
      `${name} must be an integer between 1 and ${maximumTimerMilliseconds}`,
    );
}

function signalProcessGroup(child, signal) {
  if (child.pid === undefined) return;
  try {
    process.kill(-child.pid, signal);
  } catch (error) {
    if (error?.code === "ESRCH") return;
    try {
      child.kill(signal);
    } catch {
      // The process may have exited between group and direct signaling.
    }
  }
}

function readLinuxProcessStat(pid) {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const commandEnd = stat.lastIndexOf(")");
    if (commandEnd < 0) return undefined;
    const fields = stat
      .slice(commandEnd + 2)
      .trim()
      .split(/\s+/);
    const processGroup = Number(fields[2]);
    const startTime = fields[19];
    if (
      fields.length < 20 ||
      !Number.isSafeInteger(processGroup) ||
      !/^\d+$/.test(startTime)
    )
      return undefined;
    return { state: fields[0], processGroup, startTime };
  } catch {
    return undefined;
  }
}

function linuxProcessGroupPresent(processGroup) {
  let entries;
  try {
    entries = readdirSync("/proc", { withFileTypes: true });
  } catch {
    return true;
  }

  for (const entry of entries) {
    if (!entry.isDirectory() || !/^[1-9][0-9]*$/.test(entry.name)) continue;
    const stat = readLinuxProcessStat(entry.name);
    if (
      stat?.processGroup === processGroup &&
      stat.state !== "Z" &&
      stat.state !== "X"
    )
      return true;
  }
  return false;
}

export function processIsRunning(pid) {
  if (!Number.isSafeInteger(pid) || pid < 1) return false;
  try {
    process.kill(pid, 0);
  } catch (error) {
    return error?.code !== "ESRCH";
  }
  if (process.platform !== "linux") return true;
  const stat = readLinuxProcessStat(pid);
  return stat === undefined || (stat.state !== "Z" && stat.state !== "X");
}

export function processIdentity(pid) {
  if (!processIsRunning(pid)) return undefined;
  if (process.platform === "linux") {
    const stat = readLinuxProcessStat(pid);
    return stat === undefined ? undefined : `linux:${pid}:${stat.startTime}`;
  }
  if (process.platform === "darwin") {
    try {
      const identity = execFileSync(
        "/bin/ps",
        ["-p", String(pid), "-o", "lstart=", "-o", "ppid=", "-o", "command="],
        {
          encoding: "utf8",
          maxBuffer: 64 * 1024,
          stdio: ["ignore", "pipe", "ignore"],
          timeout: 1_000,
        },
      ).trim();
      return identity === "" ? undefined : `darwin:${identity}`;
    } catch {
      return undefined;
    }
  }
  return undefined;
}

function processGroupPresent(child) {
  if (child.pid === undefined) return false;
  try {
    process.kill(-child.pid, 0);
  } catch (error) {
    if (error?.code === "ESRCH") return false;
  }
  return process.platform === "linux"
    ? linuxProcessGroupPresent(child.pid)
    : true;
}

export function runProcessGroup(
  command,
  args,
  {
    cwd,
    env,
    timeoutMilliseconds,
    terminationGraceMilliseconds = 5_000,
    streamDrainMilliseconds = 1_000,
    maximumOutputBytes = 10 * 1024 * 1024,
  },
) {
  assertProcessGroupPlatform();
  positiveTimer("timeoutMilliseconds", timeoutMilliseconds);
  positiveTimer("terminationGraceMilliseconds", terminationGraceMilliseconds);
  positiveTimer("streamDrainMilliseconds", streamDrainMilliseconds);
  if (!Number.isSafeInteger(maximumOutputBytes) || maximumOutputBytes < 1)
    throw new Error("maximumOutputBytes must be a positive safe integer");

  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout = [];
    const stderr = [];
    let capturedBytes = 0;
    let termination;
    let forcedTermination;
    let streamDrain;
    let groupCheck;
    let forced = false;
    let groupDeadline;
    let closeResult;
    let settled = false;

    const clearTimers = () => {
      clearTimeout(timeout);
      clearTimeout(forcedTermination);
      clearTimeout(streamDrain);
      clearTimeout(groupCheck);
    };

    const finish = (processGroupRetained = false) => {
      if (settled || closeResult === undefined) return;
      settled = true;
      clearTimers();
      resolve({
        ...closeResult,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
        termination,
        processGroupRetained,
      });
    };

    const observeTerminatedGroup = () => {
      if (settled || closeResult === undefined) return;
      if (!processGroupPresent(child)) {
        finish();
        return;
      }
      if (forced && Date.now() >= groupDeadline) {
        finish(true);
        return;
      }
      groupCheck = setTimeout(observeTerminatedGroup, 20);
    };

    const beginTermination = (reason) => {
      if (termination !== undefined) return;
      termination = reason;
      clearTimeout(timeout);
      signalProcessGroup(child, "SIGTERM");
      forcedTermination = setTimeout(() => {
        forced = true;
        signalProcessGroup(child, "SIGKILL");
        groupDeadline = Date.now() + streamDrainMilliseconds;
        streamDrain = setTimeout(() => {
          child.stdout.destroy();
          child.stderr.destroy();
          observeTerminatedGroup();
        }, streamDrainMilliseconds);
        observeTerminatedGroup();
      }, terminationGraceMilliseconds);
    };

    const capture = (target, chunk) => {
      const remaining = maximumOutputBytes - capturedBytes;
      if (remaining > 0) {
        const captured = chunk.subarray(0, remaining);
        target.push(captured);
        capturedBytes += captured.byteLength;
      }
      if (chunk.byteLength > remaining) beginTermination("output_limit");
    };

    child.stdout.on("data", (chunk) => capture(stdout, chunk));
    child.stderr.on("data", (chunk) => capture(stderr, chunk));

    const timeout = setTimeout(
      () => beginTermination("timeout"),
      timeoutMilliseconds,
    );

    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimers();
      reject(error);
    });
    child.once("close", (code, signal) => {
      if (settled) return;
      closeResult = { code, signal };
      if (termination === undefined && processGroupPresent(child))
        beginTermination("retained_process_group");
      if (termination === undefined) finish();
      else observeTerminatedGroup();
    });
  });
}
