function operationFailure(operation, cause) {
  return new Error(`${operation} failed`, { cause });
}

async function attempt(operation, action, failures) {
  try {
    await action();
    return true;
  } catch (error) {
    failures.push(operationFailure(operation, error));
    return false;
  }
}

function processRunning(pid, isProcessRunning, failures) {
  try {
    return isProcessRunning(pid);
  } catch (error) {
    failures.push(operationFailure("supervisor liveness check", error));
    return true;
  }
}

export async function stopSupervisorSafely({
  pid,
  requestStop,
  waitForCleanExit,
  waitForProcessExit,
  signalProcess,
  isProcessRunning,
}) {
  const failures = [];
  await attempt("htmlview stop --all", requestStop, failures);
  if (await attempt("graceful supervisor cleanup", waitForCleanExit, failures))
    return { safeToRemove: true, failures };

  if (pid === undefined) return { safeToRemove: false, failures };
  if (!processRunning(pid, isProcessRunning, failures))
    return { safeToRemove: true, failures };

  await attempt(
    "supervisor SIGTERM",
    () => signalProcess(pid, "SIGTERM"),
    failures,
  );
  if (
    await attempt(
      "supervisor cleanup after SIGTERM",
      waitForCleanExit,
      failures,
    )
  )
    return { safeToRemove: true, failures };
  if (!processRunning(pid, isProcessRunning, failures))
    return { safeToRemove: true, failures };

  await attempt(
    "supervisor SIGKILL",
    () => signalProcess(pid, "SIGKILL"),
    failures,
  );
  const processExited = await attempt(
    "supervisor exit after SIGKILL",
    waitForProcessExit,
    failures,
  );
  return { safeToRemove: processExited, failures };
}

export function combineFailures(primaryFailure, cleanupFailures) {
  const failures = [
    ...(primaryFailure === undefined ? [] : [primaryFailure]),
    ...cleanupFailures,
  ];
  if (failures.length === 0) return undefined;
  if (failures.length === 1) return failures[0];
  return new AggregateError(
    failures,
    "Codex acceptance validation and cleanup reported multiple failures",
  );
}
