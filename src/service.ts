import type { JsonObject } from "./contracts.js";
import { Effect } from "effect";
import { resolveServingGrant } from "./serving/grant.js";
import { SupervisorClient } from "./supervisor/client.js";
import type {
  OptionalSessionField,
  SessionSummary,
} from "./supervisor/protocol.js";

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
    return Effect.runPromise(this.supervisor.list(fields));
  }

  async serve(entry: string, root?: string): Promise<JsonObject> {
    const grant = await Effect.runPromise(
      resolveServingGrant(entry, root === undefined ? {} : { root }),
    );
    const result = await Effect.runPromise(
      this.supervisor.serve(grant.routeEntry, grant.root),
    );
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
  }

  async stopSession(session: string): Promise<JsonObject> {
    const result = await Effect.runPromise(
      this.supervisor.stopSession(session),
    );
    return {
      stop: {
        scope: "session",
        session,
        stopped: result.stopped,
        status: result.stopped === 0 ? "already_stopped" : "stopped",
      },
    };
  }

  async stopAll(): Promise<JsonObject> {
    const result = await Effect.runPromise(this.supervisor.stopAll());
    return {
      stop: {
        scope: "all",
        stopped: result.stopped,
        status: result.stopped === 0 ? "already_stopped" : "stopped",
      },
    };
  }
}
