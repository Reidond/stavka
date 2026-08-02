import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import { SeatInvocationGovernor, SeatQueueFullError } from "../src/seat-invocation-governor";

const nextTurn = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

describe("hosted seat invocation governor", () => {
  it("admits a bounded FIFO queue and rejects excess work with backpressure", async () => {
    const governor = new SeatInvocationGovernor(1, 1);
    const started: number[] = [];
    const release: Array<() => void> = [];
    const run = (id: number) =>
      Effect.runPromise(
        governor.run(
          Effect.callback<number>((resume) => {
            started.push(id);
            release.push(() => resume(Effect.succeed(id)));
          }),
        ),
      );

    const first = run(1);
    const second = run(2);
    await nextTurn();

    expect(started).toEqual([1]);
    await expect(Effect.runPromise(governor.snapshot)).resolves.toEqual({
      active: 1,
      queueDepth: 1,
      concurrency: 1,
      maxQueue: 1,
    });

    const rejected = await Effect.runPromise(Effect.result(governor.run(Effect.succeed(3))));
    expect(rejected._tag).toBe("Failure");
    if (rejected._tag === "Failure") {
      expect(rejected.failure).toBeInstanceOf(SeatQueueFullError);
    }

    release.shift()?.();
    await nextTurn();
    expect(started).toEqual([1, 2]);
    release.shift()?.();

    await expect(Promise.all([first, second])).resolves.toEqual([1, 2]);
    await expect(Effect.runPromise(governor.snapshot)).resolves.toMatchObject({
      active: 0,
      queueDepth: 0,
    });
  });

  it("releases queued capacity when the incoming request is aborted", async () => {
    const governor = new SeatInvocationGovernor(1, 1);
    let releaseActive: (() => void) | undefined;
    const active = Effect.runPromise(
      governor.run(
        Effect.callback<void>((resume) => {
          releaseActive = () => resume(Effect.void);
        }),
      ),
    );
    await nextTurn();

    const controller = new AbortController();
    const queued = Effect.runPromise(governor.run(Effect.never), {
      signal: controller.signal,
    }).then(
      () => undefined,
      () => undefined,
    );
    await nextTurn();
    await expect(Effect.runPromise(governor.snapshot)).resolves.toMatchObject({
      active: 1,
      queueDepth: 1,
    });

    controller.abort();
    await queued;
    await expect(Effect.runPromise(governor.snapshot)).resolves.toMatchObject({
      active: 1,
      queueDepth: 0,
    });

    releaseActive?.();
    await active;
  });
});
