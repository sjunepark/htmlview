import type { SessionSummary } from "../contracts.js";

export const supervisorProtocol = "htmlview-supervisor-v2";
export const controlHost = "htmlview-control";
export const maximumConcurrentSessions = 32;
export const maximumControlResponseBytes = 1024 * 1024;

export interface SupervisorIdentity {
  readonly protocol: typeof supervisorProtocol;
  readonly instanceId: string;
  readonly pid: number;
  readonly version: string;
}

export interface SupervisorSession extends SessionSummary {
  readonly entry: string;
  readonly root: string;
}

export interface SessionListResult {
  readonly sessions: SessionSummary[];
}

export interface ServeControlResult {
  readonly session: SupervisorSession;
  readonly reused: boolean;
}

export interface StopControlResult {
  readonly stopped: number;
}

export interface ControlError {
  readonly error: {
    readonly code: string;
    readonly message: string;
  };
}
