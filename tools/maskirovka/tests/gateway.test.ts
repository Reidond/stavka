import { Effect } from "effect";
import { HttpRouter } from "effect/unstable/http";
import { describe, expect, it } from "vitest";

import { runAiDecision } from "../../../apps/commander/src/brain/llm-client";
import { readConfig, type MaskirovkaConfig } from "../src/config";
import { normalizeRequest } from "../src/domain/protocol";
import { GatewayError, type SeatInvocation, type SeatResult } from "../src/domain/types";
import { MemoryCacheRepository } from "../src/repositories/cache-repository";
import { MemoryGatewayConfigRepository } from "../src/repositories/config-repository";
import { MemoryRequestLogRepository } from "../src/repositories/request-log-repository";
import { MemoryWindowTrackerRepository } from "../src/repositories/window-tracker-repository";
import { createMaskirovkaApp, type RouterDependencies } from "../src/router";
import { MockSeat } from "../src/seats/mock-seat";
import type { SeatAdapter } from "../src/seats/seat-adapter";
import { startServer } from "../src/server";
import { GatewayService } from "../src/services/gateway-service";
import { SeatRegistry } from "../src/services/seat-registry";
import { WindowTracker } from "../src/services/window-tracker";

const baseConfig = (mode: MaskirovkaConfig["mode"] = "live", apiKey?: string): MaskirovkaConfig => {
  const config = readConfig(
    { ENVIRONMENT: "local", DEV_ACCESS_EMAIL: "operator@example.test" },
    "/tmp/stavka-maskirovka-test",
  );
  return { ...config, mode, ...(apiKey ? { apiKey } : {}) };
};

const makeService = (
  config: MaskirovkaConfig,
  options: {
    readonly cache?: MemoryCacheRepository;
    readonly adapter?: SeatAdapter;
    readonly adapters?: readonly SeatAdapter[];
    readonly tracker?: WindowTracker;
  } = {},
): Effect.Effect<GatewayService, GatewayError> => Effect.gen(function*() {
  const registry = new SeatRegistry(
    config.aliases,
    config.seats,
    new MemoryGatewayConfigRepository(),
    config.apiFallbackAliases,
  );
  const service = new GatewayService(
    config,
    registry,
    options.cache ?? new MemoryCacheRepository(),
    new MemoryRequestLogRepository(),
    options.adapters ?? [options.adapter ?? new MockSeat()],
    options.tracker,
  );
  yield* service.initialize();
  return service;
});

const withWebApp = <A>(
  dependencies: RouterDependencies,
  use: (request: (path: string, init?: RequestInit) => Promise<Response>) => Promise<A>,
): Promise<A> => Effect.runPromise(Effect.scoped(
  Effect.acquireRelease(
    Effect.sync(() => HttpRouter.toWebHandler(createMaskirovkaApp(dependencies), {
      disableLogger: true,
      routerConfig: { ignoreTrailingSlash: false },
    })),
    ({ dispose }) => Effect.promise(() => dispose()),
  ).pipe(Effect.flatMap(({ handler }) => Effect.tryPromise(() => use(
    (path, init) => handler(new Request(
      path.startsWith("http://") || path.startsWith("https://")
        ? path
        : `http://127.0.0.1${path}`,
      init,
    )),
  )))),
));

const noAssets = { read: () => Effect.succeed(undefined) };

const openAiBody = (input = "Hold position") => ({
  model: "stavka/commander",
  instructions: "Return a structured decision.",
  input,
  text: {
    format: {
      type: "json_schema",
      schema: {
        type: "object",
        properties: {
          summary: { type: "string" },
          commands: { type: "array", items: { type: "object" } },
        },
        required: ["summary", "commands"],
      },
    },
  },
});

describe("Maskirovka Effect HttpApi router", () => {
  it("serves only the current provider dialects through the contract router", async () => {
    const config = baseConfig();
    const service = await Effect.runPromise(makeService(config));
    await withWebApp({ config, service, assets: noAssets }, async (request) => {
      const openAi = await request("/v1/responses", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(openAiBody()),
      });
      expect(openAi.status).toBe(200);
      expect(await openAi.json()).toMatchObject({ object: "response", status: "completed" });
      expect(openAi.headers.get("x-maskirovka-seat")).toBe("mock");

      const anthropic = await request("/v1/messages?beta=true", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "stavka/sergeant",
          max_tokens: 64,
          messages: [{ role: "user", content: [{ type: "text", text: "Hold position" }] }],
        }),
      });
      expect(anthropic.status).toBe(200);
      expect(await anthropic.json()).toMatchObject({ type: "message", role: "assistant" });

      expect((await request("/v1/chat/completions", { method: "POST" })).status).toBe(404);
      expect((await request("/v1/responses", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "gpt-5.6-sol", input: "wrong: concrete model" }),
      })).status).toBe(400);
    });
  });

  it("protects machine and admin routes with a constant-time bearer check", async () => {
    const config: MaskirovkaConfig = {
      ...baseConfig("live", "sk-stavka-maskirovka-test-key"),
      access: {
        environment: "production",
        teamDomain: "team.cloudflareaccess.com",
        audience: "test-audience",
        automationPermissions: ["read"],
      },
    };
    const service = await Effect.runPromise(makeService(config));
    await withWebApp({ config, service, assets: noAssets }, async (request) => {
      expect((await request("/v1/responses", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(openAiBody()),
      })).status).toBe(401);
      expect((await request("/admin/status")).status).toBe(401);
      expect((await request("/v1/models")).status).toBe(200);

      const authorized = await request("/v1/responses", {
        method: "POST",
        headers: {
          authorization: "Bearer sk-stavka-maskirovka-test-key",
          "content-type": "application/json",
        },
        body: JSON.stringify(openAiBody()),
      });
      expect(authorized.status).toBe(200);

      const machineHeaders = {
        authorization: "Bearer sk-stavka-maskirovka-test-key",
        "content-type": "application/json",
      };
      expect((await request("/admin/status", { headers: machineHeaders })).status).toBe(200);
      expect((await request("/admin/aliases/stavka%2Fheavy", {
        method: "PUT",
        headers: machineHeaders,
        body: JSON.stringify({ seat: "mock", model: "machine-must-not-remap" }),
      })).status).toBe(403);
      expect((await request("/admin/kill-switch", {
        method: "POST",
        headers: machineHeaders,
        body: JSON.stringify({ enabled: true }),
      })).status).toBe(403);
    });
  });

  it("accepts only controls that subscription adapters can honor", async () => {
    const config = baseConfig();
    const service = await Effect.runPromise(makeService(config));
    await withWebApp({ config, service, assets: noAssets }, async (request) => {
      const supportedOpenAi = await request("/v1/responses", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "stavka/commander",
          input: "Hold",
          stream: false,
          tools: [],
          reasoning: { effort: "high" },
        }),
      });
      expect(supportedOpenAi.status).toBe(200);

      for (const body of [
        { model: "stavka/commander", input: "Hold", stream: true },
        { model: "stavka/commander", input: "Hold", tools: [{ type: "function" }] },
        { model: "stavka/commander", input: "Hold", max_output_tokens: 64 },
      ]) {
        const response = await request("/v1/responses", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        });
        expect(response.status).toBe(400);
        await expect(response.json()).resolves.toMatchObject({
          error: { code: "UNSUPPORTED_PARAMETER" },
        });
      }

      const supportedAnthropic = await request("/v1/messages", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "stavka/sergeant",
          max_tokens: 64,
          messages: [{ role: "user", content: "Hold" }],
          stream: false,
          tools: [],
          stop_sequences: [],
        }),
      });
      expect(supportedAnthropic.status).toBe(200);

      for (const controls of [
        { temperature: 0.2 },
        { stop_sequences: ["STOP"] },
      ]) {
        const response = await request("/v1/messages", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            model: "stavka/sergeant",
            max_tokens: 64,
            messages: [{ role: "user", content: "Hold" }],
            ...controls,
          }),
        });
        expect(response.status).toBe(400);
        await expect(response.json()).resolves.toMatchObject({
          error: { code: "UNSUPPORTED_PARAMETER" },
        });
      }
    });
  });

  it("keeps validation, size, and not-found failures in the JSON error envelope", async () => {
    const config = baseConfig();
    const service = await Effect.runPromise(makeService(config));
    await withWebApp({ config, service, assets: noAssets }, async (request) => {
      const malformed = await request("/v1/responses", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{not-json",
      });
      expect(malformed.status).toBe(400);
      expect(await malformed.json()).toMatchObject({
        error: { type: "maskirovka_error", code: "INVALID_JSON" },
      });
      expect(malformed.headers.get("x-request-id")).toBeTruthy();

      const oversized = await request("/v1/responses", {
        method: "POST",
        headers: {
          "content-length": "2000001",
          "content-type": "application/json",
        },
        body: JSON.stringify(openAiBody()),
      });
      expect(oversized.status).toBe(413);
      expect(await oversized.json()).toMatchObject({
        error: { code: "PAYLOAD_TOO_LARGE" },
      });

      const missing = await request("/missing");
      expect(missing.status).toBe(404);
      expect(await missing.json()).toMatchObject({ error: { code: "NOT_FOUND" } });

      const openApi = await request("/openapi.json");
      expect(openApi.status).toBe(200);
      expect(await openApi.json()).toMatchObject({
        paths: {
          "/v1/responses": expect.any(Object),
          "/v1/messages": expect.any(Object),
        },
      });
    });
  });

  it("returns available provider usage and resolved model in failure envelopes", async () => {
    const config = baseConfig();
    const failingAdapter: SeatAdapter = {
      id: "mock",
      invoke: () => Effect.fail(new GatewayError(
        502,
        "MOCK_PROVIDER_FAILURE",
        "provider failed",
        [],
        { inputTokens: 12, outputTokens: 3, actualCostUsd: 0.01 },
      )),
    };
    const service = await Effect.runPromise(makeService(config, { adapter: failingAdapter }));
    await withWebApp({ config, service, assets: noAssets }, async (request) => {
      const response = await request("/v1/responses", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(openAiBody()),
      });

      expect(response.status).toBe(502);
      await expect(response.json()).resolves.toMatchObject({
        error: {
          code: "MOCK_PROVIDER_FAILURE",
          resolved_model: "gpt-5.6-sol",
          usage: {
            input_tokens: 12,
            output_tokens: 3,
            estimated_cost_usd: 0.01,
          },
        },
      });
    });
  });

  it("serves the Access-protected dashboard as a router-managed SPA", async () => {
    const config = baseConfig();
    const service = await Effect.runPromise(makeService(config));
    const index = new TextEncoder().encode("<main>maskirovka</main>");
    await withWebApp({
      config,
      service,
      assets: {
        read: (path) => Effect.succeed(path === "index.html"
          ? { content: index, contentType: "text/html; charset=utf-8" }
          : undefined),
      },
    }, async (request) => {
      const redirect = await request("/_", { redirect: "manual" });
      expect(redirect.status).toBe(308);
      expect(redirect.headers.get("location")).toBe("/_/");

      const nested = await request("/_/missing/client-route");
      expect(nested.status).toBe(200);
      expect(await nested.text()).toBe("<main>maskirovka</main>");
      expect(nested.headers.get("cache-control")).toBe("no-cache");
    });
  });

  it("refuses local synthetic dashboard identity on a public URL", async () => {
    const config = baseConfig();
    const service = await Effect.runPromise(makeService(config));
    await withWebApp({ config, service, assets: noAssets }, async (request) => {
      const response = await request("https://maskirovka.example.test/_/");
      expect(response.status).toBe(401);
    });
  });

  it("persists dashboard remaps and kill-switch state through the registry repository", async () => {
    const config = baseConfig();
    const repository = new MemoryGatewayConfigRepository();
    const registry = new SeatRegistry(
      config.aliases,
      config.seats,
      repository,
      config.apiFallbackAliases,
    );
    const service = new GatewayService(
      config,
      registry,
      new MemoryCacheRepository(),
      new MemoryRequestLogRepository(),
      [new MockSeat()],
    );
    await Effect.runPromise(service.initialize());
    await withWebApp({ config, service, assets: noAssets }, async (request) => {
      const remap = await request("/admin/aliases/stavka%2Fheavy", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ seat: "mock", model: "mock-heavy" }),
      });
      expect(remap.status).toBe(200);
      expect(repository.value?.aliases).toContainEqual({
        tier: "stavka/heavy",
        seat: "mock",
        model: "mock-heavy",
      });

      expect((await request("/admin/kill-switch", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ enabled: true }),
      })).status).toBe(200);
      expect(repository.value?.killed).toBe(true);
      expect((await request("/v1/responses", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(openAiBody()),
      })).status).toBe(503);
    });
  });
});

describe("record and replay", () => {
  it("records once, replays canonically, and never invokes a seat on replay", async () => {
    const cache = new MemoryCacheRepository();
    let calls = 0;
    const adapter: SeatAdapter = {
      id: "mock",
      invoke: (): Effect.Effect<SeatResult> => Effect.sync(() => {
        calls += 1;
        return { text: "fixed", usage: { inputTokens: 2, outputTokens: 1 } };
      }),
    };
    const record = await Effect.runPromise(makeService(baseConfig("record"), { cache, adapter }));
    const first = normalizeRequest("openai-responses", openAiBody());
    const reordered = normalizeRequest("openai-responses", {
      input: "Hold position",
      text: openAiBody().text,
      instructions: "Return a structured decision.",
      model: "stavka/commander",
    });
    const recorded = await Effect.runPromise(record.run(first));
    const recordHit = await Effect.runPromise(record.run(reordered));
    expect(calls).toBe(1);
    expect(recordHit.metadata.cacheHit).toBe(true);

    const replayAdapter: SeatAdapter = {
      id: "mock",
      invoke: () => Effect.die(new Error("replay invoked a seat")),
    };
    const replay = await Effect.runPromise(makeService(baseConfig("replay"), {
      cache,
      adapter: replayAdapter,
    }));
    const replayed = await Effect.runPromise(replay.run(first));
    expect(replayed.body).toEqual(recorded.body);
    expect(replayed.metadata.cacheHit).toBe(true);
    expect(replayed.metadata.seat).toBe(recorded.metadata.seat);
    expect(replayed.metadata.model).toBe(recorded.metadata.model);

    await expect(Effect.runPromise(replay.run(
      normalizeRequest("openai-responses", openAiBody("novel prompt")),
    ))).rejects.toMatchObject({ code: "REPLAY_MISS" });
  });

  it("bypasses cache in live mode", async () => {
    let calls = 0;
    const adapter: SeatAdapter = {
      id: "mock",
      invoke: (_request: SeatInvocation) => Effect.sync(() => ({
        text: String(++calls),
        usage: { inputTokens: 1, outputTokens: 1 },
      })),
    };
    const service = await Effect.runPromise(makeService(baseConfig("live"), { adapter }));
    const request = normalizeRequest("openai-responses", openAiBody());
    await Effect.runPromise(service.run(request));
    await Effect.runPromise(service.run(request));
    expect(calls).toBe(2);
  });
});

describe("seat budgets and routing", () => {
  const meteredAdapter: SeatAdapter = {
    id: "api",
    invoke: () => Effect.succeed({
      text: "metered fallback",
      usage: { inputTokens: 10, outputTokens: 5, actualCostUsd: 0.001 },
    }),
  };
  const costlyMock: SeatAdapter = {
    id: "mock",
    invoke: () => Effect.succeed({
      text: "subscription result",
      usage: { inputTokens: 1_000, outputTokens: 1_000, planCreditUsd: 0.035 },
    }),
  };

  it("accounts subscription plan credit separately from metered cash", async () => {
    const base = baseConfig();
    const config: MaskirovkaConfig = {
      ...base,
      claudeMonthlyCreditUsd: 1,
      aliases: base.aliases.map((alias) => alias.tier === "stavka/commander"
        ? { ...alias, seat: "claude" as const, model: "claude-fable-5" }
        : alias),
      seats: base.seats.map((seat) => seat.id === "claude"
        ? { ...seat, status: "healthy" as const, monthlyBudgetUsd: 1 }
        : seat),
    };
    const subscription: SeatAdapter = {
      id: "claude",
      invoke: () => Effect.succeed({
        text: "subscription result",
        usage: {
          inputTokens: 1_000,
          outputTokens: 100,
          planCreditUsd: 0.25,
        },
      }),
    };
    const service = await Effect.runPromise(makeService(config, { adapter: subscription }));
    const response = await Effect.runPromise(service.run(
      normalizeRequest("openai-responses", openAiBody()),
    ));
    expect(response.metadata).toMatchObject({
      seat: "claude",
      actualCostUsd: 0,
      planCreditUsd: 0.25,
      apiListCostUsd: expect.any(Number),
    });
    const health = await Effect.runPromise(service.health());
    expect(health.savings).toMatchObject({
      actualCostUsd: 0,
      planCreditUsd: 0.25,
      savedVsApiUsd: expect.any(Number),
    });
  });

  const budgetedConfig = (policy: "fallback" | "stretch"): MaskirovkaConfig => {
    const config = baseConfig();
    return {
      ...config,
      budgetPolicy: policy,
      seats: config.seats.map((seat) => seat.id === "mock"
        ? { ...seat, monthlyBudgetUsd: 0.000_001 }
        : seat.id === "api"
          ? { ...seat, status: "healthy" as const }
          : seat),
    };
  };

  it("marks exhausted seats and routes the next request to metered API", async () => {
    const config = budgetedConfig("fallback");
    const service = await Effect.runPromise(makeService(config, {
      adapters: [costlyMock, meteredAdapter],
    }));
    const request = normalizeRequest("openai-responses", openAiBody());
    const first = await Effect.runPromise(service.run(request));
    const second = await Effect.runPromise(service.run(request));
    expect(first.metadata.seat).toBe("mock");
    expect(second.metadata).toMatchObject({
      seat: "api",
      fallbackFromSeat: "mock",
      routingReason: "budget-fallback",
    });
    const health = await Effect.runPromise(service.health());
    expect(health.seats.find((seat) => seat.id === "mock")).toMatchObject({
      status: "exhausted",
      budgetUsedUsd: expect.any(Number),
    });
  });

  it("returns a typed 429 when the operator selects stretch", async () => {
    const config = budgetedConfig("stretch");
    const service = await Effect.runPromise(makeService(config, {
      adapters: [costlyMock, meteredAdapter],
    }));
    const request = normalizeRequest("openai-responses", openAiBody());
    await Effect.runPromise(service.run(request));
    await expect(Effect.runPromise(service.run(request))).rejects.toMatchObject({
      status: 429,
      code: "SEAT_BUDGET_EXHAUSTED",
    });
  });

  it("fails over once when a healthy primary seat has a retryable failure", async () => {
    const config = budgetedConfig("fallback");
    let primaryCalls = 0;
    const failingPrimary: SeatAdapter = {
      id: "mock",
      invoke: () => Effect.sync(() => { primaryCalls += 1; }).pipe(
        Effect.andThen(Effect.fail(
          new GatewayError(502, "MOCK_TRANSIENT", "temporary seat failure"),
        )),
      ),
    };
    const service = await Effect.runPromise(makeService(config, {
      adapters: [failingPrimary, meteredAdapter],
    }));
    const response = await Effect.runPromise(service.run(
      normalizeRequest("openai-responses", openAiBody()),
    ));
    expect(primaryCalls).toBe(1);
    expect(response.metadata).toMatchObject({
      seat: "api",
      fallbackFromSeat: "mock",
      routingReason: "retry-fallback",
    });
  });

  it("consumes reported usage for failed provider attempts without persisting secrets", async () => {
    const base = baseConfig();
    const config: MaskirovkaConfig = {
      ...base,
      aliases: base.aliases.map((alias) => alias.tier === "stavka/commander"
        ? { ...alias, seat: "claude" as const, model: "claude-fable-5" }
        : alias),
      seats: base.seats.map((seat) => seat.id === "claude"
        ? { ...seat, status: "healthy" as const, monthlyBudgetUsd: 1 }
        : seat),
    };
    const repository = new MemoryWindowTrackerRepository();
    const tracker = new WindowTracker({
      claudeMonthlyCreditUsd: 1,
      codexWindowCalls: 0,
      codexWindowTokens: 0,
      codexWindowMs: 5 * 60 * 60 * 1_000,
    }, repository);
    const failingSeat: SeatAdapter = {
      id: "claude",
      invoke: () => Effect.fail(new GatewayError(
        502,
        "CLAUDE_SEAT_FAILURE",
        "provider rejected secret-provider-payload",
        [],
        { inputTokens: 90, outputTokens: 10, planCreditUsd: 0.2 },
      )),
    };
    const service = await Effect.runPromise(makeService(config, {
      adapter: failingSeat,
      tracker,
    }));
    await expect(Effect.runPromise(service.run(
      normalizeRequest("openai-responses", openAiBody("secret-user-prompt")),
    ))).rejects.toMatchObject({
      code: "CLAUDE_SEAT_FAILURE",
      resolvedModel: "claude-fable-5",
      providerUsage: { inputTokens: 90, outputTokens: 10, planCreditUsd: 0.2 },
    });
    expect(tracker.snapshot()).toMatchObject({
      requests: 1,
      inputTokens: 90,
      outputTokens: 10,
      planCreditUsd: 0.2,
    });
    expect(repository.value?.entries).toContainEqual(expect.objectContaining({
      seat: "claude",
      outcome: "failure",
      failureCode: "CLAUDE_SEAT_FAILURE",
      tokens: 100,
    }));
    const persisted = JSON.stringify(repository.value);
    expect(persisted).not.toContain("secret-provider-payload");
    expect(persisted).not.toContain("secret-user-prompt");
  });

  it("does not route to unchecked seats", async () => {
    const config = baseConfig();
    const registry = new SeatRegistry(
      [{ tier: "stavka/commander", seat: "codex", model: "codex-model" }],
      config.seats,
      new MemoryGatewayConfigRepository(),
      config.apiFallbackAliases,
    );
    await Effect.runPromise(registry.initialize());
    await expect(Effect.runPromise(registry.resolve("stavka/commander"))).rejects.toMatchObject({
      code: "SEAT_UNAVAILABLE",
    });
  });

  it("chooses healthy tier candidates in descending priority", async () => {
    const config = baseConfig();
    const healthySeats = config.seats.map((seat) =>
      seat.id === "claude" || seat.id === "codex"
        ? { ...seat, status: "healthy" as const }
        : seat);
    const registry = new SeatRegistry(
      [
        { tier: "stavka/commander", seat: "claude", model: "claude-model" },
        { tier: "stavka/commander", seat: "codex", model: "codex-model" },
      ],
      healthySeats,
      new MemoryGatewayConfigRepository(),
      config.apiFallbackAliases,
    );
    await Effect.runPromise(registry.initialize());
    await expect(Effect.runPromise(registry.resolve("stavka/commander"))).resolves.toMatchObject({
      seat: "codex",
      model: "codex-model",
    });
  });
});

describe("Commander Effect AI compatibility", () => {
  it("decodes Maskirovka mock output through both Effect AI provider layers", async () => {
    const config = { ...baseConfig("live"), port: 0 };
    const service = await Effect.runPromise(makeService(config));
    const program = Effect.scoped(Effect.gen(function*() {
      const server = yield* startServer(config, service);
      const address = server.address();
      if (!address || typeof address === "string") {
        return yield* Effect.die(new Error("Expected TCP server address"));
      }
      const shared = {
        commanderModel: "stavka/commander" as const,
        sergeantModel: "stavka/sergeant" as const,
        heavyModel: "stavka/heavy" as const,
        decisionIntervalSeconds: 45,
        doctrine: "balanced" as const,
        maxActiveUnits: 50,
        difficulty: 0.5,
        playerScaling: true,
        tickIdleMs: 2_000,
        tickActiveMs: 750,
        tickBurstMs: 300,
        aiBaseUrl: `http://127.0.0.1:${address.port}`,
        seatExhaustionPolicy: "fallback" as const,
        seatStretchMultiplier: 4,
        seatHeartbeatTtlSeconds: 45,
        seatJobTimeoutSeconds: 30,
        seatKeys: {},
      };
      const decision = yield* runAiDecision({ ...shared, aiProvider: "openai" }, {
        model: "stavka/commander",
        prompt: "Hold position.",
      });
      expect(decision.decision.commands).toEqual([]);
      expect(decision.decision.summary).toMatch(/^mock-/u);

      const anthropicDecision = yield* runAiDecision({ ...shared, aiProvider: "anthropic" }, {
        model: "stavka/commander",
        prompt: "Hold position.",
      });
      expect(anthropicDecision.decision.commands).toEqual([]);
      expect(anthropicDecision.decision.summary).toMatch(/^mock-/u);
    }));
    // The Commander integration currently exposes an overly broad `unknown`
    // requirement even though both provider layers are fully supplied.
    await Effect.runPromise(program as Effect.Effect<void, unknown>);
  });
});

it("uses typed errors for replay misses", () => {
  expect(new GatewayError(409, "REPLAY_MISS", "missing")).toMatchObject({
    status: 409,
    code: "REPLAY_MISS",
  });
});
