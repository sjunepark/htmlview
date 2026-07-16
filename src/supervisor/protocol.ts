import { Schema } from "effect";
import {
  maximumReviews,
  ReviewIdentifierSchema,
  ReviewStatusSchema,
  SessionIdentifierSchema,
} from "../annotation/model.js";
export { ReviewStatusSchema } from "../annotation/model.js";
import {
  ContentListenerErrorCode,
  ControlErrorCode,
  PathErrorCode,
  ReviewErrorCode,
  RuntimeStateErrorCode,
} from "../errors.js";

export const supervisorProtocol = "htmlview-supervisor-v4";
export const controlHost = "htmlview-control";
export const maximumConcurrentSessions = 32;
export const maximumRetainedReviews = maximumReviews;
export const maximumControlBodyBytes = 64 * 1024;
export const maximumControlResponseBytes = 1024 * 1024;

const strict = { onExcessProperty: "error" } as const;
const RequestString = Schema.String.check(
  Schema.isMaxLength(maximumControlBodyBytes),
);
const ResponseString = Schema.String.check(
  Schema.isMaxLength(maximumControlResponseBytes),
);
const ResponsePath = ResponseString.check(Schema.isNonEmpty());
const SessionIdentifier = SessionIdentifierSchema;
const ReviewIdentifier = ReviewIdentifierSchema;
const SessionSelector = RequestString;
const SessionUrl = ResponseString.check(
  Schema.makeFilter(
    (value) => {
      try {
        const url = new URL(value);
        const port = Number(url.port);
        return (
          url.protocol === "http:" &&
          /^h-[0-9a-f]{32}\.localhost$/.test(url.hostname) &&
          Number.isInteger(port) &&
          port >= 1 &&
          port <= 65_535 &&
          url.username === "" &&
          url.password === "" &&
          url.pathname.startsWith("/") &&
          url.search === "" &&
          url.hash === "" &&
          value === url.href
        );
      } catch {
        return false;
      }
    },
    { expected: "an htmlview loopback session URL" },
  ),
);
const ReviewShellUrl = ResponseString.check(
  Schema.makeFilter(
    (value) => {
      try {
        const url = new URL(value);
        const port = Number(url.port);
        return (
          url.protocol === "http:" &&
          /^r-[0-9a-f]{32}\.localhost$/.test(url.hostname) &&
          Number.isInteger(port) &&
          port >= 1 &&
          port <= 65_535 &&
          url.username === "" &&
          url.password === "" &&
          url.pathname === "/" &&
          url.search === "" &&
          url.hash === "" &&
          value === `${url.origin}/`
        );
      } catch {
        return false;
      }
    },
    { expected: "an htmlview review-shell URL" },
  ),
);
const SupervisorInstanceId = Schema.String.check(Schema.isUUID(4)).pipe(
  Schema.brand("SupervisorInstanceId"),
);
const ProcessId = Schema.Int.check(
  Schema.isBetween({ minimum: 1, maximum: 2_147_483_647 }),
);

export const OptionalSessionFieldSchema = Schema.Literals(["entry", "root"]);
export type OptionalSessionField = typeof OptionalSessionFieldSchema.Type;

export const SessionFieldSelectionSchema = Schema.Array(
  OptionalSessionFieldSchema,
).check(Schema.isMaxLength(2), Schema.isUnique());
export type SessionFieldSelection = typeof SessionFieldSelectionSchema.Type;

export const SupervisorIdentitySchema = Schema.Struct({
  protocol: ResponseString.check(Schema.isNonEmpty()),
  instanceId: SupervisorInstanceId,
  pid: ProcessId,
  version: ResponseString.check(Schema.isNonEmpty()),
});
export type SupervisorIdentity = typeof SupervisorIdentitySchema.Type;

export const CurrentSupervisorIdentitySchema = Schema.Struct({
  protocol: Schema.Literal(supervisorProtocol),
  instanceId: SupervisorInstanceId,
  pid: ProcessId,
  version: ResponseString.check(Schema.isNonEmpty()),
});
export type CurrentSupervisorIdentity =
  typeof CurrentSupervisorIdentitySchema.Type;

export const makeSupervisorInstanceId = SupervisorInstanceId.make;

export const SessionSummarySchema = Schema.Struct({
  id: SessionIdentifier,
  status: Schema.Literal("ready"),
  url: SessionUrl,
  entry: Schema.optionalKey(ResponsePath),
  root: Schema.optionalKey(ResponsePath),
});
export type SessionSummary = typeof SessionSummarySchema.Type;

export const SupervisorSessionSchema = Schema.Struct({
  id: SessionIdentifier,
  status: Schema.Literal("ready"),
  url: SessionUrl,
  entry: ResponsePath,
  root: ResponsePath,
});
export type SupervisorSession = typeof SupervisorSessionSchema.Type;

export type ReviewStatus = typeof ReviewStatusSchema.Type;

export const ReviewSummarySchema = Schema.Struct({
  id: ReviewIdentifier,
  status: ReviewStatusSchema,
  session: SessionIdentifier,
  drafts: Schema.Int.check(
    Schema.isBetween({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
  ),
  unacknowledged: Schema.Int.check(
    Schema.isBetween({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
  ),
});
export type ReviewSummary = typeof ReviewSummarySchema.Type;

export const ReviewControlResultSchema = Schema.Struct({
  review: Schema.Struct({
    id: ReviewIdentifier,
    status: Schema.Literal("ready"),
    url: ReviewShellUrl,
    reused: Schema.Boolean,
  }),
  session: Schema.Struct({
    id: SessionIdentifier,
    url: SessionUrl,
  }),
  grant: Schema.Struct({
    root: ResponsePath,
    access: Schema.Literal("read_all_regular_files_beneath_root"),
  }),
  fidelity: Schema.Literal("instrumented_review"),
});
export type ReviewControlResult = typeof ReviewControlResultSchema.Type;

export const SessionListResultSchema = Schema.Struct({
  sessions: Schema.Array(SessionSummarySchema).check(
    Schema.isMaxLength(maximumConcurrentSessions),
  ),
});
export type SessionListResult = typeof SessionListResultSchema.Type;

export const SupervisorStateResultSchema = Schema.Struct({
  sessions: Schema.Array(SessionSummarySchema).check(
    Schema.isMaxLength(maximumConcurrentSessions),
  ),
  reviews: Schema.Array(ReviewSummarySchema).check(
    Schema.isMaxLength(maximumRetainedReviews),
  ),
});
export type SupervisorStateResult = typeof SupervisorStateResultSchema.Type;

export const ServeControlResultSchema = Schema.Struct({
  session: SupervisorSessionSchema,
  reused: Schema.Boolean,
});
export type ServeControlResult = typeof ServeControlResultSchema.Type;

export const StopControlResultSchema = Schema.Struct({
  stopped: Schema.Int.check(
    Schema.isBetween({ minimum: 0, maximum: maximumConcurrentSessions }),
  ),
});
export type StopControlResult = typeof StopControlResultSchema.Type;

export const TargetedStopControlResultSchema = Schema.Struct({
  stopped: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 1 })),
});
export type TargetedStopControlResult =
  typeof TargetedStopControlResultSchema.Type;

export const CreateSessionRequestSchema = Schema.Struct({
  entry: RequestString,
  root: RequestString,
});
export type CreateSessionRequest = typeof CreateSessionRequestSchema.Type;

export const StopSessionRequestSchema = Schema.Struct({
  session: SessionSelector,
});
export type StopSessionRequest = typeof StopSessionRequestSchema.Type;

export const CreateReviewRequestSchema = Schema.Struct({
  session: SessionIdentifier,
});
export type CreateReviewRequest = typeof CreateReviewRequestSchema.Type;

export const ShutdownRequestSchema = Schema.Record(Schema.String, Schema.Never);
export type ShutdownRequest = typeof ShutdownRequestSchema.Type;

export const WireErrorCodeSchema = Schema.Union([
  PathErrorCode,
  ControlErrorCode,
  ContentListenerErrorCode,
  ReviewErrorCode,
  RuntimeStateErrorCode,
]);
export type WireErrorCode = typeof WireErrorCodeSchema.Type;

export const ControlErrorResponseSchema = Schema.Struct({
  error: Schema.Struct({
    code: WireErrorCodeSchema,
    message: ResponseString.check(Schema.isNonEmpty()),
  }),
});
export type ControlErrorResponse = typeof ControlErrorResponseSchema.Type;

export const decodeSupervisorIdentity = Schema.decodeUnknownResult(
  SupervisorIdentitySchema,
  strict,
);
export const decodeCurrentSupervisorIdentity = Schema.decodeUnknownResult(
  CurrentSupervisorIdentitySchema,
  strict,
);
export const decodeSessionFieldSelection = Schema.decodeUnknownResult(
  SessionFieldSelectionSchema,
  strict,
);
export const decodeSessionListResult = Schema.decodeUnknownResult(
  SessionListResultSchema,
  strict,
);
export const decodeServeControlResult = Schema.decodeUnknownResult(
  ServeControlResultSchema,
  strict,
);
export const decodeSupervisorStateResult = Schema.decodeUnknownResult(
  SupervisorStateResultSchema,
  strict,
);
export const decodeReviewControlResult = Schema.decodeUnknownResult(
  ReviewControlResultSchema,
  strict,
);
export const decodeStopControlResult = Schema.decodeUnknownResult(
  StopControlResultSchema,
  strict,
);
export const decodeTargetedStopControlResult = Schema.decodeUnknownResult(
  TargetedStopControlResultSchema,
  strict,
);
export const decodeCreateSessionRequest = Schema.decodeUnknownResult(
  CreateSessionRequestSchema,
  strict,
);
export const decodeStopSessionRequest = Schema.decodeUnknownResult(
  StopSessionRequestSchema,
  strict,
);
export const decodeCreateReviewRequest = Schema.decodeUnknownResult(
  CreateReviewRequestSchema,
  strict,
);
export const decodeShutdownRequest = Schema.decodeUnknownResult(
  ShutdownRequestSchema,
  strict,
);
export const decodeControlError = Schema.decodeUnknownResult(
  ControlErrorResponseSchema,
  strict,
);

export const encodeSupervisorIdentity = Schema.encodeSync(
  CurrentSupervisorIdentitySchema,
  strict,
);
export const encodeSessionListResult = Schema.encodeSync(
  SessionListResultSchema,
  strict,
);
export const encodeSupervisorStateResult = Schema.encodeSync(
  SupervisorStateResultSchema,
  strict,
);
export const encodeReviewControlResult = Schema.encodeSync(
  ReviewControlResultSchema,
  strict,
);
export const encodeServeControlResult = Schema.encodeSync(
  ServeControlResultSchema,
  strict,
);
export const encodeStopControlResult = Schema.encodeSync(
  StopControlResultSchema,
  strict,
);
export const encodeTargetedStopControlResult = Schema.encodeSync(
  TargetedStopControlResultSchema,
  strict,
);
export const encodeCreateSessionRequest = Schema.encodeSync(
  CreateSessionRequestSchema,
  strict,
);
export const encodeStopSessionRequest = Schema.encodeSync(
  StopSessionRequestSchema,
  strict,
);
export const encodeCreateReviewRequest = Schema.encodeSync(
  CreateReviewRequestSchema,
  strict,
);
export const encodeShutdownRequest = Schema.encodeSync(
  ShutdownRequestSchema,
  strict,
);
export const encodeControlError = Schema.encodeSync(
  ControlErrorResponseSchema,
  strict,
);
