import type { SessionSummary } from "../contracts.js";

export const supervisorProtocol = "htmlview-supervisor-v1";

export interface DiscoveryRecord {
  readonly protocol: typeof supervisorProtocol;
  readonly instanceId: string;
  readonly pid: number;
  readonly port: number;
  readonly token: string;
  readonly version: string;
}

export interface SupervisorSession extends SessionSummary {
  readonly entry: string;
  readonly root: string;
  readonly createdAt: string;
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
