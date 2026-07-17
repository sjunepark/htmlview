#!/usr/bin/env node
import { runMain } from "@effect/platform-node/NodeRuntime";
import { randomUUID } from "node:crypto";
import { Effect } from "effect";
import { logDiagnostic } from "../diagnostics.js";
import { supervisorDiagnosticLayer } from "./logging.js";
import { runSupervisor, type SupervisorLifecycleError } from "./server.js";
import { statePaths } from "./state.js";

const paths = statePaths();
const setFailedExit = Effect.sync(() => {
  process.exitCode = 1;
});

const supervised = Effect.scoped(
  runSupervisor({
    paths,
    ...(process.env.HTMLVIEW_SUPERVISOR_LOCK_NONCE === undefined
      ? {}
      : {
          ownershipNonce: process.env.HTMLVIEW_SUPERVISOR_LOCK_NONCE,
        }),
  }),
).pipe(
  Effect.catch((failure: SupervisorLifecycleError) =>
    logDiagnostic("Error", {
      operation: "supervisor.run",
      code:
        failure.phase === "startup"
          ? "supervisor.start_failed"
          : "runtime.internal",
      internalId: randomUUID(),
    }).pipe(Effect.andThen(setFailedExit)),
  ),
  Effect.catchDefect(() =>
    logDiagnostic("Error", {
      operation: "supervisor.run",
      code: "runtime.internal",
      internalId: randomUUID(),
    }).pipe(Effect.andThen(setFailedExit)),
  ),
);

const program = supervised.pipe(
  Effect.provide(supervisorDiagnosticLayer(paths)),
  Effect.catch(() => setFailedExit),
  Effect.catchDefect(() => setFailedExit),
);

runMain(program, { disableErrorReporting: true });
