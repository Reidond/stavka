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
