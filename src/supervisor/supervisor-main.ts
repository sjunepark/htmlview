#!/usr/bin/env node
import { runMain } from "@effect/platform-node/NodeRuntime";
import { Effect } from "effect";
import { runSupervisor } from "./server.js";
import { statePaths } from "./state.js";

const program = Effect.scoped(
  runSupervisor({
    paths: statePaths(),
    ...(process.env.HTMLVIEW_SUPERVISOR_LOCK_NONCE === undefined
      ? {}
      : {
          ownershipNonce: process.env.HTMLVIEW_SUPERVISOR_LOCK_NONCE,
        }),
  }),
);

runMain(program);
