import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Fiber } from "effect";
import { describe, expect, it } from "vitest";

import {
  FileWindowTrackerRepository,
  MemoryWindowTrackerRepository,
} from "../src/repositories/window-tracker-repository";
import { WindowTracker } from "../src/services/window-tracker";

const fiveHours = 5 * 60 * 60 * 1_000;
const limits = {
  claudeMonthlyCreditUsd: 1,
  codexWindowCalls: 1,
  codexWindowTokens: 100,
  codexWindowMs: fiveHours,
} as const;

describe("durable plan headroom and accounting", () => {
  it("refuses unbounded subscription admission when no positive plan limit is configured", async () => {
    const tracker = new WindowTracker({
      claudeMonthlyCreditUsd: 0,
      codexWindowCalls: 0,
      codexWindowTokens: 0,
      codexWindowMs: fiveHours,
    }, new MemoryWindowTrackerRepository());
    await Effect.runPromise(tracker.initialize());

    for (const seat of ["claude", "codex"] as const) {
      await expect(Effect.runPromise(tracker.reserve({
        seat,
        tier: "stavka/sergeant",
        expectedUsage: { inputTokens: 10, outputTokens: 10 },
      }))).rejects.toMatchObject({ code: "SEAT_PLAN_LIMIT_REQUIRED", status: 503 });
      expect(tracker.isExhausted(seat)).toBe(true);
    }
  });

  it("separates subscription plan credit from metered cash and savings", async () => {
    const tracker = new WindowTracker(limits, new MemoryWindowTrackerRepository());
    await Effect.runPromise(tracker.initialize());
    await Effect.runPromise(tracker.record({
      seat: "claude",
      tier: "stavka/commander",
      usage: { inputTokens: 1_000, outputTokens: 100 },
      cacheHit: false,
      actualCostUsd: 0,
      planCreditUsd: 0.25,
      at: Date.UTC(2026, 0, 10),
    }));
    expect(tracker.snapshot()).toMatchObject({
      actualCostUsd: 0,
      planCreditUsd: 0.25,
      apiListEquivalentUsd: expect.any(Number),
      savedVsApiUsd: expect.any(Number),
    });
    expect(tracker.snapshot().savedVsApiUsd).toBe(tracker.snapshot().apiListEquivalentUsd);
  });

  it("persists every update and restores it from the local file repository", async () => {
    const directory = await mkdtemp(join(tmpdir(), "stavka-window-tracker-"));
    try {
      const repository = new FileWindowTrackerRepository(join(directory, "usage.json"));
      const first = new WindowTracker(limits, repository);
      await Effect.runPromise(first.initialize());
      await Effect.runPromise(first.record({
        seat: "api",
        tier: "stavka/sergeant",
        usage: { inputTokens: 100, outputTokens: 20 },
        cacheHit: false,
        actualCostUsd: 0.001,
        planCreditUsd: 0,
        at: Date.UTC(2026, 0, 10),
      }));
      const reservationAt = Date.now();
      const reservation = await Effect.runPromise(first.reserve({
        seat: "codex",
        tier: "stavka/sergeant",
        expectedUsage: { inputTokens: 10, outputTokens: 20 },
        at: reservationAt,
      }));

      const restored = new WindowTracker(limits, repository);
      await Effect.runPromise(restored.initialize());
      expect(restored.durable).toBe(true);
      expect(restored.snapshot()).toEqual(first.snapshot());
      expect(restored.monthlySeatUsage("api", Date.UTC(2026, 0, 11))).toBe(0.001);
      expect(restored.headroom("codex", reservationAt)).toMatchObject({
        remainingCalls: 0,
        remainingTokens: 70,
      });
      await Effect.runPromise(restored.refund(reservation));
      const refunded = new WindowTracker(limits, repository);
      await Effect.runPromise(refunded.initialize());
      expect(refunded.headroom("codex", reservationAt)).toMatchObject({
        remainingCalls: 1,
        remainingTokens: 100,
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("rejects exhausted Codex admission and rolls over after five hours", async () => {
    const at = Date.UTC(2026, 0, 10);
    const tracker = new WindowTracker(limits, new MemoryWindowTrackerRepository());
    await Effect.runPromise(tracker.initialize());
    await Effect.runPromise(tracker.record({
      seat: "codex",
      tier: "stavka/sergeant",
      usage: { inputTokens: 40, outputTokens: 10 },
      cacheHit: false,
      actualCostUsd: 0,
      planCreditUsd: 0.001,
      at,
    }));
    await expect(Effect.runPromise(tracker.admit("codex", at + 1))).rejects.toMatchObject({
      status: 429,
      code: "SEAT_PLAN_WINDOW_EXHAUSTED",
    });
    expect(tracker.headroom("codex", at + 1)).toMatchObject({
      callLimit: 1,
      tokenLimit: 100,
      remainingCalls: 0,
      remainingTokens: 50,
    });

    await expect(Effect.runPromise(tracker.admit("codex", at + fiveHours + 1))).resolves.toBeUndefined();
    expect(tracker.headroom("codex", at + fiveHours + 1)).toMatchObject({
      remainingCalls: 1,
      remainingTokens: 100,
    });
  });

  it("rolls Claude monthly credit headroom over on the UTC month boundary", async () => {
    const january = Date.UTC(2026, 0, 31, 23, 59);
    const february = Date.UTC(2026, 1, 1, 0, 1);
    const tracker = new WindowTracker(limits, new MemoryWindowTrackerRepository());
    await Effect.runPromise(tracker.initialize());
    await Effect.runPromise(tracker.record({
      seat: "claude",
      tier: "stavka/commander",
      usage: { inputTokens: 1, outputTokens: 1 },
      cacheHit: false,
      actualCostUsd: 0,
      planCreditUsd: 1,
      at: january,
    }));
    await expect(Effect.runPromise(tracker.admit("claude", january))).rejects.toMatchObject({
      code: "SEAT_PLAN_WINDOW_EXHAUSTED",
    });
    await expect(Effect.runPromise(tracker.admit("claude", february))).resolves.toBeUndefined();
    expect(tracker.headroom("claude", february)).toMatchObject({
      creditLimitUsd: 1,
      remainingCreditUsd: 1,
    });
  });

  it("atomically admits only one concurrent reservation when one plan call remains", async () => {
    const at = Date.UTC(2026, 0, 10);
    const tracker = new WindowTracker(limits, new MemoryWindowTrackerRepository());
    await Effect.runPromise(tracker.initialize());
    const reserve = tracker.reserve({
      seat: "codex",
      tier: "stavka/sergeant",
      expectedUsage: { inputTokens: 10, outputTokens: 20 },
      at,
    }).pipe(Effect.result);
    const outcomes = await Effect.runPromise(Effect.all([reserve, reserve], {
      concurrency: "unbounded",
    }));
    expect(outcomes.filter((outcome) => outcome._tag === "Success")).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome._tag === "Failure")).toHaveLength(1);
    expect(tracker.headroom("codex", at)).toMatchObject({
      remainingCalls: 0,
      remainingTokens: 70,
    });
    const admitted = outcomes.find((outcome) => outcome._tag === "Success");
    if (admitted?._tag !== "Success") throw new Error("reservation was not admitted");
    await Effect.runPromise(tracker.refund(admitted.success));
    await expect(Effect.runPromise(tracker.reserve({
      seat: "codex",
      tier: "stavka/sergeant",
      expectedUsage: { inputTokens: 10, outputTokens: 20 },
      at,
    }))).resolves.toMatchObject({ seat: "codex" });
  });

  it("refunds an in-flight reservation when the owning fiber is cancelled", async () => {
    const at = Date.UTC(2026, 0, 10);
    const tracker = new WindowTracker(limits, new MemoryWindowTrackerRepository());
    await Effect.runPromise(tracker.initialize());
    await Effect.runPromise(Effect.gen(function*() {
      const fiber = yield* Effect.forkChild(Effect.acquireUseRelease(
        tracker.reserve({
          seat: "codex",
          tier: "stavka/sergeant",
          expectedUsage: { inputTokens: 10, outputTokens: 20 },
          at,
        }),
        () => Effect.never,
        (reservation) => tracker.refund(reservation),
      ));
      yield* Effect.yieldNow;
      expect(tracker.headroom("codex", at)).toMatchObject({ remainingCalls: 0 });
      yield* Fiber.interrupt(fiber);
      expect(tracker.headroom("codex", at)).toMatchObject({
        remainingCalls: 1,
        remainingTokens: 100,
      });
    }));
  });
});
