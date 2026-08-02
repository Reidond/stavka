import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import {
  chargeSeat,
  ContributorResultError,
  invokeContributorSeat,
  isRetryableSeatFailure,
  reportedSeatFailureUsage,
  resolveLlmRoute,
  stretchedInterval,
} from "../src/brain/seat-router";
import type { CommanderConfig } from "../src/config";
import type { Env } from "../src/config";
import type { SeatRegistration } from "../src/state/types";

const config: CommanderConfig = {
  commanderModel: "stavka/commander",
  sergeantModel: "stavka/sergeant",
  heavyModel: "stavka/heavy",
  decisionIntervalSeconds: 45,
  doctrine: "balanced",
  maxActiveUnits: 50,
  difficulty: 0.5,
  playerScaling: true,
  tickIdleMs: 2_000,
  tickActiveMs: 750,
  tickBurstMs: 300,
  aiProvider: "openai",
  aiBaseUrl: "https://maskirovka-fallback.example.test",
  seatExhaustionPolicy: "fallback",
  seatStretchMultiplier: 4,
  seatHeartbeatTtlSeconds: 45,
  seatJobTimeoutSeconds: 30,
  seatKeys: {
    high: "high-secret",
    low: "low-secret",
    unhealthy: "unhealthy-secret",
    spent: "spent-secret",
    chosen: "chosen-secret",
    other: "other-secret",
  },
};

const seat = (
  id: string,
  priority: number,
  overrides: Partial<Extract<SeatRegistration, { readonly mode: "container" }>> = {},
): SeatRegistration => {
  const registration: Extract<SeatRegistration, { readonly mode: "container" }> = {
    id,
    name: id,
    mode: "container",
    provider: "claude",
    endpoint: `https://${id}.example.test`,
    models: ["stavka/commander"],
    monthlyBudgetUsd: 100,
    priority,
    healthy: true,
    exhausted: false,
    registeredAt: "2026-08-02T00:00:00.000Z",
    spentUsd: 0,
    reservedUsd: 0,
    budgetPeriod: "2026-08",
    ...overrides,
  };
  return registration;
};

describe("registered seat routing", () => {
  it("selects the highest-priority healthy seat serving the tier", () => {
    const route = resolveLlmRoute([
      seat("low", 5),
      seat("unhealthy", 100, { healthy: false }),
      seat("high", 20),
    ], config, "stavka/commander");

    expect(route.seatId).toBe("high");
    expect(route.config.aiProvider).toBe("anthropic");
    expect(route.config.aiBaseUrl).toBe("https://high.example.test");
    expect(route.fallback).toBe(false);
  });

  it("records API fallback or stretches cadence when registered budgets are exhausted", () => {
    const exhausted = [seat("spent", 10, { exhausted: true, spentUsd: 100 })];
    expect(resolveLlmRoute(exhausted, config, "stavka/commander")).toMatchObject({
      fallback: true,
      stretched: false,
    });
    const stretched = resolveLlmRoute(exhausted, {
      ...config,
      seatExhaustionPolicy: "stretch",
    }, "stavka/commander");
    expect(stretched).toMatchObject({ fallback: false, stretched: true });
    expect(stretchedInterval(stretched, 45, 4)).toBe(180);
  });

  it("charges only the selected seat and marks its budget exhausted", () => {
    const seats = chargeSeat([seat("chosen", 20, { spentUsd: 99 }), seat("other", 10)], "chosen", 2);

    expect(seats.find((item) => item.id === "chosen")).toMatchObject({
      spentUsd: 101,
      exhausted: true,
    });
    expect(seats.find((item) => item.id === "other")?.spentUsd).toBe(0);
  });

  it("never routes an HTTP seat through the metered fallback credential", () => {
    const route = resolveLlmRoute([seat("revoked", 100)], {
      ...config,
      aiKey: "global-metered-key",
      seatKeys: {},
    }, "stavka/commander");

    expect(route.seatId).toBeUndefined();
    expect(route).toMatchObject({
      fallback: true,
      config: { aiBaseUrl: "https://maskirovka-fallback.example.test" },
    });
  });

  it("uses the contributor result's typed retryability instead of message guessing", () => {
    const retryable = new ContributorResultError({
      code: "CONTRIBUTOR_DISCONNECTED",
      message: "opaque failure",
      retryable: true,
    });
    const semantic = new ContributorResultError({
      code: "INVALID_DECISION",
      message: "network-looking words must not override the typed flag",
      retryable: false,
    });

    expect(isRetryableSeatFailure(retryable)).toBe(true);
    expect(isRetryableSeatFailure(semantic)).toBe(false);
  });

  it("preserves a contributor's retryable flag and measured usage across the RPC data boundary", async () => {
    const env = {
      ORCHESTRATOR: {
        getByName: () => ({
          invokeContributorOutcome: async () => ({
            ok: false as const,
            failure: {
              code: "UPSTREAM_TIMEOUT",
              message: "opaque provider failure",
              retryable: true,
              tokenUsage: { input: 13, output: 5 },
              costUsd: 0.04,
              resolvedModel: "contributor-model",
            },
          }),
        }),
      },
    } as unknown as Env;
    let failure: unknown;

    await Effect.runPromise(invokeContributorSeat(
      env,
      "contributor",
      "stavka/commander",
      "prompt",
      30,
      "job",
      "lease",
    )).catch((cause) => {
      failure = cause;
    });

    expect(failure).toMatchObject({ code: "UPSTREAM_TIMEOUT", retryable: true });
    expect(isRetryableSeatFailure(failure)).toBe(true);
    expect(reportedSeatFailureUsage(failure)).toEqual({
      tokenUsage: { input: 13, output: 5 },
      costUsd: 0.04,
      resolvedModel: "contributor-model",
    });
  });
});
