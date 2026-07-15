import type { JsonObject, SessionSummary } from "./contracts.js";
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
  listSessions(): Promise<readonly SessionSummary[]>;
  serve(entry: string, root?: string): Promise<JsonObject>;
  stop(session?: string, all?: boolean): Promise<JsonObject>;
}

export class HtmlviewService implements CommandService {
  constructor(private readonly supervisor = new SupervisorClient()) {}

  async listSessions(): Promise<readonly SessionSummary[]> {
    return this.supervisor.list();
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

  async stop(session?: string, all = false): Promise<JsonObject> {
    try {
      const result = await this.supervisor.stop(session, all);
      return {
        stop: {
          scope: all ? "all" : "session",
          ...(session === undefined ? {} : { session }),
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
    const help = error.code.startsWith("path.")
      ? ["Run `htmlview serve --help` to review entry and root requirements"]
      : [];
    return new OperationError(error.code, error.message, help);
  }
  return new OperationError(
    "runtime.internal",
    "htmlview could not complete the request",
  );
}
