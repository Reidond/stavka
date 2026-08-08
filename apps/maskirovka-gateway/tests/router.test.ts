import { afterAll, describe, expect, it, vi } from "vitest";

import type { GatewayEnv, GatewayProvider } from "../src/config";
import type { MaskirovkaGateway } from "../src/gateway-container";
import { createGatewayTestHandler, handleTestRequest, type GatewayStub } from "../src/router";

const bearer = "Bearer sk-stavka-test-gateway";

const environment = (): GatewayEnv => ({
  MASKIROVKA_GATEWAY: {} as DurableObjectNamespace<MaskirovkaGateway>,
  ASSETS: {
    fetch: vi.fn(async () => new Response("missing", { status: 404 })),
  } as unknown as Fetcher,
  REPLAY_CACHE: {} as R2Bucket,
  MASKIROVKA_GATEWAY_KEY: "sk-stavka-test-gateway",
  ENVIRONMENT: "test",
  GATEWAY_ID: "default-gateway",
  MODEL_ALIASES: JSON.stringify({
    "stavka/commander": { seat: "claude", model: "claude-fable-5" },
    "stavka/sergeant": { seat: "codex", model: "gpt-5.6-luna" },
    "stavka/heavy": { seat: "codex", model: "gpt-5.6-terra" },
  }),
  CONTAINER_SLEEP_AFTER: "15m",
  MASKIROVKA_MODE: "live",
  MASKIROVKA_CLAUDE_MONTHLY_CREDIT_USD: "0",
  MASKIROVKA_CODEX_WINDOW_CALL_LIMIT: "0",
  MASKIROVKA_CODEX_WINDOW_TOKEN_LIMIT: "0",
  MASKIROVKA_CODEX_WINDOW_HOURS: "5",
});

const status = () => ({
  ok: true,
  service: "stavka-maskirovka-gateway" as const,
  mode: "live" as const,
  killed: false,
  aliases: [
    { tier: "stavka/commander" as const, seat: "claude" as const, model: "claude-fable-5" },
    { tier: "stavka/sergeant" as const, seat: "codex" as const, model: "gpt-5.6-luna" },
    { tier: "stavka/heavy" as const, seat: "codex" as const, model: "gpt-5.6-terra" },
  ],
  container: { status: "stopped", last_change: 1 },
  auth: {
    claude: {
      provider: "claude" as const,
      configured: true,
      persisted: true,
      revision: 2,
      updated_at: 1,
    },
    codex: { provider: "codex" as const, configured: false, persisted: false, revision: 0 },
  },
  config: { revision: 1, updated_at: 1 },
  window: {
    durable: true as const,
    tracked_since: "2026-01-01T00:00:00.000Z",
    requests: 0,
    reservations: 0,
  },
  requests: { retained: 0, limit: 500 as const, metadata_only: true as const },
});

const fakeStub = (): GatewayStub => ({
  getGatewayStatus: vi.fn(async () => status()),
  getModels: vi.fn(async () => ({
    object: "list" as const,
    data: status().aliases.map((alias) => ({
      id: alias.tier,
      object: "model" as const,
      created: 0 as const,
      owned_by: "stavka" as const,
      resolution: { seat: alias.seat, model: alias.model },
    })),
  })),
  listRecentRequests: vi.fn(async () => []),
  remapAlias: vi.fn(async () => status()),
  setKillSwitch: vi.fn(async () => status()),
  putAuth: vi.fn(async (provider: GatewayProvider) => ({
    provider,
    configured: true,
    persisted: true,
    revision: 3,
    updated_at: 9,
  })),
  deleteAuth: vi.fn(async (provider: GatewayProvider) => ({
    provider,
    configured: false,
    persisted: false,
    revision: 0,
  })),
  fetch: vi.fn(async () => Response.json({ proxied: true })),
});

const app = createGatewayTestHandler();

afterAll(() => app.dispose());

const request = (
  path: string,
  init: RequestInit | undefined,
  env: GatewayEnv,
  stub: GatewayStub,
): Promise<Response> => {
  const origin = env.ENVIRONMENT === "local" ? "http://127.0.0.1" : "http://gateway.test";
  return handleTestRequest(app.handler, new Request(`${origin}${path}`, init), env, {
    resolveGateway: () => stub,
  });
};

describe("hosted gateway Worker router", () => {
  it("fails closed when the machine bearer key is absent or wrong", async () => {
    const stub = fakeStub();
    const missing = await request("/healthz", undefined, environment(), stub);
    const wrong = await request(
      "/healthz",
      { headers: { authorization: "Bearer wrong" } },
      environment(),
      stub,
    );

    expect(missing.status).toBe(401);
    expect(wrong.status).toBe(401);
    expect(stub.getGatewayStatus).not.toHaveBeenCalled();
  });

  it("reports machine-readable health without waking the container", async () => {
    const stub = fakeStub();
    const response = await request(
      "/healthz",
      { headers: { authorization: bearer } },
      environment(),
      stub,
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      service: "stavka-maskirovka-gateway",
      auth: {
        claude: { configured: true, persisted: true, revision: 2 },
        codex: { configured: false, persisted: false },
      },
    });
    expect(stub.fetch).not.toHaveBeenCalled();
  });

  it("never echoes subscription tokens from put or delete auth admin routes", async () => {
    const stub = fakeStub();
    const env = {
      ...environment(),
      ENVIRONMENT: "local",
      DEV_ACCESS_EMAIL: "owner@example.test",
    };
    const secret = "subscription-token-must-not-leak";

    const put = await request(
      "/admin/auth/claude",
      {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token: secret }),
      },
      env,
      stub,
    );
    const del = await request("/admin/auth/codex", { method: "DELETE" }, env, stub);
    const admin = await request("/admin/status", undefined, env, stub);

    expect(put.status).toBe(200);
    expect(del.status).toBe(200);
    expect(admin.status).toBe(200);
    expect(stub.putAuth).toHaveBeenCalledWith("claude", secret);
    expect(stub.deleteAuth).toHaveBeenCalledWith("codex");

    const putBody = await put.text();
    const delBody = await del.text();
    const adminBody = await admin.text();
    expect(putBody).not.toContain(secret);
    expect(delBody).not.toContain(secret);
    expect(adminBody).not.toContain(secret);
    expect(JSON.parse(putBody)).toMatchObject({
      provider: "claude",
      configured: true,
      persisted: true,
      revision: 3,
    });
    expect(JSON.parse(putBody)).not.toHaveProperty("token");
    expect(JSON.parse(delBody)).not.toHaveProperty("token");
  });

  it("requires Access admin for credential mutation and rejects service-token writes", async () => {
    const stub = fakeStub();
    const unauthenticated = await request(
      "/admin/auth/claude",
      {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token: "x".repeat(32) }),
      },
      environment(),
      stub,
    );

    expect(unauthenticated.status).toBe(401);
    expect(stub.putAuth).not.toHaveBeenCalled();
  });

  it("forwards machine traffic with generated correlation ids and stripped credentials", async () => {
    const stub = fakeStub();
    let forwarded: Request | undefined;
    vi.mocked(stub.fetch).mockImplementation(async (request) => {
      forwarded = request;
      return Response.json({ proxied: true });
    });

    const response = await request(
      "/v1/responses",
      {
        method: "POST",
        headers: {
          authorization: bearer,
          "content-type": "application/json",
          "cf-access-jwt-assertion": "should-be-removed",
          "x-request-id": "caller-controlled",
        },
        body: JSON.stringify({ model: "stavka/sergeant", input: "Hold" }),
      },
      environment(),
      stub,
    );

    expect(response.status).toBe(200);
    expect(forwarded?.headers.get("authorization")).toBeNull();
    expect(forwarded?.headers.get("cf-access-jwt-assertion")).toBeNull();
    expect(forwarded?.headers.get("x-maskirovka-request-id")).toMatch(/^[0-9a-f-]{36}$/iu);
    expect(forwarded?.headers.get("x-maskirovka-dialect")).toBe("openai-responses");
  });
});
