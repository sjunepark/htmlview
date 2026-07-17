import { randomBytes } from "node:crypto";
import { Clock, Deferred, Effect, Semaphore } from "effect";
import { FeedbackError, ReviewError, RuntimeStateError } from "../errors.js";
import type { StatePaths } from "../supervisor/state.js";
import {
  maximumReviews,
  maximumDraftsPerReview,
  maximumEventsPerReview,
  maximumTombstones,
  type AnnotationDraft,
  type AnnotationState,
  type FeedbackEvent,
  type PersistedReview,
} from "./model.js";
import {
  annotationStateFitsMutationBounds,
  saveAnnotationState,
} from "./store.js";

export interface ReviewIdentity {
  readonly root: string;
  readonly entry: string;
}

export interface ReviewSummaryRecord {
  readonly id: string;
  readonly status: PersistedReview["status"];
  readonly session: string;
  readonly drafts: number;
  readonly unacknowledged: number;
}

export type AnnotationDraftInput =
  | Omit<Extract<AnnotationDraft, { readonly kind: "element" }>, "id">
  | Omit<Extract<AnnotationDraft, { readonly kind: "freeform" }>, "id">;

type DeliveredFeedbackFields = Omit<
  Extract<FeedbackEvent, { readonly kind: "freeform" }>,
  "position" | "kind"
>;
export type DeliveredFeedback =
  | (DeliveredFeedbackFields & {
      readonly kind: "element";
      readonly anchor: {
        readonly selector: string;
        readonly dom_path: string;
        readonly tag: string;
        readonly text?: string;
      };
    })
  | (DeliveredFeedbackFields & { readonly kind: "freeform" });

export interface FeedbackReadResult {
  readonly review: {
    readonly id: string;
    readonly status: PersistedReview["status"];
  };
  readonly cursor: number;
  readonly count: number;
  readonly feedback: readonly DeliveredFeedback[];
}

export interface DeleteReviewResult {
  readonly review: string;
  readonly deleted: 1;
  readonly discardedDrafts: number;
  readonly discardedFeedback: number;
}

interface ReviewWaiter {
  readonly token: symbol;
  readonly signal: Deferred.Deferred<void>;
}

type PreparedFeedback =
  | { readonly kind: "result"; readonly result: FeedbackReadResult }
  | { readonly kind: "wait"; readonly waiter: ReviewWaiter };

type PreparedDelete =
  | { readonly kind: "result"; readonly result: DeleteReviewResult }
  | { readonly kind: "prepared"; readonly reservation: DeleteReservation };

interface DeleteReservation {
  readonly token: symbol;
  readonly reviewId: string;
  readonly review: PersistedReview | undefined;
  readonly tombstone: AnnotationState["tombstones"][number] | undefined;
}

const tombstoneRetentionMilliseconds = 24 * 60 * 60 * 1000;

export function generateDraftId(
  random: (size: number) => Buffer = randomBytes,
): string {
  return `dr_${random(16).toString("base64url")}`;
}

export function generateFeedbackId(
  random: (size: number) => Buffer = randomBytes,
): string {
  return `fb_${random(16).toString("base64url")}`;
}

type SaveState = (
  paths: StatePaths,
  state: AnnotationState,
) => Effect.Effect<void, RuntimeStateError>;

function sameIdentity(left: ReviewIdentity, right: ReviewIdentity): boolean {
  return left.root === right.root && left.entry === right.entry;
}

export class AnnotationRegistry {
  readonly #mutations = Semaphore.makeUnsafe(1);
  readonly #waiters = new Map<string, ReviewWaiter>();
  readonly #deleteReservations = new Map<string, DeleteReservation>();
  #state: AnnotationState;

  constructor(
    private readonly paths: StatePaths,
    initialState: AnnotationState,
    private readonly maximumRetainedReviews = maximumReviews,
    private readonly save: SaveState = saveAnnotationState,
  ) {
    this.#state = initialState;
  }

  summaries(): ReviewSummaryRecord[] {
    return this.#state.reviews.map((review) => ({
      id: review.id,
      status: review.status,
      session: review.session,
      drafts: review.drafts.length,
      unacknowledged: review.events.length,
    }));
  }

  hasIdentifier(id: string): boolean {
    return (
      this.#state.reviews.some((review) => review.id === id) ||
      this.#state.tombstones.some((tombstone) => tombstone.id === id)
    );
  }

  openReview(identity: ReviewIdentity): PersistedReview | undefined {
    return this.#state.reviews.find(
      (review) =>
        review.status !== "ended" && sameIdentity(review.identity, identity),
    );
  }

  review(id: string): PersistedReview | undefined {
    return this.#state.reviews.find((review) => review.id === id);
  }

  createReady(input: {
    readonly id: string;
    readonly identity: ReviewIdentity;
    readonly session: string;
  }): Effect.Effect<PersistedReview, ReviewError | RuntimeStateError> {
    return this.#mutations.withPermit(
      Effect.gen({ self: this }, function* () {
        if (this.hasIdentifier(input.id))
          return yield* new ReviewError({
            code: "review.limit",
            message:
              "A generated review identifier collided with retained state",
          });
        if (this.openReview(input.identity) !== undefined)
          return yield* new ReviewError({
            code: "review.not_ready",
            message: "An open review already exists for the selected entry",
          });
        if (this.#state.reviews.length >= this.maximumRetainedReviews)
          return yield* new ReviewError({
            code: "review.limit",
            message: `Retained review limit of ${this.maximumRetainedReviews} reached`,
          });
        const record: PersistedReview = {
          id: input.id,
          identity: input.identity,
          status: "ready",
          session: input.session,
          drafts: [],
          events: [],
          nextCursor: 1,
          acknowledgedCursor: 0,
          highestDeliveredCursor: 0,
        };
        const state = {
          ...this.#state,
          reviews: [...this.#state.reviews, record],
        };
        if (!annotationStateFitsMutationBounds(state))
          return yield* new ReviewError({
            code: "review.limit",
            message: "The retained review storage limit has been reached",
          });
        yield* this.#replace(state);
        return record;
      }),
    );
  }

  resumeReady(
    id: string,
    session: string,
  ): Effect.Effect<PersistedReview, ReviewError | RuntimeStateError> {
    return this.#mutations.withPermit(
      Effect.gen({ self: this }, function* () {
        if (this.#deleteReservations.has(id))
          return yield* new ReviewError({
            code: "review.not_ready",
            message: "The review is being deleted",
          });
        const index = this.#state.reviews.findIndex(
          (review) => review.id === id,
        );
        const existing = this.#state.reviews[index];
        if (existing === undefined || existing.status !== "stopped")
          return yield* new ReviewError({
            code: "review.session_not_found",
            message: "The stopped review is not available to resume",
          });
        const record: PersistedReview = {
          ...existing,
          status: "ready",
          session,
        };
        const reviews = [...this.#state.reviews];
        reviews[index] = record;
        yield* this.#replace({ ...this.#state, reviews });
        return record;
      }),
    );
  }

  stopReadyForSessions(
    sessionIds: readonly string[],
  ): Effect.Effect<void, RuntimeStateError> {
    return this.#mutations.withPermit(
      Effect.gen({ self: this }, function* () {
        const selected = new Set(sessionIds);
        let changed = false;
        const reviews = this.#state.reviews.map((review) => {
          if (!selected.has(review.session) || review.status !== "ready")
            return review;
          changed = true;
          return { ...review, status: "stopped" as const };
        });
        if (changed) {
          yield* this.#replace({ ...this.#state, reviews });
          for (const review of reviews)
            if (selected.has(review.session)) this.#wake(review.id);
        }
      }),
    );
  }

  queueDraft(
    reviewId: string,
    input: AnnotationDraftInput,
  ): Effect.Effect<AnnotationDraft, ReviewError | RuntimeStateError> {
    return this.#mutations.withPermit(
      Effect.gen({ self: this }, function* () {
        const index = this.#reviewIndex(reviewId);
        const review = this.#state.reviews[index];
        if (review === undefined) return yield* this.#reviewNotFound(reviewId);
        if (review.status !== "ready")
          return yield* new ReviewError({
            code: "review.not_ready",
            message: "The review is not accepting annotations",
          });
        if (review.drafts.length >= maximumDraftsPerReview)
          return yield* new ReviewError({
            code: "review.annotation_limit",
            message: `Queued annotation limit of ${maximumDraftsPerReview} reached`,
          });
        let id: string;
        do id = generateDraftId();
        while (review.drafts.some((draft) => draft.id === id));
        const draft = { id, ...input } as AnnotationDraft;
        const updated: PersistedReview = {
          ...review,
          drafts: [...review.drafts, draft],
        };
        if (!this.#fitsStorage(index, updated))
          return yield* this.#annotationStorageLimit();
        yield* this.#replaceReview(index, updated);
        return draft;
      }),
    );
  }

  sendDrafts(
    reviewId: string,
    draftIds: readonly string[],
    options: {
      readonly end?: boolean;
      readonly discardRemaining?: boolean;
    } = {},
  ): Effect.Effect<
    {
      readonly sent: number;
      readonly discarded: number;
      readonly status: PersistedReview["status"];
    },
    ReviewError | RuntimeStateError
  > {
    return this.#mutations.withPermit(
      Effect.gen({ self: this }, function* () {
        const index = this.#reviewIndex(reviewId);
        const review = this.#state.reviews[index];
        if (review === undefined) return yield* this.#reviewNotFound(reviewId);
        if (review.status !== "ready")
          return yield* new ReviewError({
            code: "review.not_ready",
            message: "The review is not accepting annotations",
          });
        const selectedIds = new Set(draftIds);
        const selected = review.drafts.filter((draft) =>
          selectedIds.has(draft.id),
        );
        if (
          selectedIds.size !== draftIds.length ||
          selected.length !== selectedIds.size
        )
          return yield* new ReviewError({
            code: "review.draft_not_found",
            message: "One or more annotation drafts are not available",
          });
        const end = options.end === true;
        const discardRemaining = options.discardRemaining === true;
        if (discardRemaining && !end)
          return yield* new ReviewError({
            code: "review.unsent_drafts",
            message: "Draft discard is only available while ending a review",
          });
        const unsent = review.drafts.filter(
          (draft) => !selectedIds.has(draft.id),
        );
        if (end && !discardRemaining && unsent.length > 0)
          return yield* new ReviewError({
            code: "review.unsent_drafts",
            message:
              "Send or remove every queued draft before ending the review",
          });
        const remaining = discardRemaining ? [] : unsent;
        if (
          review.events.length + selected.length > maximumEventsPerReview ||
          review.nextCursor + selected.length > Number.MAX_SAFE_INTEGER
        )
          return yield* new ReviewError({
            code: "review.annotation_limit",
            message: `Unacknowledged feedback limit of ${maximumEventsPerReview} reached`,
          });
        const events = [...review.events];
        const eventIds = new Set(events.map((event) => event.id));
        for (let offset = 0; offset < selected.length; offset += 1) {
          const draft = selected[offset];
          if (draft === undefined) continue;
          let id: string;
          do id = generateFeedbackId();
          while (eventIds.has(id));
          eventIds.add(id);
          events.push({
            ...draft,
            id,
            position: review.nextCursor + offset,
          });
        }
        const updated: PersistedReview = {
          ...review,
          status: end ? "ended" : review.status,
          drafts: remaining,
          events,
          nextCursor: review.nextCursor + selected.length,
        };
        if (!this.#fitsStorage(index, updated))
          return yield* this.#annotationStorageLimit();
        if (end && events.length === 0) {
          const now = yield* Clock.currentTimeMillis;
          yield* this.#replaceWithCompletedTombstone(index, updated, now);
        } else yield* this.#replaceReview(index, updated);
        if (selected.length > 0 || end) this.#wake(reviewId);
        return {
          sent: selected.length,
          discarded: discardRemaining ? unsent.length : 0,
          status: end ? "ended" : "ready",
        };
      }),
    );
  }

  feedback(
    reviewId: string,
    options: { readonly after?: number; readonly wait?: boolean } = {},
  ): Effect.Effect<
    FeedbackReadResult,
    ReviewError | FeedbackError | RuntimeStateError
  > {
    return Effect.gen({ self: this }, function* () {
      const prepared = yield* this.#mutations.withPermit(
        this.#prepareFeedback(reviewId, options.after, options.wait === true),
      );
      if (prepared.kind === "result") return prepared.result;
      yield* Deferred.await(prepared.waiter.signal).pipe(
        Effect.ensuring(this.#removeWaiter(reviewId, prepared.waiter)),
      );
      return yield* this.feedback(reviewId);
    });
  }

  deleteReview(
    reviewId: string,
    discardFeedback: boolean,
    closeLiveReview: Effect.Effect<void> = Effect.void,
  ): Effect.Effect<DeleteReviewResult, ReviewError | RuntimeStateError> {
    return Effect.uninterruptible(
      Effect.gen({ self: this }, function* () {
        const prepared = yield* this.#mutations.withPermit(
          this.#prepareDelete(reviewId, discardFeedback),
        );
        if (prepared.kind === "result") return prepared.result;
        return yield* Effect.gen({ self: this }, function* () {
          yield* closeLiveReview;
          return yield* this.#mutations.withPermit(
            this.#commitDelete(prepared.reservation, discardFeedback),
          );
        }).pipe(Effect.ensuring(this.#releaseDelete(prepared.reservation)));
      }),
    );
  }

  #prepareDelete(
    reviewId: string,
    discardFeedback: boolean,
  ): Effect.Effect<PreparedDelete, ReviewError | RuntimeStateError> {
    return Effect.gen({ self: this }, function* () {
      const now = yield* Clock.currentTimeMillis;
      yield* this.#expireTombstones(now);
      if (this.#deleteReservations.has(reviewId))
        return yield* new ReviewError({
          code: "review.not_ready",
          message: "The review is already being deleted",
        });
      const existingTombstone = this.#state.tombstones.find(
        (tombstone) => tombstone.id === reviewId,
      );
      if (existingTombstone?.kind === "deleted")
        return {
          kind: "result" as const,
          result: {
            review: reviewId,
            deleted: 1,
            discardedDrafts: existingTombstone.discardedDrafts,
            discardedFeedback: existingTombstone.discardedFeedback,
          },
        };
      const index = this.#reviewIndex(reviewId);
      const review = this.#state.reviews[index];
      if (review === undefined && existingTombstone === undefined)
        return yield* this.#reviewNotFound(reviewId);
      const drafts = review?.drafts.length ?? 0;
      const feedback = review?.events.length ?? 0;
      if (!discardFeedback && (drafts > 0 || feedback > 0))
        return yield* new ReviewError({
          code: "review.pending_feedback",
          message: "The review still contains pending feedback",
          details: { drafts, unacknowledged: feedback },
        });
      const retained = this.#retainedTombstones(now).filter(
        (tombstone) => tombstone.id !== reviewId,
      );
      if (retained.length >= maximumTombstones)
        return yield* new ReviewError({
          code: "review.limit",
          message: `Retry tombstone limit of ${maximumTombstones} reached`,
        });
      if (review?.status === "ready") {
        const reviews = [...this.#state.reviews];
        reviews[index] = { ...review, status: "stopped" };
        yield* this.#replace({ ...this.#state, reviews });
        this.#wake(reviewId);
      }
      const reservation: DeleteReservation = {
        token: Symbol(reviewId),
        reviewId,
        review: this.#state.reviews[this.#reviewIndex(reviewId)],
        tombstone: this.#state.tombstones.find(
          (tombstone) => tombstone.id === reviewId,
        ),
      };
      this.#deleteReservations.set(reviewId, reservation);
      return { kind: "prepared" as const, reservation };
    });
  }

  #commitDelete(
    reservation: DeleteReservation,
    discardFeedback: boolean,
  ): Effect.Effect<DeleteReviewResult, ReviewError | RuntimeStateError> {
    return Effect.gen({ self: this }, function* () {
      const reviewId = reservation.reviewId;
      if (this.#deleteReservations.get(reviewId)?.token !== reservation.token)
        return yield* new ReviewError({
          code: "review.not_ready",
          message: "The review deletion reservation is no longer active",
        });
      const now = yield* Clock.currentTimeMillis;
      yield* this.#expireTombstones(now);
      const existingTombstone = this.#state.tombstones.find(
        (tombstone) => tombstone.id === reviewId,
      );
      const review = this.#state.reviews[this.#reviewIndex(reviewId)];
      if (
        review !== reservation.review ||
        existingTombstone !== reservation.tombstone
      )
        return yield* new ReviewError({
          code: "review.not_ready",
          message: "The review changed while deletion was in progress; retry",
        });
      if (existingTombstone?.kind === "deleted")
        return {
          review: reviewId,
          deleted: 1,
          discardedDrafts: existingTombstone.discardedDrafts,
          discardedFeedback: existingTombstone.discardedFeedback,
        };
      if (review === undefined && existingTombstone === undefined)
        return yield* this.#reviewNotFound(reviewId);
      const drafts = review?.drafts.length ?? 0;
      const feedback = review?.events.length ?? 0;
      if (!discardFeedback && (drafts > 0 || feedback > 0))
        return yield* new ReviewError({
          code: "review.pending_feedback",
          message: "The review still contains pending feedback",
          details: { drafts, unacknowledged: feedback },
        });
      const retained = this.#retainedTombstones(now).filter(
        (tombstone) => tombstone.id !== reviewId,
      );
      if (retained.length >= maximumTombstones)
        return yield* new ReviewError({
          code: "review.limit",
          message: `Retry tombstone limit of ${maximumTombstones} reached`,
        });
      yield* this.#replace({
        ...this.#state,
        reviews: this.#state.reviews.filter(
          (candidate) => candidate.id !== reviewId,
        ),
        tombstones: [
          ...retained,
          {
            id: reviewId,
            kind: "deleted",
            expiresAt: new Date(
              now + tombstoneRetentionMilliseconds,
            ).toISOString(),
            discardedDrafts: drafts,
            discardedFeedback: feedback,
          },
        ],
      });
      this.#deleteReservations.delete(reviewId);
      this.#wake(reviewId);
      return {
        review: reviewId,
        deleted: 1,
        discardedDrafts: drafts,
        discardedFeedback: feedback,
      };
    });
  }

  #releaseDelete(reservation: DeleteReservation): Effect.Effect<void> {
    return Effect.sync(() => {
      if (
        this.#deleteReservations.get(reservation.reviewId)?.token ===
        reservation.token
      )
        this.#deleteReservations.delete(reservation.reviewId);
    });
  }

  #prepareFeedback(
    reviewId: string,
    after: number | undefined,
    wait: boolean,
  ): Effect.Effect<
    PreparedFeedback,
    ReviewError | FeedbackError | RuntimeStateError
  > {
    return Effect.gen({ self: this }, function* () {
      const now = yield* Clock.currentTimeMillis;
      yield* this.#expireTombstones(now);
      const tombstone = this.#state.tombstones.find(
        (candidate) => candidate.id === reviewId,
      );
      if (tombstone?.kind === "deleted")
        return yield* this.#reviewNotFound(reviewId);
      if (tombstone?.kind === "completed") {
        if (after !== undefined && after > tombstone.terminalCursor)
          return yield* this.#cursorAhead();
        return {
          kind: "result",
          result: this.#feedbackResult(
            reviewId,
            "ended",
            tombstone.terminalCursor,
            [],
          ),
        };
      }
      const index = this.#reviewIndex(reviewId);
      const review = this.#state.reviews[index];
      if (review === undefined) return yield* this.#reviewNotFound(reviewId);
      let acknowledgedCursor = review.acknowledgedCursor;
      let events = review.events;
      if (after !== undefined && after > acknowledgedCursor) {
        if (after > review.highestDeliveredCursor)
          return yield* this.#cursorAhead();
        acknowledgedCursor = after;
        events = events.filter((event) => event.position > after);
      }
      if (review.status === "ended" && events.length === 0) {
        const completed = {
          ...review,
          acknowledgedCursor,
          events,
        };
        yield* this.#replaceWithCompletedTombstone(index, completed, now);
        return {
          kind: "result",
          result: this.#feedbackResult(
            reviewId,
            "ended",
            acknowledgedCursor,
            [],
          ),
        };
      }
      if (events.length > 0) {
        const cursor = events.at(-1)?.position ?? acknowledgedCursor;
        const updated: PersistedReview = {
          ...review,
          acknowledgedCursor,
          events,
          highestDeliveredCursor: Math.max(
            review.highestDeliveredCursor,
            cursor,
          ),
        };
        if (
          updated.acknowledgedCursor !== review.acknowledgedCursor ||
          updated.highestDeliveredCursor !== review.highestDeliveredCursor
        )
          yield* this.#replaceReview(index, updated);
        return {
          kind: "result",
          result: this.#feedbackResult(reviewId, review.status, cursor, events),
        };
      }
      if (acknowledgedCursor !== review.acknowledgedCursor)
        yield* this.#replaceReview(index, {
          ...review,
          acknowledgedCursor,
          events,
        });
      if (!wait || review.status !== "ready")
        return {
          kind: "result",
          result: this.#feedbackResult(
            reviewId,
            review.status,
            acknowledgedCursor,
            [],
          ),
        };
      if (this.#waiters.has(reviewId))
        return yield* new FeedbackError({
          code: "feedback.consumer_busy",
          message: "Another feedback wait is already active for this review",
        });
      const waiter = {
        token: Symbol(reviewId),
        signal: Deferred.makeUnsafe<void>(),
      };
      this.#waiters.set(reviewId, waiter);
      return { kind: "wait", waiter };
    });
  }

  #feedbackResult(
    id: string,
    status: PersistedReview["status"],
    cursor: number,
    events: readonly FeedbackEvent[],
  ): FeedbackReadResult {
    const feedback = events.map((event): DeliveredFeedback => {
      if (event.kind === "freeform")
        return {
          id: event.id,
          kind: "freeform",
          comment: event.comment,
          entry: event.entry,
          revision: event.revision,
        };
      return {
        id: event.id,
        kind: "element",
        comment: event.comment,
        entry: event.entry,
        revision: event.revision,
        anchor: {
          selector: event.anchor.selector,
          dom_path: event.anchor.domPath,
          tag: event.anchor.tag,
          ...(event.anchor.text === undefined
            ? {}
            : { text: event.anchor.text }),
        },
      };
    });
    return {
      review: { id, status },
      cursor,
      count: feedback.length,
      feedback,
    };
  }

  #replaceReview(
    index: number,
    review: PersistedReview,
  ): Effect.Effect<void, RuntimeStateError> {
    const reviews = [...this.#state.reviews];
    reviews[index] = review;
    return this.#replace({ ...this.#state, reviews });
  }

  #replaceWithCompletedTombstone(
    index: number,
    review: PersistedReview,
    now: number,
  ): Effect.Effect<void, ReviewError | RuntimeStateError> {
    const retained = this.#retainedTombstones(now);
    if (retained.length >= maximumTombstones)
      return Effect.fail(
        new ReviewError({
          code: "review.limit",
          message: `Retry tombstone limit of ${maximumTombstones} reached`,
        }),
      );
    return this.#replace({
      ...this.#state,
      reviews: this.#state.reviews.filter((_, position) => position !== index),
      tombstones: [
        ...retained,
        {
          id: review.id,
          kind: "completed",
          session: review.session,
          terminalCursor: review.acknowledgedCursor,
          expiresAt: new Date(
            now + tombstoneRetentionMilliseconds,
          ).toISOString(),
        },
      ],
    });
  }

  #retainedTombstones(now: number): AnnotationState["tombstones"] {
    return this.#state.tombstones.filter(
      (tombstone) => Date.parse(tombstone.expiresAt) > now,
    );
  }

  #expireTombstones(now: number): Effect.Effect<void, RuntimeStateError> {
    const tombstones = this.#retainedTombstones(now);
    return tombstones.length === this.#state.tombstones.length
      ? Effect.void
      : this.#replace({ ...this.#state, tombstones });
  }

  #reviewIndex(id: string): number {
    return this.#state.reviews.findIndex((review) => review.id === id);
  }

  #reviewNotFound(id: string): ReviewError {
    return new ReviewError({
      code: "review.not_found",
      message: `Review is not retained: ${id}`,
    });
  }

  #cursorAhead(): FeedbackError {
    return new FeedbackError({
      code: "feedback.cursor_ahead",
      message: "The feedback cursor is ahead of the highest delivered position",
    });
  }

  #fitsStorage(index: number, review: PersistedReview): boolean {
    const reviews = [...this.#state.reviews];
    reviews[index] = review;
    return annotationStateFitsMutationBounds({ ...this.#state, reviews });
  }

  #annotationStorageLimit(): ReviewError {
    return new ReviewError({
      code: "review.annotation_limit",
      message: "The durable annotation size limit has been reached",
    });
  }

  #wake(id: string): void {
    const waiter = this.#waiters.get(id);
    if (waiter !== undefined)
      Effect.runSync(Deferred.succeed(waiter.signal, undefined));
  }

  #removeWaiter(id: string, waiter: ReviewWaiter): Effect.Effect<void> {
    return this.#mutations.withPermit(
      Effect.sync(() => {
        if (this.#waiters.get(id)?.token === waiter.token)
          this.#waiters.delete(id);
      }),
    );
  }

  #replace(state: AnnotationState): Effect.Effect<void, RuntimeStateError> {
    return this.save(this.paths, state).pipe(
      Effect.tap(() =>
        Effect.sync(() => {
          this.#state = state;
        }),
      ),
    );
  }
}
