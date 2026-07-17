import { Data, Result, Schema } from "effect";

export const pathErrorCodes = [
  "path.root_not_found",
  "path.root_unreadable",
  "path.root_not_directory",
  "path.root_too_broad",
  "path.entry_not_html",
  "path.entry_not_found",
  "path.entry_unreadable",
  "path.entry_not_file",
  "path.entry_outside_root",
  "path.entry_symlink_escape",
  "path.root_contains_state",
] as const;

export const runtimeStateErrorCodes = ["state.unavailable"] as const;

export const controlErrorCodes = [
  "control.unauthorized",
  "control.shutting_down",
  "control.not_found",
  "control.response_too_large",
  "control.body_too_large",
  "control.invalid_json",
  "control.invalid_request",
  "control.session_limit",
  "control.internal",
] as const;

export const supervisorErrorCodes = [
  "supervisor.unavailable",
  "supervisor.version_mismatch",
  "supervisor.protocol_mismatch",
  "supervisor.start_failed",
  "supervisor.request_failed",
] as const;

export const contentListenerErrorCodes = [
  "http.start_failed",
  "http.readiness_failed",
] as const;

export const reviewErrorCodes = [
  "review.session_not_found",
  "review.limit",
  "review.not_found",
  "review.not_ready",
  "review.pending_feedback",
  "review.draft_not_found",
  "review.annotation_limit",
  "review.unsent_drafts",
] as const;

export const feedbackErrorCodes = [
  "feedback.cursor_ahead",
  "feedback.consumer_busy",
] as const;

export const PathErrorCode = Schema.Literals(pathErrorCodes);
export const RuntimeStateErrorCode = Schema.Literals(runtimeStateErrorCodes);
export const ControlErrorCode = Schema.Literals(controlErrorCodes);
export const SupervisorErrorCode = Schema.Literals(supervisorErrorCodes);
export const ContentListenerErrorCode = Schema.Literals(
  contentListenerErrorCodes,
);
export const ReviewErrorCode = Schema.Literals(reviewErrorCodes);
export const FeedbackErrorCode = Schema.Literals(feedbackErrorCodes);

interface OperationalErrorFields<Code> {
  readonly code: Code;
  readonly message: string;
  readonly cause?: unknown;
}

export class PathError extends Data.TaggedError("PathError")<
  OperationalErrorFields<typeof PathErrorCode.Type>
> {}

export class RuntimeStateError extends Data.TaggedError("RuntimeStateError")<
  OperationalErrorFields<typeof RuntimeStateErrorCode.Type> & {
    readonly reason?: "unavailable" | "ownership_timeout" | "ownership_changed";
  }
> {}

export class ControlError extends Data.TaggedError("ControlError")<
  OperationalErrorFields<typeof ControlErrorCode.Type>
> {}

export class SupervisorError extends Data.TaggedError("SupervisorError")<
  OperationalErrorFields<typeof SupervisorErrorCode.Type>
> {}

export class ContentListenerError extends Data.TaggedError(
  "ContentListenerError",
)<OperationalErrorFields<typeof ContentListenerErrorCode.Type>> {}

export class ReviewError extends Data.TaggedError("ReviewError")<
  OperationalErrorFields<typeof ReviewErrorCode.Type> & {
    readonly details?: {
      readonly drafts: number;
      readonly unacknowledged: number;
    };
  }
> {}

export class FeedbackError extends Data.TaggedError("FeedbackError")<
  OperationalErrorFields<typeof FeedbackErrorCode.Type>
> {}

export type OperationalError =
  | PathError
  | RuntimeStateError
  | ControlError
  | SupervisorError
  | ContentListenerError
  | ReviewError
  | FeedbackError;

export interface PublicOperationalError {
  readonly code: OperationalError["code"];
  readonly message: string;
  readonly details?: {
    readonly drafts: number;
    readonly unacknowledged: number;
  };
}

export function isOperationalError(error: unknown): error is OperationalError {
  return (
    error instanceof PathError ||
    error instanceof RuntimeStateError ||
    error instanceof ControlError ||
    error instanceof SupervisorError ||
    error instanceof ContentListenerError ||
    error instanceof ReviewError ||
    error instanceof FeedbackError
  );
}

function unreachable(value: never): never {
  throw new Error(`Unhandled operational error: ${String(value)}`);
}

export function toPublicError(error: OperationalError): PublicOperationalError {
  switch (error._tag) {
    case "PathError":
    case "RuntimeStateError":
    case "ControlError":
    case "SupervisorError":
    case "ContentListenerError":
    case "FeedbackError":
      return { code: error.code, message: error.message };
    case "ReviewError":
      return {
        code: error.code,
        message: error.message,
        ...(error.details === undefined ? {} : { details: error.details }),
      };
    default:
      return unreachable(error);
  }
}

const decodePathErrorCode = Schema.decodeUnknownResult(PathErrorCode);
const decodeRuntimeStateErrorCode = Schema.decodeUnknownResult(
  RuntimeStateErrorCode,
);
const decodeControlErrorCode = Schema.decodeUnknownResult(ControlErrorCode);
const decodeSupervisorErrorCode =
  Schema.decodeUnknownResult(SupervisorErrorCode);
const decodeContentListenerErrorCode = Schema.decodeUnknownResult(
  ContentListenerErrorCode,
);
const decodeReviewErrorCode = Schema.decodeUnknownResult(ReviewErrorCode);
const decodeFeedbackErrorCode = Schema.decodeUnknownResult(FeedbackErrorCode);

export function operationalError(
  code: unknown,
  message: string,
  details?: { readonly drafts: number; readonly unacknowledged: number },
): OperationalError | undefined {
  const pathCode = decodePathErrorCode(code);
  if (Result.isSuccess(pathCode))
    return new PathError({ code: pathCode.success, message });

  const stateCode = decodeRuntimeStateErrorCode(code);
  if (Result.isSuccess(stateCode))
    return new RuntimeStateError({ code: stateCode.success, message });

  const controlCode = decodeControlErrorCode(code);
  if (Result.isSuccess(controlCode))
    return new ControlError({ code: controlCode.success, message });

  const supervisorCode = decodeSupervisorErrorCode(code);
  if (Result.isSuccess(supervisorCode))
    return new SupervisorError({ code: supervisorCode.success, message });

  const listenerCode = decodeContentListenerErrorCode(code);
  if (Result.isSuccess(listenerCode))
    return new ContentListenerError({
      code: listenerCode.success,
      message,
    });

  const reviewCode = decodeReviewErrorCode(code);
  if (Result.isSuccess(reviewCode))
    return new ReviewError({
      code: reviewCode.success,
      message,
      ...(details === undefined ? {} : { details }),
    });

  const feedbackCode = decodeFeedbackErrorCode(code);
  if (Result.isSuccess(feedbackCode))
    return new FeedbackError({ code: feedbackCode.success, message });

  return undefined;
}
