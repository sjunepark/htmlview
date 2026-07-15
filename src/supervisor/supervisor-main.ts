#!/usr/bin/env node
import { runMain } from "@effect/platform-node/NodeRuntime";
import { Effect, Layer } from "effect";
import { runSupervisor } from "./server.js";
import { statePaths } from "./state.js";

const SupervisorLive = Layer.effectDiscard(
  runSupervisor({
    paths: statePaths(),
    ...(process.env.HTMLVIEW_SUPERVISOR_LOCK_NONCE === undefined
      ? {}
      : {
          ownershipNonce: process.env.HTMLVIEW_SUPERVISOR_LOCK_NONCE,
        }),
  }),
);

runMain(Effect.void.pipe(Effect.provide(SupervisorLive)));
