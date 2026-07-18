import { spawn } from "node:child_process";

const maximumTimerMilliseconds = 2_147_483_647;

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
    if (process.platform === "win32") child.kill(signal);
    else process.kill(-child.pid, signal);
  } catch (error) {
    if (error?.code === "ESRCH") return;
    try {
      child.kill(signal);
    } catch {
      // The process may have exited between group and direct signaling.
    }
  }
}

function processGroupPresent(child) {
  if (process.platform === "win32" || child.pid === undefined) return false;
  try {
    process.kill(-child.pid, 0);
    return true;
  } catch (error) {
    return error?.code !== "ESRCH";
  }
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
  positiveTimer("timeoutMilliseconds", timeoutMilliseconds);
  positiveTimer("terminationGraceMilliseconds", terminationGraceMilliseconds);
  positiveTimer("streamDrainMilliseconds", streamDrainMilliseconds);
  if (!Number.isSafeInteger(maximumOutputBytes) || maximumOutputBytes < 1)
    throw new Error("maximumOutputBytes must be a positive safe integer");

  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env,
      detached: process.platform !== "win32",
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
