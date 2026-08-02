import { describe, expect, it } from "vitest";

import {
  reconcileSeatBudgetState,
  reserveSeatBudgetState,
} from "../src/brain/seat-budget";
import type { SeatRegistration } from "../src/state/types";

type ContainerSeat = Extract<SeatRegistration, { readonly mode: "container" }>;

const seat = (overrides: Partial<ContainerSeat> = {}): ContainerSeat => ({
  id: "shared",
  name: "Shared seat",
  mode: "container",
  provider: "codex",
  endpoint: "https://seat.example.test",
  models: ["stavka/commander"],
  monthlyBudgetUsd: 1,
  priority: 10,
  healthy: true,
  exhausted: false,
  registeredAt: "2026-07-01T00:00:00.000Z",
  spentUsd: 0,
  reservedUsd: 0,
  budgetPeriod: "2026-07",
  ...overrides,
});

describe("global seat budget ledger", () => {
  it("rolls the UTC month before reserving new work", () => {
    const result = reserveSeatBudgetState([
      seat({ spentUsd: 1, exhausted: true }),
    ], "shared", 0.25, "2026-08");

    expect(result.accepted).toBe(true);
    expect(result.seats[0]).toMatchObject({
      budgetPeriod: "2026-08",
      spentUsd: 0,
      reservedUsd: 0.25,
      exhausted: false,
    });
  });

  it("admits only one of two competing reservations that exceed the cap together", () => {
    const first = reserveSeatBudgetState([
      seat({ budgetPeriod: "2026-08" }),
    ], "shared", 0.6, "2026-08");
    const second = reserveSeatBudgetState(first.seats, "shared", 0.6, "2026-08");

    expect(first.accepted).toBe(true);
    expect(second.accepted).toBe(false);
    expect(second.seats[0]?.reservedUsd).toBe(0.6);

    const reconciled = reconcileSeatBudgetState(
      second.seats,
      "shared",
      0.6,
      0.2,
      "2026-08",
    );
    expect(reconciled[0]).toMatchObject({ spentUsd: 0.2, reservedUsd: 0 });
  });
});
