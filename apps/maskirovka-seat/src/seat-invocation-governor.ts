import { Effect, Ref, Schema, Semaphore } from "effect";

interface GovernorState {
  readonly active: number;
  readonly admitted: number;
}

export interface SeatGovernorSnapshot {
  readonly active: number;
  readonly queueDepth: number;
  readonly concurrency: number;
  readonly maxQueue: number;
}

export class SeatQueueFullError extends Schema.TaggedErrorClass<SeatQueueFullError>(
  "stavka/maskirovka-seat/SeatQueueFullError",
)("SeatQueueFullError", {
  concurrency: Schema.Number,
  maxQueue: Schema.Number,
}) {}

/** Per-Durable-Object admission control for one hosted subscription seat. */
export class SeatInvocationGovernor {
  private readonly semaphore: Semaphore.Semaphore;
  private readonly state = Ref.makeUnsafe<GovernorState>({ active: 0, admitted: 0 });

  constructor(
    private readonly concurrency: number,
    private readonly maxQueue: number,
  ) {
    if (!Number.isInteger(concurrency) || concurrency < 1) {
      throw new RangeError("Seat concurrency must be a positive integer");
    }
    if (!Number.isInteger(maxQueue) || maxQueue < 0) {
      throw new RangeError("Seat maxQueue must be a non-negative integer");
    }
    this.semaphore = Semaphore.makeUnsafe(concurrency);
  }

  readonly snapshot: Effect.Effect<SeatGovernorSnapshot> = Ref.get(this.state).pipe(
    Effect.map((state) => ({
      active: state.active,
      queueDepth: state.admitted - state.active,
      concurrency: this.concurrency,
      maxQueue: this.maxQueue,
    })),
  );

  run<A, E, R>(task: Effect.Effect<A, E, R>): Effect.Effect<A, E | SeatQueueFullError, R> {
    const admission = Ref.modify(this.state, (state) =>
      state.admitted >= this.concurrency + this.maxQueue
        ? [false, state]
        : [true, { ...state, admitted: state.admitted + 1 }],
    ).pipe(
      Effect.flatMap((admitted) =>
        admitted
          ? Effect.void
          : Effect.fail(
              new SeatQueueFullError({
                concurrency: this.concurrency,
                maxQueue: this.maxQueue,
              }),
            ),
      ),
    );

    return Effect.acquireUseRelease(
      admission,
      () =>
        this.semaphore.withPermit(
          Effect.acquireUseRelease(
            Ref.update(this.state, (state) => ({ ...state, active: state.active + 1 })),
            () => task,
            () => Ref.update(this.state, (state) => ({ ...state, active: state.active - 1 })),
          ),
        ),
      () => Ref.update(this.state, (state) => ({ ...state, admitted: state.admitted - 1 })),
    );
  }
}
