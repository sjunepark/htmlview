import { Result, Schema } from "effect";
import {
  AnnotationCommentSchema,
  AnnotationDomPathSchema,
  AnnotationRevisionSchema,
  AnnotationSelectorSchema,
  AnnotationTagSchema,
  AnnotationTextSchema,
  DraftIdentifierSchema,
  maximumDraftsPerReview,
} from "../annotation/model.js";

const strict = { onExcessProperty: "error" } as const;

export const ActivateProbeRequestSchema = Schema.Struct({
  lease: Schema.String.check(Schema.isPattern(/^[0-9a-f]{32}$/)),
});
export type ActivateProbeRequest = typeof ActivateProbeRequestSchema.Type;

export const QueueDraftRequestSchema = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("element"),
    comment: AnnotationCommentSchema,
    revision: AnnotationRevisionSchema,
    anchor: Schema.Struct({
      selector: AnnotationSelectorSchema,
      dom_path: AnnotationDomPathSchema,
      tag: AnnotationTagSchema,
      text: Schema.optionalKey(AnnotationTextSchema),
    }),
  }),
  Schema.Struct({
    kind: Schema.Literal("freeform"),
    comment: AnnotationCommentSchema,
    revision: AnnotationRevisionSchema,
  }),
]);
export type QueueDraftRequest = typeof QueueDraftRequestSchema.Type;

const SelectedDraftsSchema = Schema.Array(DraftIdentifierSchema).check(
  Schema.isMaxLength(maximumDraftsPerReview),
  Schema.isUnique(),
);

export const SendDraftsRequestSchema = Schema.Struct({
  drafts: SelectedDraftsSchema,
});
export type SendDraftsRequest = typeof SendDraftsRequestSchema.Type;

export const EndReviewRequestSchema = Schema.Struct({
  drafts: SelectedDraftsSchema,
  discard_remaining: Schema.Boolean,
});
export type EndReviewRequest = typeof EndReviewRequestSchema.Type;

export const decodeQueueDraftRequest = Schema.decodeUnknownResult(
  QueueDraftRequestSchema,
  strict,
);
export const decodeActivateProbeRequest = Schema.decodeUnknownResult(
  ActivateProbeRequestSchema,
  strict,
);
export const decodeSendDraftsRequest = Schema.decodeUnknownResult(
  SendDraftsRequestSchema,
  strict,
);
export const decodeEndReviewRequest = Schema.decodeUnknownResult(
  EndReviewRequestSchema,
  strict,
);

export function decodedOrUndefined<A>(
  result: Result.Result<A, unknown>,
): A | undefined {
  return Result.isSuccess(result) ? result.success : undefined;
}
