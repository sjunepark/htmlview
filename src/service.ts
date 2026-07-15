import { Context, Effect } from "effect";
import type { JsonObject } from "./contracts.js";
import type { OperationalError } from "./errors.js";
import { resolveServingGrant } from "./serving/grant.js";
import { SupervisorClient } from "./supervisor/client.js";
import type {
  OptionalSessionField,
  SessionSummary,
} from "./supervisor/protocol.js";

export interface CommandServiceShape {
  readonly listSessions: (
    fields?: readonly OptionalSessionField[],
  ) => Effect.Effect<readonly SessionSummary[], OperationalError>;
  readonly serve: (
    entry: string,
    root?: string,
  ) => Effect.Effect<JsonObject, OperationalError>;
  readonly stopSession: (
    session: string,
  ) => Effect.Effect<JsonObject, OperationalError>;
  readonly stopAll: () => Effect.Effect<JsonObject, OperationalError>;
}

export class CommandService extends Context.Service<
  CommandService,
  CommandServiceShape
>()("htmlview/CommandService") {}

export function makeCommandService(
  supervisor = new SupervisorClient(),
): CommandServiceShape {
  return {
    listSessions: (fields = []) => supervisor.list(fields),
    serve: (entry, root) =>
      Effect.gen(function* () {
        const grant = yield* resolveServingGrant(
          entry,
          root === undefined ? {} : { root },
        );
        const result = yield* supervisor.serve(grant.routeEntry, grant.root);
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
      }),
    stopSession: (session) =>
      supervisor.stopSession(session).pipe(
        Effect.map((result) => ({
          stop: {
            scope: "session",
            session,
            stopped: result.stopped,
            status: result.stopped === 0 ? "already_stopped" : "stopped",
          },
        })),
      ),
    stopAll: () =>
      supervisor.stopAll().pipe(
        Effect.map((result) => ({
          stop: {
            scope: "all",
            stopped: result.stopped,
            status: result.stopped === 0 ? "already_stopped" : "stopped",
          },
        })),
      ),
  };
}
