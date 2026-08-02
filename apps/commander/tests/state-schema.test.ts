import { Schema } from "effect";
import { describe, expect, it } from "vitest";

import {
  CommanderSessionStateSchema,
  initialCommanderState,
  SeatRegistrationSchema,
} from "../src/state/types";

describe("Commander persisted state schemas", () => {
  it("decodes the complete initial state", () => {
    expect(Schema.decodeUnknownSync(CommanderSessionStateSchema)(
      initialCommanderState(),
    )).toEqual(initialCommanderState());
  });

  it("rejects malformed nested state instead of returning an interface cast", () => {
    expect(() => Schema.decodeUnknownSync(CommanderSessionStateSchema)({
      ...initialCommanderState(),
      budget: { ...initialCommanderState().budget, manpower: "many" },
    })).toThrow();
  });

  it("keeps credentials out of public seat state", () => {
    expect(() => Schema.decodeUnknownSync(SeatRegistrationSchema, {
      onExcessProperty: "error",
    })({
      id: "seat-one",
      name: "Seat One",
      mode: "container",
      provider: "claude",
      endpoint: "https://seat.example.test",
      models: ["stavka/commander"],
      monthlyBudgetUsd: 100,
      priority: 10,
      healthy: true,
      exhausted: false,
      registeredAt: "2026-08-02T00:00:00.000Z",
      spentUsd: 0,
      reservedUsd: 0,
      budgetPeriod: "2026-08",
      credential: "must-not-persist",
    })).toThrow();
  });
});
