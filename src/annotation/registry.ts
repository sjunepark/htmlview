import { Effect, Semaphore } from "effect";
import { ReviewError, RuntimeStateError } from "../errors.js";
import type { StatePaths } from "../supervisor/state.js";
import {
  maximumReviews,
  type AnnotationState,
  type PersistedReview,
} from "./model.js";
import { saveAnnotationState } from "./store.js";

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

type SaveState = (
  paths: StatePaths,
  state: AnnotationState,
) => Effect.Effect<void, RuntimeStateError>;

function sameIdentity(left: ReviewIdentity, right: ReviewIdentity): boolean {
  return left.root === right.root && left.entry === right.entry;
}

export class AnnotationRegistry {
  readonly #mutations = Semaphore.makeUnsafe(1);
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
        if (this.#state.reviews.length >= this.maximumRetainedReviews)
          return yield* new ReviewError({
            code: "review.limit",
            message: `Retained review limit of ${this.maximumRetainedReviews} reached`,
          });
        if (this.hasIdentifier(input.id))
          return yield* new ReviewError({
            code: "review.limit",
            message:
              "A generated review identifier collided with retained state",
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
        yield* this.#replace({
          ...this.#state,
          reviews: [...this.#state.reviews, record],
        });
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

  stopReady(ids: readonly string[]): Effect.Effect<void, RuntimeStateError> {
    return this.#mutations.withPermit(
      Effect.gen({ self: this }, function* () {
        const selected = new Set(ids);
        let changed = false;
        const reviews = this.#state.reviews.map((review) => {
          if (!selected.has(review.id) || review.status !== "ready")
            return review;
          changed = true;
          return { ...review, status: "stopped" as const };
        });
        if (changed) yield* this.#replace({ ...this.#state, reviews });
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
