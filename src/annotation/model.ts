import path from "node:path";
import { Schema } from "effect";

export const maximumReviews = 128;
export const maximumTombstones = 128;
export const maximumDraftsPerReview = 32;
export const maximumEventsPerReview = 32;
export const maximumCommentBytes = 4 * 1024;
export const maximumSelectorBytes = 2 * 1024;
export const maximumDomPathBytes = 4 * 1024;
export const maximumAnchorTextBytes = 512;
export const maximumEntryBytes = 8 * 1024;
export const maximumRootBytes = 8 * 1024;

const boundedString = (maximumBytes: number) =>
  Schema.String.check(
    Schema.makeFilter((value) => Buffer.byteLength(value) <= maximumBytes, {
      expected: `a UTF-8 string of at most ${maximumBytes} bytes`,
    }),
  );
const nonEmptyBoundedString = (maximumBytes: number) =>
  boundedString(maximumBytes).check(Schema.isNonEmpty());
const containsNoNull = Schema.makeFilter<string>(
  (value) => !value.includes("\0"),
  { expected: "a string without null bytes" },
);
const Timestamp = Schema.String.check(
  Schema.makeFilter(
    (value) => {
      const parsed = new Date(value);
      return !Number.isNaN(parsed.getTime()) && parsed.toISOString() === value;
    },
    { expected: "a canonical ISO timestamp" },
  ),
);

export const ReviewIdentifierSchema = Schema.String.check(
  Schema.isPattern(/^rv_[A-Za-z0-9_-]{22}$/),
);
export const DraftIdentifierSchema = Schema.String.check(
  Schema.isPattern(/^dr_[A-Za-z0-9_-]{22}$/),
);
export const FeedbackIdentifierSchema = Schema.String.check(
  Schema.isPattern(/^fb_[A-Za-z0-9_-]{22}$/),
);
export const SessionIdentifierSchema = Schema.String.check(
  Schema.isPattern(/^[A-Za-z0-9_][A-Za-z0-9_-]{7}$/),
);
export const ReviewStatusSchema = Schema.Literals([
  "ready",
  "stopped",
  "ended",
]);
export type ReviewStatus = typeof ReviewStatusSchema.Type;

export const AnnotationSelectorSchema =
  nonEmptyBoundedString(maximumSelectorBytes);
export const AnnotationDomPathSchema =
  nonEmptyBoundedString(maximumDomPathBytes);
export const AnnotationTagSchema = nonEmptyBoundedString(128);
export const AnnotationTextSchema = boundedString(maximumAnchorTextBytes);
export const AnnotationAnchorSchema = Schema.Struct({
  selector: AnnotationSelectorSchema,
  domPath: AnnotationDomPathSchema,
  tag: AnnotationTagSchema,
  text: Schema.optionalKey(AnnotationTextSchema),
});
export type AnnotationAnchor = typeof AnnotationAnchorSchema.Type;

export const AnnotationCommentSchema =
  nonEmptyBoundedString(maximumCommentBytes);
export const AnnotationEntrySchema = nonEmptyBoundedString(
  maximumEntryBytes,
).check(Schema.isPattern(/^\//), containsNoNull);
export const AnnotationRevisionSchema = Schema.String.check(
  Schema.isPattern(/^sha256:[0-9a-f]{64}$/),
);

const commentFields = {
  comment: AnnotationCommentSchema,
  entry: AnnotationEntrySchema,
  revision: AnnotationRevisionSchema,
};

export const AnnotationDraftSchema = Schema.Union([
  Schema.Struct({
    id: DraftIdentifierSchema,
    kind: Schema.Literal("element"),
    ...commentFields,
    anchor: AnnotationAnchorSchema,
  }),
  Schema.Struct({
    id: DraftIdentifierSchema,
    kind: Schema.Literal("freeform"),
    ...commentFields,
  }),
]);
export type AnnotationDraft = typeof AnnotationDraftSchema.Type;

export const FeedbackEventSchema = Schema.Union([
  Schema.Struct({
    id: FeedbackIdentifierSchema,
    position: Schema.Int.check(
      Schema.isBetween({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
    ),
    kind: Schema.Literal("element"),
    ...commentFields,
    anchor: AnnotationAnchorSchema,
  }),
  Schema.Struct({
    id: FeedbackIdentifierSchema,
    position: Schema.Int.check(
      Schema.isBetween({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
    ),
    kind: Schema.Literal("freeform"),
    ...commentFields,
  }),
]);
export type FeedbackEvent = typeof FeedbackEventSchema.Type;

export const PersistedReviewSchema = Schema.Struct({
  id: ReviewIdentifierSchema,
  identity: Schema.Struct({
    root: nonEmptyBoundedString(maximumRootBytes).check(
      Schema.makeFilter(path.isAbsolute, { expected: "an absolute path" }),
      containsNoNull,
    ),
    entry: AnnotationEntrySchema,
  }),
  status: ReviewStatusSchema,
  session: SessionIdentifierSchema,
  drafts: Schema.Array(AnnotationDraftSchema).check(
    Schema.isMaxLength(maximumDraftsPerReview),
  ),
  events: Schema.Array(FeedbackEventSchema).check(
    Schema.isMaxLength(maximumEventsPerReview),
  ),
  nextCursor: Schema.Int.check(
    Schema.isBetween({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
  ),
  acknowledgedCursor: Schema.Int.check(
    Schema.isBetween({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
  ),
  highestDeliveredCursor: Schema.Int.check(
    Schema.isBetween({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
  ),
});
export type PersistedReview = typeof PersistedReviewSchema.Type;

export const ReviewTombstoneSchema = Schema.Union([
  Schema.Struct({
    id: ReviewIdentifierSchema,
    kind: Schema.Literal("completed"),
    session: SessionIdentifierSchema,
    terminalCursor: Schema.Int.check(
      Schema.isBetween({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
    ),
    expiresAt: Timestamp,
  }),
  Schema.Struct({
    id: ReviewIdentifierSchema,
    kind: Schema.Literal("deleted"),
    expiresAt: Timestamp,
    discardedDrafts: Schema.Int.check(
      Schema.isBetween({ minimum: 0, maximum: maximumDraftsPerReview }),
    ),
    discardedFeedback: Schema.Int.check(
      Schema.isBetween({ minimum: 0, maximum: maximumEventsPerReview }),
    ),
  }),
]);
export type ReviewTombstone = typeof ReviewTombstoneSchema.Type;

export const AnnotationStateSchema = Schema.Struct({
  version: Schema.Literal(1),
  reviews: Schema.Array(PersistedReviewSchema).check(
    Schema.isMaxLength(maximumReviews),
  ),
  tombstones: Schema.Array(ReviewTombstoneSchema).check(
    Schema.isMaxLength(maximumTombstones),
  ),
});
export type AnnotationState = typeof AnnotationStateSchema.Type;

export function emptyAnnotationState(): AnnotationState {
  return { version: 1, reviews: [], tombstones: [] };
}

export function annotationStateIsConsistent(state: AnnotationState): boolean {
  const reviewIds = new Set<string>();
  const openIdentities = new Set<string>();
  for (const review of state.reviews) {
    if (reviewIds.has(review.id)) return false;
    reviewIds.add(review.id);
    const identity = `${review.identity.entry}\0${review.identity.root}`;
    if (review.status !== "ended") {
      if (openIdentities.has(identity)) return false;
      openIdentities.add(identity);
    }
    if (review.status === "ended" && review.drafts.length > 0) return false;
    if (
      review.acknowledgedCursor > review.highestDeliveredCursor ||
      review.highestDeliveredCursor >= review.nextCursor
    )
      return false;
    const draftIds = new Set<string>();
    for (const draft of review.drafts) {
      if (draftIds.has(draft.id) || draft.entry !== review.identity.entry)
        return false;
      draftIds.add(draft.id);
    }
    const eventIds = new Set<string>();
    for (let index = 0; index < review.events.length; index += 1) {
      const event = review.events[index];
      if (
        event === undefined ||
        event.position !== review.acknowledgedCursor + index + 1 ||
        eventIds.has(event.id) ||
        event.entry !== review.identity.entry
      )
        return false;
      eventIds.add(event.id);
    }
    if (
      review.acknowledgedCursor + review.events.length !==
      review.nextCursor - 1
    )
      return false;
  }
  const tombstoneIds = new Set<string>();
  for (const tombstone of state.tombstones) {
    if (reviewIds.has(tombstone.id) || tombstoneIds.has(tombstone.id))
      return false;
    tombstoneIds.add(tombstone.id);
  }
  return true;
}
