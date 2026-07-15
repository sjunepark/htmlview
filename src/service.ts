import type {
  JsonObject,
  OptionalSessionField,
  SessionSummary,
} from "./contracts.js";
import { GrantError, resolveServingGrant } from "./serving/grant.js";
import {
  SupervisorClient,
  SupervisorClientError,
} from "./supervisor/client.js";

export class OperationError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly help: readonly string[] = [],
  ) {
    super(message);
    this.name = "OperationError";
  }
}

export interface CommandService {
  listSessions(
    fields?: readonly OptionalSessionField[],
  ): Promise<readonly SessionSummary[]>;
  serve(entry: string, root?: string): Promise<JsonObject>;
  stopSession(session: string): Promise<JsonObject>;
  stopAll(): Promise<JsonObject>;
}

export class HtmlviewService implements CommandService {
  constructor(private readonly supervisor = new SupervisorClient()) {}

  async listSessions(
    fields: readonly OptionalSessionField[] = [],
  ): Promise<readonly SessionSummary[]> {
    try {
      return await this.supervisor.list(fields);
    } catch (error) {
      throw translate(error);
    }
  }

  async serve(entry: string, root?: string): Promise<JsonObject> {
    try {
      const grant = await resolveServingGrant(
        entry,
        root === undefined ? {} : { root },
      );
      const result = await this.supervisor.serve(grant.routeEntry, grant.root);
      return {
        session: {
          id: result.session.id,
          status: result.session.status,
          url: result.session.url,
          reused: result.reused,
        },
        grant: {
          root: result.session.root,
          access: "read_all_regular_files_beneath_root",
        },
      };
    } catch (error) {
      throw translate(error);
    }
  }

  async stopSession(session: string): Promise<JsonObject> {
    try {
      const result = await this.supervisor.stopSession(session);
      return {
        stop: {
          scope: "session",
          session,
          stopped: result.stopped,
          status: result.stopped === 0 ? "already_stopped" : "stopped",
        },
      };
    } catch (error) {
      throw translate(error);
    }
  }

  async stopAll(): Promise<JsonObject> {
    try {
      const result = await this.supervisor.stopAll();
      return {
        stop: {
          scope: "all",
          stopped: result.stopped,
          status: result.stopped === 0 ? "already_stopped" : "stopped",
        },
      };
    } catch (error) {
      throw translate(error);
    }
  }
}

function translate(error: unknown): OperationError {
  if (error instanceof OperationError) return error;
  if (error instanceof GrantError || error instanceof SupervisorClientError) {
    return new OperationError(error.code, error.message);
  }
  return new OperationError(
    "runtime.internal",
    "htmlview could not complete the request",
  );
}
