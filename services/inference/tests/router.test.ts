import { afterAll, describe, expect, it, vi } from "vitest";
import { Effect } from "effect";

import type { GatewayEnv, GatewayProvider } from "../src/config";
import type { MaskirovkaGateway } from "../src/gateway-container";
import {
  accountPrincipal,
  createGatewayTestHandler,
  handleTestRequest,
  type GatewayStub,
} from "../src/router";

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
  providerAccounts: [],
  config: { revision: 1, updated_at: 1 },
  window: {
    durable: true as const,
    tracked_since: "2026-01-01T00:00:00.000Z",
    requests: 0,
    reservations: 0,
  },
  requests: { retained: 0, limit: 500 as const, metadata_only: true as const },
});

const activeSession = () => ({
  status: "active" as const,
  user: {
    id: "user-1",
    displayName: "Owner",
    email: "owner@example.test",
    createdAt: 1,
    updatedAt: 1,
  },
  organization: {
    id: "organization-1",
    slug: "stavka-organization",
    name: "Stavka",
    createdAt: 1,
    updatedAt: 1,
  },
  membership: {
    organizationId: "organization-1",
    userId: "user-1",
    role: "owner" as const,
    joinedAt: 1,
  },
});

const accountOwner = {
  owner: { id: "user-1", displayName: "Owner", email: "owner@example.test" },
  organization: { id: "organization-1", name: "Stavka" },
};

const fakeStub = (): GatewayStub => ({
  getGatewayStatus: vi.fn(async () => status()),
  getAccountSession: vi.fn(async () => activeSession()),
  signUpAccount: vi.fn(async () => activeSession()),
  listOrganizationUsers: vi.fn(async () => [
    { user: activeSession().user, membership: activeSession().membership },
  ]),
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
  listProviderAccounts: vi.fn(async () => []),
  putProviderAccount: vi.fn(async (_scope, provider: GatewayProvider, name: string, payload) => ({
    provider,
    name,
    label: payload.label,
    authKind: payload.authKind,
    active: payload.activate ?? false,
    revision: 3,
    createdAt: 8,
    updatedAt: 9,
    ...accountOwner,
  })),
  activateProviderAccount: vi.fn(async (_scope, provider: GatewayProvider, name: string) => ({
    provider,
    name,
    label: name,
    authKind: provider === "codex" ? ("chatgpt-oauth" as const) : ("claude-subscription" as const),
    active: true,
    revision: 3,
    createdAt: 8,
    updatedAt: 9,
    ...accountOwner,
  })),
  deleteProviderAccount: vi.fn(async () => undefined),
  testProviderAccount: vi.fn(async (_scope, provider: GatewayProvider, name: string) => ({
    provider,
    name,
    label: name,
    authKind: provider === "codex" ? ("chatgpt-oauth" as const) : ("claude-subscription" as const),
    active: false,
    revision: 3,
    createdAt: 8,
    updatedAt: 9,
    ...accountOwner,
  })),
  fetchForAccount: vi.fn(async () => Response.json({ proxied: true })),
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
  it("rejects service-token identities from the human account control plane", async () => {
    await expect(
      Effect.runPromise(
        accountPrincipal({
          subject: "automation-service",
          role: "automation",
          serviceToken: true,
          permissions: ["read"],
          claims: { common_name: "automation-service" },
        }),
      ),
    ).rejects.toMatchObject({ status: 403, code: "HUMAN_ACCOUNT_REQUIRED" });
  });

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
    expect(stub.fetchForAccount).not.toHaveBeenCalled();
  });

  it("bootstraps the signed-in owner profile before exposing account data", async () => {
    const stub = fakeStub();
    vi.mocked(stub.getAccountSession).mockResolvedValue({
      status: "setup_required",
      identity: { email: "owner@example.test", accessRole: "owner" },
      canSignUp: true,
    });
    const env = {
      ...environment(),
      ENVIRONMENT: "local",
      DEV_ACCESS_EMAIL: "owner@example.test",
    };

    const session = await request("/auth/session", undefined, env, stub);
    const blockedAccounts = await request("/admin/provider-accounts", undefined, env, stub);
    const created = await request(
      "/auth/signup",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ displayName: "Owner", organizationName: "Stavka" }),
      },
      env,
      stub,
    );

    expect(session.status).toBe(200);
    await expect(session.json()).resolves.toMatchObject({
      status: "setup_required",
      canSignUp: true,
    });
    expect(blockedAccounts.status).toBe(409);
    await expect(blockedAccounts.json()).resolves.toMatchObject({
      error: { code: "SETUP_REQUIRED" },
    });
    expect(stub.listProviderAccounts).not.toHaveBeenCalled();
    expect(created.status).toBe(200);
    expect(stub.signUpAccount).toHaveBeenCalledWith(
      {
        subject: "dev:owner@example.test",
        email: "owner@example.test",
        accessRole: "owner",
      },
      { displayName: "Owner", organizationName: "Stavka" },
    );
  });

  it("returns the signed-in profile with only its scoped provider accounts", async () => {
    const stub = fakeStub();
    const env = {
      ...environment(),
      ENVIRONMENT: "local",
      DEV_ACCESS_EMAIL: "owner@example.test",
    };

    const response = await request("/admin/provider-accounts", undefined, env, stub);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      account: {
        status: "active",
        user: { id: "user-1", email: "owner@example.test" },
        organization: { id: "organization-1", name: "Stavka" },
      },
      accounts: [],
    });
    expect(stub.listProviderAccounts).toHaveBeenCalledWith({
      organizationId: "organization-1",
      userId: "user-1",
    });
  });

  it("rejects a terminal transcript without persisting or echoing it", async () => {
    const stub = fakeStub();
    const transcript = "Welcome to setup\nprivate-token-output";
    const response = await request(
      "/admin/provider-accounts/claude/personal",
      {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          label: "Personal",
          authKind: "claude-subscription",
          credential: { kind: "claude-subscription", oauthToken: transcript },
          activate: true,
        }),
      },
      { ...environment(), ENVIRONMENT: "local", DEV_ACCESS_EMAIL: "owner@example.test" },
      stub,
    );
    expect(response.status).toBe(400);
    expect(await response.text()).not.toContain("private-token-output");
    expect(stub.putProviderAccount).not.toHaveBeenCalled();
  });

  it("never echoes credentials from named-account put or delete routes", async () => {
    const stub = fakeStub();
    const env = {
      ...environment(),
      ENVIRONMENT: "local",
      DEV_ACCESS_EMAIL: "owner@example.test",
    };
    const secret = "sk-ant-oat01-" + "x".repeat(40);

    const put = await request(
      "/admin/provider-accounts/claude/personal",
      {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          label: "Personal",
          authKind: "claude-subscription",
          credential: { kind: "claude-subscription", oauthToken: secret },
          activate: true,
        }),
      },
      env,
      stub,
    );
    const del = await request(
      "/admin/provider-accounts/codex/personal",
      { method: "DELETE" },
      env,
      stub,
    );
    const admin = await request("/admin/status", undefined, env, stub);

    expect(put.status).toBe(200);
    expect(del.status).toBe(200);
    expect(admin.status).toBe(200);
    expect(stub.putProviderAccount).toHaveBeenCalledWith(
      { organizationId: "organization-1", userId: "user-1" },
      "claude",
      "personal",
      expect.objectContaining({ credential: { kind: "claude-subscription", oauthToken: secret } }),
    );
    expect(stub.deleteProviderAccount).toHaveBeenCalledWith(
      { organizationId: "organization-1", userId: "user-1" },
      "codex",
      "personal",
    );

    const putBody = await put.text();
    const delBody = await del.text();
    const adminBody = await admin.text();
    expect(putBody).not.toContain(secret);
    expect(delBody).not.toContain(secret);
    expect(adminBody).not.toContain(secret);
    expect(JSON.parse(putBody)).toMatchObject({
      provider: "claude",
      name: "personal",
      revision: 3,
    });
    expect(JSON.parse(putBody)).not.toHaveProperty("token");
    expect(JSON.parse(delBody)).not.toHaveProperty("token");
  });

  it("requires Access admin for credential mutation and rejects service-token writes", async () => {
    const stub = fakeStub();
    const unauthenticated = await request(
      "/admin/provider-accounts/claude/personal",
      {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          label: "Personal",
          authKind: "claude-subscription",
          credential: { kind: "claude-subscription", oauthToken: "x".repeat(32) },
        }),
      },
      environment(),
      stub,
    );

    expect(unauthenticated.status).toBe(401);
    expect(stub.putProviderAccount).not.toHaveBeenCalled();
  });

  it("requires organization admin membership in addition to Access admin", async () => {
    const stub = fakeStub();
    vi.mocked(stub.getAccountSession).mockResolvedValue({
      ...activeSession(),
      membership: { ...activeSession().membership, role: "member" },
    });
    const response = await request(
      "/admin/provider-accounts/claude/personal",
      {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          label: "Personal",
          authKind: "claude-subscription",
          credential: { kind: "claude-subscription", oauthToken: "x".repeat(32) },
        }),
      },
      {
        ...environment(),
        ENVIRONMENT: "local",
        DEV_ACCESS_EMAIL: "owner@example.test",
      },
      stub,
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "ORGANIZATION_ADMIN_REQUIRED" },
    });
    expect(stub.putProviderAccount).not.toHaveBeenCalled();
  });

  it("rejects machine-only provider invocation", async () => {
    const stub = fakeStub();
    const response = await request(
      "/v1/responses",
      {
        method: "POST",
        headers: {
          authorization: bearer,
          "content-type": "application/json",
        },
        body: JSON.stringify({ model: "stavka/sergeant", input: "Hold" }),
      },
      environment(),
      stub,
    );

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "ACCESS_REQUIRED" },
    });
    expect(stub.fetchForAccount).not.toHaveBeenCalled();
  });

  it("forwards authorized owner traffic with its account scope and stripped credentials", async () => {
    const stub = fakeStub();
    let forwarded: Request | undefined;
    vi.mocked(stub.fetchForAccount).mockImplementation(async (_scope, request) => {
      forwarded = request;
      return Response.json({ proxied: true });
    });
    const env = {
      ...environment(),
      ENVIRONMENT: "local",
      DEV_ACCESS_EMAIL: "owner@example.test",
    };

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
      env,
      stub,
    );

    expect(response.status).toBe(200);
    expect(stub.fetchForAccount).toHaveBeenCalledWith(
      { organizationId: "organization-1", userId: "user-1" },
      expect.any(Request),
    );
    expect(forwarded?.headers.get("authorization")).toBeNull();
    expect(forwarded?.headers.get("cf-access-jwt-assertion")).toBeNull();
    expect(forwarded?.headers.get("x-maskirovka-request-id")).toMatch(/^[0-9a-f-]{36}$/iu);
    expect(forwarded?.headers.get("x-maskirovka-dialect")).toBe("openai-responses");
  });

  it("rejects non-admin organization members from provider invocation", async () => {
    const stub = fakeStub();
    vi.mocked(stub.getAccountSession).mockResolvedValue({
      ...activeSession(),
      membership: { ...activeSession().membership, role: "member" },
    });
    const response = await request(
      "/v1/messages",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "stavka/commander",
          max_tokens: 64,
          messages: [{ role: "user", content: "Hold" }],
        }),
      },
      {
        ...environment(),
        ENVIRONMENT: "local",
        DEV_ACCESS_EMAIL: "owner@example.test",
      },
      stub,
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "ORGANIZATION_ADMIN_REQUIRED" },
    });
    expect(stub.fetchForAccount).not.toHaveBeenCalled();
  });
});
