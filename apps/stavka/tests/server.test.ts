import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Env } from "../src/config";

const mocks = vi.hoisted(() => ({
  agentRoute: vi.fn<(request: Request, env: unknown) => Promise<Response | null>>(),
  tanStackFetch: vi.fn<(request: Request) => Promise<Response>>(),
}));

vi.mock("agents", () => ({
  Agent: class {},
  callable:
    () =>
    <This, Args extends unknown[], Return>(target: (this: This, ...args: Args) => Return) =>
      target,
  getCurrentAgent: () => ({}),
  routeAgentRequest: mocks.agentRoute,
}));

vi.mock("cloudflare:workers", () => ({
  DurableObject: class {},
}));

vi.mock("@tanstack/react-start/server-entry", () => ({
  default: { fetch: mocks.tanStackFetch },
}));

const { handleRequest } = await import("../src/server");

const makeEnv = (overrides: Partial<Env> = {}): Env => ({
  SIM_WORLD: {} as Env["SIM_WORLD"],
  WAR_BENCH_STUDY_STORE: {} as Env["WAR_BENCH_STUDY_STORE"],
  ...overrides,
});

describe("Poligon HTTP routing", () => {
  beforeEach(() => {
    mocks.agentRoute.mockReset().mockResolvedValue(null);
    mocks.tanStackFetch.mockReset().mockResolvedValue(new Response("app"));
  });

  it("serves the public health contract without Access", async () => {
    const response = await handleRequest(new Request("https://poligon.test/healthz"), makeEnv());

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      ok: true,
      service: "stavka-poligon",
      scenarios: ["movement", "engagement", "mechanized"],
      fixed_step_ms: 100,
    });
    expect(mocks.agentRoute).not.toHaveBeenCalled();
    expect(mocks.tanStackFetch).not.toHaveBeenCalled();
  });

  it.each([
    "/admin/status",
    "/api/system/commander",
    "/api/commander/export?session_id=secret&faction=OPFOR",
  ])("rejects unauthenticated operations reads: %s", async (path) => {
    const fetch = vi.fn<Fetcher["fetch"]>();
    const response = await handleRequest(
      new Request(`https://poligon.test${path}`),
      makeEnv({
        INFERENCE_SERVICE: { fetch },
        COMMANDER_SERVICE: { fetch, connect: vi.fn() },
      }),
    );
    expect(response.status).toBe(401);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("preserves session identity, Access headers, and upstream failures across the Commander binding", async () => {
    const fetch = vi.fn<Fetcher["fetch"]>(async () =>
      Response.json({ error: { code: "NOT_FOUND" } }, { status: 404 }),
    );
    const response = await handleRequest(
      new Request(
        "http://127.0.0.1/api/commander/export?session_id=match%2F42&faction=BLUFOR&epoch=7",
        {
          headers: { "cf-access-jwt-assertion": "forwarded-identity" },
        },
      ),
      makeEnv({
        ENVIRONMENT: "local",
        DEV_ACCESS_EMAIL: "qa@localhost",
        COMMANDER_SERVICE: { fetch, connect: vi.fn() },
      }),
    );
    expect(response.status).toBe(404);
    const forwarded = fetch.mock.calls[0]?.[0] as Request;
    expect(forwarded.url).toBe(
      "http://127.0.0.1/admin/export?session_id=match%2F42&faction=BLUFOR&epoch=7",
    );
    expect(forwarded.headers.get("cf-access-jwt-assertion")).toBe("forwarded-identity");
    await expect(response.json()).resolves.toEqual({ error: { code: "NOT_FOUND" } });
  });

  it("reports an unavailable Commander binding as an uncached 503", async () => {
    for (const binding of [
      undefined,
      { fetch: vi.fn<Fetcher["fetch"]>().mockRejectedValue(new Error("offline")) },
    ]) {
      const response = await handleRequest(
        new Request("http://127.0.0.1/api/system/commander"),
        makeEnv({
          ENVIRONMENT: "local",
          DEV_ACCESS_EMAIL: "qa@localhost",
          ...(binding ? { COMMANDER_SERVICE: { ...binding, connect: vi.fn() } } : {}),
        }),
      );
      expect(response.status).toBe(503);
      expect(response.headers.get("cache-control")).toBe("no-store");
      await expect(response.json()).resolves.toEqual({
        error: { code: "COMMANDER_UNAVAILABLE", message: "Commander service is unavailable" },
      });
    }
  });

  it("protects the TanStack fallback with Cloudflare Access", async () => {
    const response = await handleRequest(new Request("https://poligon.test/operations"), makeEnv());

    expect(response.status).toBe(401);
    expect(response.headers.get("cache-control")).toBe("no-store");
    await expect(response.json()).resolves.toEqual({
      error: {
        code: "ACCESS_REQUIRED",
        message: "Cloudflare Access identity required",
      },
    });
    expect(mocks.tanStackFetch).not.toHaveBeenCalled();
  });

  it("forwards provider-account operations to private inference after Access", async () => {
    const inferenceFetch = vi.fn<Fetcher["fetch"]>(async () =>
      Response.json({ accounts: [{ provider: "codex", name: "production" }] }),
    );
    const response = await handleRequest(
      new Request("http://127.0.0.1/admin/provider-accounts", {
        headers: { "x-request-marker": "provider-control" },
      }),
      makeEnv({
        ENVIRONMENT: "local",
        DEV_ACCESS_EMAIL: "operator@example.test",
        INFERENCE_SERVICE: { fetch: inferenceFetch },
      }),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      accounts: [{ provider: "codex", name: "production" }],
    });
    expect(inferenceFetch).toHaveBeenCalledOnce();
    const forwarded = inferenceFetch.mock.calls[0]?.[0];
    expect(forwarded).toBeInstanceOf(Request);
    if (!(forwarded instanceof Request)) throw new Error("Expected a forwarded Request");
    expect(forwarded.url).toBe("http://127.0.0.1/admin/provider-accounts");
    expect(forwarded.headers.get("x-request-marker")).toBe("provider-control");
    expect(mocks.tanStackFetch).not.toHaveBeenCalled();
  });

  it("forwards model requests only after Cloudflare Access", async () => {
    let forwarded: Request | undefined;
    const inferenceFetch = vi.fn<Fetcher["fetch"]>(async (request) => {
      forwarded = request instanceof Request ? request : new Request(request);
      return Response.json({ id: "response-1" });
    });
    const response = await handleRequest(
      new Request("http://127.0.0.1/v1/responses", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "stavka/sergeant", input: "Hold" }),
      }),
      makeEnv({
        ENVIRONMENT: "local",
        DEV_ACCESS_EMAIL: "owner@example.test",
        INFERENCE_SERVICE: { fetch: inferenceFetch },
      }),
    );

    expect(response.status).toBe(200);
    expect(forwarded?.url).toBe("http://127.0.0.1/v1/responses");
    expect(forwarded?.method).toBe("POST");
    await expect(forwarded?.json()).resolves.toEqual({
      model: "stavka/sergeant",
      input: "Hold",
    });
    expect(mocks.tanStackFetch).not.toHaveBeenCalled();
  });

  it("rejects model requests without Cloudflare Access", async () => {
    const inferenceFetch = vi.fn<Fetcher["fetch"]>();
    const response = await handleRequest(
      new Request("https://stavka.test/v1/messages", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "stavka/commander", messages: [] }),
      }),
      makeEnv({ INFERENCE_SERVICE: { fetch: inferenceFetch } }),
    );

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "ACCESS_REQUIRED" },
    });
    expect(inferenceFetch).not.toHaveBeenCalled();
  });

  it("forwards first-time account setup to the private identity control plane", async () => {
    let forwarded: Request | undefined;
    const inferenceFetch = vi.fn<Fetcher["fetch"]>(async (request) => {
      forwarded = request instanceof Request ? request : new Request(request);
      return Response.json({ status: "active" });
    });
    const response = await handleRequest(
      new Request("http://127.0.0.1/auth/signup", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ displayName: "Owner", organizationName: "Stavka" }),
      }),
      makeEnv({
        ENVIRONMENT: "local",
        DEV_ACCESS_EMAIL: "owner@example.test",
        INFERENCE_SERVICE: { fetch: inferenceFetch },
      }),
    );

    expect(response.status).toBe(200);
    expect(forwarded?.url).toBe("http://127.0.0.1/auth/signup");
    expect(forwarded?.method).toBe("POST");
    await expect(forwarded?.json()).resolves.toEqual({
      displayName: "Owner",
      organizationName: "Stavka",
    });
    expect(mocks.tanStackFetch).not.toHaveBeenCalled();
  });

  it("fails provider-account operations closed when inference is not bound", async () => {
    const response = await handleRequest(
      new Request("http://127.0.0.1/admin/provider-accounts/codex/production/test", {
        method: "POST",
      }),
      makeEnv({
        ENVIRONMENT: "local",
        DEV_ACCESS_EMAIL: "operator@example.test",
      }),
    );

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: "INFERENCE_UNAVAILABLE",
        message: "Provider account service is unavailable",
      },
    });
    expect(mocks.tanStackFetch).not.toHaveBeenCalled();
  });

  it("does not enable synthetic Access when ENVIRONMENT is missing", async () => {
    const response = await handleRequest(
      new Request("https://poligon.test/operations"),
      makeEnv({ DEV_ACCESS_EMAIL: "operator@example.test" }),
    );

    expect(response.status).toBe(401);
    expect(mocks.tanStackFetch).not.toHaveBeenCalled();
  });

  it("fails a WebSocket upgrade closed when ENVIRONMENT is unknown", async () => {
    const response = await handleRequest(
      new Request("http://127.0.0.1/agents/sim-world/demo", {
        headers: { upgrade: "websocket" },
      }),
      makeEnv({
        ENVIRONMENT: "locla",
        DEV_ACCESS_EMAIL: "operator@example.test",
      }),
    );

    expect(response.status).toBe(401);
    expect(mocks.agentRoute).not.toHaveBeenCalled();
  });

  it("passes an Agent response through without losing its WebSocket attachment", async () => {
    const webSocket = { id: "upgrade-socket" };
    const agentResponse = new Response("agent-response", {
      headers: { "x-agent": "sim-world" },
    });
    Object.defineProperty(agentResponse, "webSocket", { value: webSocket });
    mocks.agentRoute.mockResolvedValue(agentResponse);

    const response = await handleRequest(
      new Request("http://127.0.0.1/agents/sim-world/demo", {
        headers: { upgrade: "websocket" },
      }),
      makeEnv({
        ENVIRONMENT: "local",
        DEV_ACCESS_EMAIL: "operator@example.test",
      }),
    );

    expect(response).toBe(agentResponse);
    expect((response as Response & { readonly webSocket: unknown }).webSocket).toBe(webSocket);
    expect(response.headers.get("x-agent")).toBe("sim-world");
    expect(mocks.tanStackFetch).not.toHaveBeenCalled();
  });

  it("refuses synthetic local Access on a public URL", async () => {
    const response = await handleRequest(
      new Request("https://poligon.test/operations"),
      makeEnv({
        ENVIRONMENT: "local",
        DEV_ACCESS_EMAIL: "operator@example.test",
      }),
    );

    expect(response.status).toBe(401);
    expect(mocks.tanStackFetch).not.toHaveBeenCalled();
  });
});
