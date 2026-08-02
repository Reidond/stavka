import { Effect, Semaphore } from "effect";

import { GatewayError } from "../domain/types";

export interface GovernorSnapshot {
  readonly active: number;
  readonly queueDepth: number;
  readonly concurrency: number;
}

export class FairGovernor {
  private active = 0;
  private queued = 0;
  private readonly semaphore: Semaphore.Semaphore;

  constructor(private readonly concurrency: number, private readonly maxQueue = 1_000) {
    if (!Number.isInteger(concurrency) || concurrency < 1) throw new Error("concurrency must be positive");
    this.semaphore = Semaphore.makeUnsafe(concurrency);
  }

  snapshot(): GovernorSnapshot {
    return { active: this.active, queueDepth: this.queued, concurrency: this.concurrency };
  }

  run<A, E, R, E2 = never, R2 = never>(
    task: Effect.Effect<A, E, R>,
    admission: Effect.Effect<void, E2, R2> = Effect.void,
  ): Effect.Effect<A, E | E2 | GatewayError, R | R2> {
    return Effect.suspend<A, E | E2 | GatewayError, R | R2>(() => {
      if (this.queued >= this.maxQueue) {
        return Effect.fail(new GatewayError(
          503,
          "SEAT_QUEUE_FULL",
          "Seat queue is full",
        ));
      }

      let acquired = false;
      this.queued += 1;
      const guarded = Effect.sync(() => {
        this.queued -= 1;
        this.active += 1;
        acquired = true;
      }).pipe(
        Effect.andThen(admission),
        Effect.andThen(task),
        Effect.ensuring(Effect.sync(() => {
          this.active -= 1;
        })),
      );

      return this.semaphore.withPermit(guarded).pipe(
        Effect.ensuring(Effect.sync(() => {
          if (!acquired) this.queued -= 1;
        })),
      );
    });
  }
}
