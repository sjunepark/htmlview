#!/usr/bin/env node
import { ensurePrivateStateDirectory, statePaths } from "./state.js";
import { startSupervisor } from "./server.js";

const paths = statePaths();
await ensurePrivateStateDirectory(paths);
const supervisor = await startSupervisor({
  paths,
  ...(process.env.HTMLVIEW_SUPERVISOR_LOCK_NONCE === undefined
    ? {}
    : { ownershipNonce: process.env.HTMLVIEW_SUPERVISOR_LOCK_NONCE }),
});

let stopping = false;
async function stop(): Promise<void> {
  if (stopping) return;
  stopping = true;
  await supervisor.close();
}

process.on("SIGINT", () => void stop().then(() => process.exit(0)));
process.on("SIGTERM", () => void stop().then(() => process.exit(0)));
process.on("uncaughtException", () => void stop().then(() => process.exit(1)));
process.on("unhandledRejection", () => void stop().then(() => process.exit(1)));
