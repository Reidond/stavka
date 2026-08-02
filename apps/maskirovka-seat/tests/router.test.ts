import type { MaskirovkaSeat } from "../src/seat-container";
import { afterAll, describe, expect, it, vi } from "vitest";

import type { SeatEnv, SeatProvider } from "../src/config";
import { createSeatTestHandler, handleTestRequest, type HostedSeatStub } from "../src/router";

const bearer = "Bearer sk-stavka-test-seat";

const environment = (provider: SeatProvider = "codex"): SeatEnv => ({
  MASKIROVKA_SEAT: {} as DurableObjectNamespace<MaskirovkaSeat>,
  MASKIROVKA_SEAT_KEY: "sk-stavka-test-seat",
  ENVIRONMENT: "test",
  SEAT_ID: `${provider}-seat`,
  SEAT_PROVIDER: provider,
  MODEL_ALIASES:
    provider === "codex"
      ? JSON.stringify({ "stavka/sergeant": "gpt-5.6-luna", "stavka/heavy": "gpt-5.6-terra" })
      : JSON.stringify({ "stavka/commander": "claude-opus-4-6" }),
  CONTAINER_SLEEP_AFTER: "30s",
});

const status = (provider: SeatProvider) => ({
  ok: true,
  service: "stavka-maskirovka-seat" as const,
  seat_id: `${provider}-seat`,
  provider,
  aliases:
    provider === "codex"
      ? { "stavka/sergeant": "gpt-5.6-luna", "stavka/heavy": "gpt-5.6-terra" }
      : { "stavka/commander": "claude-opus-4-6" },
  container: { status: "stopped", last_change: 1 },
  auth: { configured: true, persisted: true, revision: 2, updated_at: 1 },
  controls: { killed: false, updated_at: 0 },
});

const operationsStatus = (provider: SeatProvider) => ({
  ...status(provider),
  requests: { retained: 0, limit: 200 as const, metadata_only: true as const },
  capabilities: {
    scope: "single-hosted-seat" as const,
    tier_remap: "model-only" as const,
    kill_switch: "this-seat-only" as const,
    unsupported: ["seat-registry", "fallback-routing", "budget-accounting"],
  },
});

const fakeStub = (
  provider: SeatProvider,
  onFetch?: (request: Request) => void,
): HostedSeatStub => ({
  getSeatStatus: vi.fn(async () => status(provider)),
  getOperationsStatus: vi.fn(async () => operationsStatus(provider)),
  listRecentRequests: vi.fn(async () => []),
  remapAlias: vi.fn(async () => operationsStatus(provider)),
  setKillSwitch: vi.fn(async () => operationsStatus(provider)),
  fetch: vi.fn(async (request) => {
    onFetch?.(request);
    return Response.json({ proxied: true, model: request.headers.get("x-maskirovka-model") });
  }),
});

const app = createSeatTestHandler();

afterAll(() => app.dispose());

const request = (
  path: string,
  init: RequestInit | undefined,
  env: SeatEnv,
  stub: HostedSeatStub,
): Promise<Response> =>
  handleTestRequest(
    app.handler,
    new Request(`${env.ENVIRONMENT === "local" ? "http://127.0.0.1" : "http://seat.test"}${path}`, init),
    env,
    {
    resolveSeat: () => stub,
    },
  );

describe("hosted seat Worker router", () => {
  it("fails closed when the machine bearer key is absent or wrong", async () => {
    const stub = fakeStub("codex");
    const missing = await request("/healthz", undefined, environment(), stub);
    const wrong = await request(
      "/healthz",
      {
        headers: { authorization: "Bearer wrong" },
      },
      environment(),
      stub,
    );

    expect(missing.status).toBe(401);
    expect(wrong.status).toBe(401);
    expect(stub.getSeatStatus).not.toHaveBeenCalled();
  });

  it("authenticates unmatched routes before returning not found", async () => {
    const stub = fakeStub("codex");
    const unauthenticated = await request("/not-a-route", undefined, environment(), stub);
    const authenticated = await request(
      "/not-a-route",
      {
        headers: { authorization: bearer },
      },
      environment(),
      stub,
    );

    expect(unauthenticated.status).toBe(401);
    expect(authenticated.status).toBe(404);
    expect(stub.getSeatStatus).not.toHaveBeenCalled();
    expect(stub.fetch).not.toHaveBeenCalled();
  });

  it("reports machine-readable status without sending traffic to the container", async () => {
    const stub = fakeStub("codex");
    const response = await request(
      "/healthz",
      {
        headers: { authorization: bearer },
      },
      environment(),
      stub,
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      provider: "codex",
      container: { status: "stopped" },
      auth: { configured: true, persisted: true, revision: 2 },
    });
    expect(stub.fetch).not.toHaveBeenCalled();
  });

  it("lists only the aliases resolved by this seat without waking it", async () => {
    const stub = fakeStub("codex");
    const response = await request(
      "/v1/models",
      {
        headers: { authorization: bearer },
      },
      environment(),
      stub,
    );
    const body = (await response.json()) as {
      data: Array<{ id: string; resolution: { model: string } }>;
    };

    expect(response.status).toBe(200);
    expect(body.data).toEqual([
      expect.objectContaining({
        id: "stavka/sergeant",
        resolution: { model: "gpt-5.6-luna", provider: "codex", seat_id: "codex-seat" },
      }),
      expect.objectContaining({
        id: "stavka/heavy",
        resolution: { model: "gpt-5.6-terra", provider: "codex", seat_id: "codex-seat" },
      }),
    ]);
    expect(stub.fetch).not.toHaveBeenCalled();
  });

  it("resolves Responses aliases and never forwards the machine credential", async () => {
    let forwarded: Request | undefined;
    const stub = fakeStub("codex", (request) => {
      forwarded = request;
    });
    const response = await request(
      "/v1/responses",
      {
        method: "POST",
        headers: {
          authorization: bearer,
          "content-type": "application/json",
          "x-request-id": "caller-secret-correlation-text",
        },
        body: JSON.stringify({ model: "stavka/heavy", input: "Return a sitrep" }),
      },
      environment(),
      stub,
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("x-maskirovka-model")).toBe("gpt-5.6-terra");
    expect(forwarded).toBeDefined();
    expect(forwarded?.headers.has("authorization")).toBe(false);
    expect(forwarded?.headers.get("x-maskirovka-request-id")).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
    );
    expect(forwarded?.headers.get("x-maskirovka-request-id")).not.toContain("caller-secret");
    expect(response.headers.get("x-request-id")).toBe(
      forwarded?.headers.get("x-maskirovka-request-id"),
    );
    await expect(forwarded?.json()).resolves.toMatchObject({
      model: "gpt-5.6-terra",
      input: "Return a sitrep",
    });
  });

  it("preserves upstream status, body, and headers while adding seat metadata", async () => {
    const stub: HostedSeatStub = {
      ...fakeStub("codex"),
      getSeatStatus: vi.fn(async () => status("codex")),
      fetch: vi.fn(
        async () =>
          new Response("upstream-overloaded", {
            status: 429,
            statusText: "Too Many Requests",
            headers: { "content-type": "text/plain", "x-upstream-trace": "trace-7" },
          }),
      ),
    };
    const response = await request(
      "/v1/responses",
      {
        method: "POST",
        headers: { authorization: bearer, "content-type": "application/json" },
        body: JSON.stringify({ model: "stavka/heavy", input: "Return a sitrep" }),
      },
      environment(),
      stub,
    );

    expect(response.status).toBe(429);
    expect(response.statusText).toBe("Too Many Requests");
    expect(response.headers.get("x-upstream-trace")).toBe("trace-7");
    expect(response.headers.get("x-maskirovka-seat-id")).toBe("codex-seat");
    expect(response.headers.get("x-maskirovka-seat-provider")).toBe("codex");
    expect(response.headers.get("x-maskirovka-model")).toBe("gpt-5.6-terra");
    await expect(response.text()).resolves.toBe("upstream-overloaded");
  });

  it("serves Anthropic Messages only from a Claude seat", async () => {
    const decisionSchema = {
      type: "object",
      properties: { summary: { type: "string" }, commands: { type: "array" } },
      required: ["summary", "commands"],
    };
    let forwarded: Request | undefined;
    const stub = fakeStub("claude", (request) => {
      forwarded = request;
    });
    const response = await request(
      "/v1/messages",
      {
        method: "POST",
        headers: {
          authorization: bearer,
          "anthropic-version": "2023-06-01",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: "stavka/commander",
          max_tokens: 256,
          messages: [{ role: "user", content: "Issue orders" }],
          output_config: {
            format: { type: "json_schema", schema: decisionSchema },
          },
        }),
      },
      environment("claude"),
      stub,
    );

    expect(response.status).toBe(200);
    expect(forwarded?.headers.get("anthropic-version")).toBe("2023-06-01");
    await expect(forwarded?.json()).resolves.toMatchObject({
      model: "claude-opus-4-6",
      output_config: {
        format: { type: "json_schema", schema: decisionSchema },
      },
    });

    const invalid = await request(
      "/v1/messages",
      {
        method: "POST",
        headers: {
          authorization: bearer,
          "anthropic-version": "2023-06-01",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: "stavka/commander",
          max_tokens: 256,
          messages: [{ role: "user", content: "Issue orders" }],
          output_config: { format: { type: "text", schema: decisionSchema } },
        }),
      },
      environment("claude"),
      stub,
    );
    expect(invalid.status).toBe(400);
    expect(stub.fetch).toHaveBeenCalledTimes(1);
  });

  it("rejects unknown aliases, cross-provider dialects, streaming, and chat completions", async () => {
    const stub = fakeStub("codex");
    const post = (path: string, body: unknown) =>
      request(
        path,
        {
          method: "POST",
          headers: { authorization: bearer, "content-type": "application/json" },
          body: JSON.stringify(body),
        },
        environment(),
        stub,
      );

    expect((await post("/v1/responses", { model: "gpt-5.6-terra", input: "x" })).status).toBe(404);
    expect(
      (await post("/v1/responses", { model: "stavka/heavy", input: "x", stream: true })).status,
    ).toBe(400);
    expect(
      (
        await post("/v1/messages", {
          model: "stavka/heavy",
          max_tokens: 10,
          messages: [{ role: "user", content: "x" }],
        })
      ).status,
    ).toBe(404);
    expect(
      (await post("/v1/chat/completions", { model: "stavka/heavy", messages: [] })).status,
    ).toBe(404);
    expect(stub.fetch).not.toHaveBeenCalled();
  });

  it("rejects oversized and compressed bodies before waking the seat", async () => {
    const stub = fakeStub("codex");
    const oversized = await request(
      "/v1/responses",
      {
        method: "POST",
        headers: {
          authorization: bearer,
          "content-type": "application/json",
          "content-length": "1048577",
        },
        body: "{}",
      },
      environment(),
      stub,
    );
    const compressed = await request(
      "/v1/responses",
      {
        method: "POST",
        headers: {
          authorization: bearer,
          "content-type": "application/json",
          "content-encoding": "gzip",
        },
        body: "compressed",
      },
      environment(),
      stub,
    );

    expect(oversized.status).toBe(413);
    expect(compressed.status).toBe(415);
    expect(stub.fetch).not.toHaveBeenCalled();
  });

  it("keeps Access and seat bearer credentials on separate route groups", async () => {
    const stub = fakeStub("codex");
    const localAccess = {
      ...environment(),
      ENVIRONMENT: "local",
      DEV_ACCESS_EMAIL: "owner@example.test",
    };

    const machineWithAccessOnly = await request("/healthz", undefined, localAccess, stub);
    const humanWithBearerOnly = await request(
      "/admin/status",
      { headers: { authorization: bearer } },
      environment(),
      stub,
    );

    expect(machineWithAccessOnly.status).toBe(401);
    expect(humanWithBearerOnly.status).toBe(401);
    expect(stub.getSeatStatus).not.toHaveBeenCalled();
    expect(stub.getOperationsStatus).not.toHaveBeenCalled();
  });

  it("refuses synthetic local Access configuration on a public hosted URL", async () => {
    const stub = fakeStub("codex");
    const localAccess = {
      ...environment(),
      ENVIRONMENT: "local",
      DEV_ACCESS_EMAIL: "owner@example.test",
    };
    const response = await handleTestRequest(
      app.handler,
      new Request("https://seat.example.test/admin/status"),
      localAccess,
      { resolveSeat: () => stub },
    );

    expect(response.status).toBe(401);
    expect(stub.getOperationsStatus).not.toHaveBeenCalled();
  });

  it("Access-protects dashboard assets and serves SPA fallbacks through the Worker binding", async () => {
    const stub = fakeStub("codex");
    const fetchAsset = vi.fn(async (input: RequestInfo | URL) => {
      const assetRequest = input instanceof Request ? input : new Request(input);
      const path = new URL(assetRequest.url).pathname;
      if (path === "/index.html") {
        return new Response("<html>hosted seat</html>", {
          headers: { "content-type": "text/html" },
        });
      }
      if (path === "/assets/app.js") {
        return new Response("dashboard()", {
          headers: { "content-type": "text/javascript" },
        });
      }
      return new Response("missing", { status: 404 });
    });
    const localAccess = {
      ...environment(),
      ENVIRONMENT: "local",
      DEV_ACCESS_EMAIL: "owner@example.test",
      ASSETS: { fetch: fetchAsset } as unknown as Fetcher,
    };

    const denied = await request("/_/", undefined, environment(), stub);
    const index = await request("/_/", undefined, localAccess, stub);
    const asset = await request("/_/assets/app.js", undefined, localAccess, stub);
    const fallback = await request("/_/future/operations", undefined, localAccess, stub);

    expect(denied.status).toBe(401);
    expect(index.status).toBe(200);
    await expect(index.text()).resolves.toContain("hosted seat");
    expect(index.headers.get("cache-control")).toBe("no-cache");
    expect(asset.status).toBe(200);
    await expect(asset.text()).resolves.toBe("dashboard()");
    expect(asset.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    expect(fallback.status).toBe(200);
    await expect(fallback.text()).resolves.toContain("hosted seat");
    expect(fallback.headers.get("cache-control")).toBe("no-cache");
    expect(fetchAsset).toHaveBeenCalled();
    expect(stub.fetch).not.toHaveBeenCalled();
  });

  it("exposes truthful Access admin status, request metadata, remap, and leaf kill switch", async () => {
    const stub = fakeStub("codex");
    vi.mocked(stub.listRecentRequests).mockResolvedValue([
      {
        request_id: "00000000-0000-4000-8000-000000000001",
        timestamp: 42,
        dialect: "openai-responses",
        alias: "stavka/heavy",
        model: "gpt-5.6-terra",
        status: 200,
        latency_ms: 17,
        queue_depth: 0,
      },
    ]);
    const env = {
      ...environment(),
      ENVIRONMENT: "local",
      DEV_ACCESS_EMAIL: "owner@example.test",
    };

    const admin = await request("/admin/status", undefined, env, stub);
    const feed = await request("/admin/requests?limit=10", undefined, env, stub);
    const remap = await request(
      "/admin/aliases/stavka%2Fheavy",
      {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "gpt-5.6-terra-revised" }),
      },
      env,
      stub,
    );
    const killed = await request(
      "/admin/kill-switch",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ enabled: true }),
      },
      env,
      stub,
    );

    expect(admin.status).toBe(200);
    await expect(admin.json()).resolves.toMatchObject({
      seat_id: "codex-seat",
      controls: { killed: false },
      access: { role: "owner", can_admin: true, service_token: false },
      requests: { retained: 0, limit: 200, metadata_only: true },
      capabilities: {
        scope: "single-hosted-seat",
        tier_remap: "model-only",
        kill_switch: "this-seat-only",
        unsupported: ["seat-registry", "fallback-routing", "budget-accounting"],
      },
    });
    expect(feed.status).toBe(200);
    await expect(feed.json()).resolves.toMatchObject({
      requests: [
        expect.objectContaining({
          alias: "stavka/heavy",
          model: "gpt-5.6-terra",
          latency_ms: 17,
        }),
      ],
    });
    expect(stub.listRecentRequests).toHaveBeenCalledWith(10);
    expect(remap.status).toBe(200);
    expect(stub.remapAlias).toHaveBeenCalledWith("stavka/heavy", "gpt-5.6-terra-revised");
    expect(killed.status).toBe(200);
    expect(stub.setKillSwitch).toHaveBeenCalledWith(true);
    expect(stub.fetch).not.toHaveBeenCalled();
  });

  it("propagates client aborts to the container request", async () => {
    let forwardedSignal: AbortSignal | undefined;
    let markStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const stub: HostedSeatStub = {
      ...fakeStub("codex"),
      getSeatStatus: vi.fn(async () => status("codex")),
      fetch: vi.fn((forwarded) => {
        forwardedSignal = forwarded.signal;
        markStarted?.();
        return new Promise<Response>((_resolve, reject) => {
          forwarded.signal.addEventListener("abort", () => reject(forwarded.signal.reason), {
            once: true,
          });
        });
      }),
    };
    const controller = new AbortController();
    const pending = request(
      "/v1/responses",
      {
        method: "POST",
        headers: { authorization: bearer, "content-type": "application/json" },
        body: JSON.stringify({ model: "stavka/heavy", input: "Wait" }),
        signal: controller.signal,
      },
      environment(),
      stub,
    );

    await started;
    controller.abort(new Error("client disconnected"));
    expect(forwardedSignal?.aborted).toBe(true);
    await pending.catch(() => undefined);
  });
});
