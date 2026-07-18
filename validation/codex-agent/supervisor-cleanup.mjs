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

async function processState(inspectProcess, failures) {
  try {
    const state = await inspectProcess();
    if (["running", "exited", "unverified"].includes(state)) return state;
    throw new Error(`unexpected process state: ${String(state)}`);
  } catch (error) {
    failures.push(operationFailure("supervisor identity check", error));
    return "unverified";
  }
}

function retainUnverifiedProcess(failures) {
  failures.push(
    new Error(
      "supervisor process identity could not be confirmed; refusing to signal it",
    ),
  );
  return { safeToRemove: false, failures };
}

export async function stopSupervisorSafely({
  pid,
  requestStop,
  waitForCleanExit,
  waitForProcessExit,
  signalProcess,
  inspectProcess,
}) {
  const failures = [];
  await attempt("htmlview stop --all", requestStop, failures);
  if (await attempt("graceful supervisor cleanup", waitForCleanExit, failures))
    return { safeToRemove: true, failures };

  if (pid === undefined) return { safeToRemove: false, failures };
  const beforeTerm = await processState(inspectProcess, failures);
  if (beforeTerm === "exited") return { safeToRemove: true, failures };
  if (beforeTerm === "unverified") return retainUnverifiedProcess(failures);

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
  const beforeKill = await processState(inspectProcess, failures);
  if (beforeKill === "exited") return { safeToRemove: true, failures };
  if (beforeKill === "unverified") return retainUnverifiedProcess(failures);

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
