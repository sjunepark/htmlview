import { Context, Effect } from "effect";
import type { JsonObject } from "./contracts.js";
import type { OperationalError } from "./errors.js";
import { resolveServingGrant } from "./serving/grant.js";
import { SupervisorClient } from "./supervisor/client.js";
import type {
  OptionalSessionField,
  SupervisorStateResult,
} from "./supervisor/protocol.js";

export interface CommandServiceShape {
  readonly listState: (
    fields?: readonly OptionalSessionField[],
  ) => Effect.Effect<SupervisorStateResult, OperationalError>;
  readonly serve: (
    entry: string,
    root?: string,
  ) => Effect.Effect<JsonObject, OperationalError>;
  readonly review: (
    session: string,
  ) => Effect.Effect<JsonObject, OperationalError>;
  readonly feedback: (
    review: string,
    options?: { readonly wait?: boolean; readonly after?: number },
  ) => Effect.Effect<JsonObject, OperationalError>;
  readonly deleteReview: (
    review: string,
    discardFeedback: boolean,
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

export function makeCommandService(): CommandServiceShape {
  const supervisor = new SupervisorClient();
  return {
    listState: (fields = []) => supervisor.listState(fields),
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
    review: (session) =>
      supervisor.review(session).pipe(
        Effect.map((result) => ({
          review: result.review,
          session: result.session,
          grant: result.grant,
          fidelity: result.fidelity,
        })),
      ),
    feedback: (review, options = {}) =>
      supervisor.feedback(review, options).pipe(
        Effect.map((result) => ({
          review: result.review,
          cursor: result.cursor,
          count: result.count,
          feedback: [...result.feedback],
        })),
      ),
    deleteReview: (review, discardFeedback) =>
      supervisor.deleteReview(review, discardFeedback).pipe(
        Effect.map((result) => ({
          delete: {
            review: result.delete.review,
            deleted: result.delete.deleted,
            status: result.delete.status,
            discarded: result.delete.discarded,
          },
        })),
      ),
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
