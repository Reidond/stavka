import { Effect } from "effect";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Env } from "../src/config";
import type { SeatRegistration } from "../src/state/types";

vi.mock("agents", () => ({ Agent: class {} }));

const { probeHttpSeat } = await import("../src/durable/orchestrator");

const seat: Extract<SeatRegistration, { readonly mode: "container" }> = {
  id: "private-seat",
  name: "Private seat",
  mode: "container",
  provider: "codex",
  endpoint: "https://private-seat.example.test",
  models: ["stavka/commander"],
  monthlyBudgetUsd: 10,
  priority: 1,
  healthy: false,
  exhausted: false,
  registeredAt: "2026-08-02T00:00:00.000Z",
  spentUsd: 0,
  reservedUsd: 0,
  budgetPeriod: "2026-08",
};

const env = (seatKeys: Record<string, string>): Env => ({
  ORCHESTRATOR: {} as Env["ORCHESTRATOR"],
  TERRAIN_CACHE: {} as Env["TERRAIN_CACHE"],
  API_KEY: "machine",
  STAVKA_AI_PROVIDER: "openai",
  STAVKA_AI_BASE_URL: "https://maskirovka.example.test",
  STAVKA_AI_KEY: "global-metered-key",
  STAVKA_SEAT_KEYS: JSON.stringify(seatKeys),
});

describe("registered HTTP seat health isolation", () => {
  const fetchMock = vi.fn<typeof fetch>();

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
  });

  it("does not probe a seat whose independently revocable key is absent", async () => {
    expect(await Effect.runPromise(probeHttpSeat(seat, env({})))).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("uses only the seat-specific key when probing", async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ ok: true }), {
      headers: { "content-type": "application/json" },
    }));

    expect(await Effect.runPromise(probeHttpSeat(
      seat,
      env({ "private-seat": "seat-only-key" }),
    ))).toBe(true);
    const init = fetchMock.mock.calls[0]?.[1];
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer seat-only-key");
  });
});
