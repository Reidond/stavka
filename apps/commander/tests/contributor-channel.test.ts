import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import {
  decodeContributorDecision,
  isActiveSeatConnection,
} from "../src/brain/contributor-channel";
import type { SeatRegistration } from "../src/state/types";

const seat: SeatRegistration = {
  id: "seat",
  name: "Seat",
  mode: "contributor",
  provider: "codex",
  models: ["stavka/commander"],
  monthlyBudgetUsd: 10,
  priority: 1,
  healthy: true,
  exhausted: false,
  registeredAt: "2026-08-02T00:00:00.000Z",
  spentUsd: 0,
  reservedUsd: 0,
  budgetPeriod: "2026-08",
  activeConnectionId: "replacement",
};

describe("contributor connection fencing", () => {
  it("recognizes only the replacement connection as active", () => {
    expect(isActiveSeatConnection([seat], "seat", "replacement")).toBe(true);
    expect(isActiveSeatConnection([seat], "seat", "old")).toBe(false);
  });

  it("fails malformed decisions immediately at the channel boundary", async () => {
    const exit = await Effect.runPromiseExit(
      decodeContributorDecision({
        summary: "Malformed",
        commands: [{ type: "move_group", params: { group_id: "a" } }],
      }),
    );

    expect(exit._tag).toBe("Failure");
  });
});
