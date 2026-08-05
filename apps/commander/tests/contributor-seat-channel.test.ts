import { beforeEach, describe, expect, it, vi } from "vitest";

import { resolveLlmRoute, SEAT_REGISTRY_NAME } from "../src/brain/seat-router";
import type { CommanderConfig, Env } from "../src/config";
import type { SeatRegistration } from "../src/state/types";

const mocks = vi.hoisted(() => {
  const agentFetch = vi.fn<(request: Request) => Promise<Response>>();
  return {
    agentFetch,
    agentRoute: vi.fn<(request: Request, env: unknown) => Promise<Response | null>>(),
    getByName: vi.fn((_name: string) => ({ fetch: agentFetch })),
  };
});

vi.mock("agents", () => ({
  Agent: class {},
  routeAgentRequest: mocks.agentRoute,
}));

const { handleRequest } = await import("../src/api/router");

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
  seatKeys: {},
};

const contributorSeat = (
  id: string,
  priority: number,
  healthExpiresAt: number,
): SeatRegistration => ({
  id,
  name: id,
  mode: "contributor",
  provider: "codex",
  models: ["stavka/commander"],
  monthlyBudgetUsd: 100,
  priority,
  healthy: true,
  exhausted: false,
  registeredAt: "2026-08-02T00:00:00.000Z",
  spentUsd: 0,
  reservedUsd: 0,
  budgetPeriod: "2026-08",
  healthExpiresAt,
});

const makeEnv = (overrides: Partial<Env> = {}): Env => ({
  ORCHESTRATOR: { getByName: mocks.getByName } as unknown as Env["ORCHESTRATOR"],
  TERRAIN_CACHE: {} as Env["TERRAIN_CACHE"],
  API_KEY: "machine-secret",
  SEAT_REGISTRATION_TOKEN: "seat-secret",
  DEV_ACCESS_EMAIL: "operator@example.test",
  ...overrides,
});

describe("contributor seat channel", () => {
  beforeEach(() => {
    mocks.agentFetch.mockReset();
    mocks.agentRoute.mockReset().mockResolvedValue(null);
    mocks.getByName.mockClear();
  });

  it("requires the seat bearer token and preserves the raw Agent response", async () => {
    const env = makeEnv();
    const unauthorized = await handleRequest(
      new Request("https://commander.test/seats", {
        headers: { authorization: "Bearer wrong-secret" },
      }),
      env,
    );

    expect(unauthorized.status).toBe(401);
    expect(mocks.agentRoute).not.toHaveBeenCalled();

    const webSocket = { id: "contributor-channel" };
    const agentResponse = new Response("seat-channel", {
      headers: { "x-agent": "seat-registry" },
    });
    Object.defineProperty(agentResponse, "webSocket", { value: webSocket });
    mocks.agentFetch.mockResolvedValue(agentResponse);

    const authorizedRequest = new Request("https://commander.test/seats", {
      headers: {
        authorization: "Bearer seat-secret",
        upgrade: "websocket",
      },
    });
    const response = await handleRequest(authorizedRequest, env);

    expect(response).toBe(agentResponse);
    expect((response as Response & { readonly webSocket: unknown }).webSocket).toBe(webSocket);
    expect(response.headers.get("x-agent")).toBe("seat-registry");
    expect(mocks.getByName).toHaveBeenCalledOnce();
    expect(mocks.getByName).toHaveBeenCalledWith(SEAT_REGISTRY_NAME);
    expect(mocks.agentFetch).toHaveBeenCalledOnce();
    const [forwarded] = mocks.agentFetch.mock.calls[0]!;
    expect(forwarded).toBe(authorizedRequest);
    expect(new URL(forwarded.url).pathname).toBe("/seats");
    expect(mocks.agentRoute).not.toHaveBeenCalled();
  });

  it("routes only to contributors whose heartbeat TTL is still current", () => {
    const nowSeconds = 1_000;
    const fresh = contributorSeat("fresh", 10, nowSeconds + 1);
    const expired = contributorSeat("expired", 100, nowSeconds);

    expect(resolveLlmRoute([expired, fresh], config, "stavka/commander", nowSeconds)).toMatchObject(
      {
        seatId: "fresh",
        contributor: true,
        fallback: false,
      },
    );

    expect(resolveLlmRoute([expired], config, "stavka/commander", nowSeconds)).toMatchObject({
      contributor: false,
      fallback: true,
    });
  });
});
