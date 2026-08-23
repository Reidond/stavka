import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import {
  AUTH_CHECKPOINT_HEADER,
  AUTH_STATE_FINGERPRINT_HEADER,
  decodeAuthCheckpoint,
} from "../src/auth-checkpoint";
import { createContainerTestHandler, type ContainerAppDependencies } from "../src/container/app";
import { ProviderInvocationError, type SeatRunner } from "../src/container/runner";

const runner: SeatRunner = {
  runResponses: (request) =>
    Effect.succeed({
      id: "resp_test",
      object: "response",
      created_at: 1,
      status: "completed",
      error: null,
      incomplete_details: null,
      model: request.model,
      output: [
        {
          id: "msg_test",
          type: "message",
          status: "completed",
          role: "assistant",
          content: [{ type: "output_text", text: "Hold position", annotations: [] }],
        },
      ],
      output_text: "Hold position",
      usage: {
        input_tokens: 3,
        input_tokens_details: { cached_tokens: 0 },
        output_tokens: 2,
        output_tokens_details: { reasoning_tokens: 0 },
        total_tokens: 5,
      },
    }),
  runMessages: (request) =>
    Effect.succeed({
      id: "msg_test",
      type: "message",
      role: "assistant",
      model: request.model,
      content: [{ type: "text", text: "Advance" }],
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: { input_tokens: 4, output_tokens: 1 },
    }),
};

const baseFingerprint = "a".repeat(64);

const request = async (
  dependencies: ContainerAppDependencies,
  path: string,
  init?: RequestInit,
): Promise<Response> => {
  const app = createContainerTestHandler(dependencies);
  try {
    return await app.handler(new Request(`http://container.test${path}`, init));
  } finally {
    await app.dispose();
  }
};

describe("container Effect HttpApi gateway", () => {
  it("returns Responses-shaped output and an opaque auth checkpoint", async () => {
    const response = await request(
      {
        config: {
          seatId: "codex",
          provider: "codex",
          aliases: { "stavka/heavy": "gpt-5.6-terra" },
        },
        runner,
        authConfigured: Effect.succeed(true),
        authCheckpoint: (fingerprint) =>
          Effect.succeed(
            fingerprint === baseFingerprint
              ? {
                  version: 2,
                  provider: "codex",
                  credential: {
                    kind: "codex-chatgpt-oauth",
                    accessToken: "rotated",
                    refreshToken: "refresh",
                    expiresAt: 42,
                    accountId: "account-1",
                  },
                  base_fingerprint: baseFingerprint,
                  observed_at: 42,
                }
              : undefined,
          ),
      },
      "/v1/responses",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          [AUTH_STATE_FINGERPRINT_HEADER]: baseFingerprint,
        },
        body: JSON.stringify({ model: "gpt-5.6-terra", input: "Orders" }),
      },
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      object: "response",
      model: "gpt-5.6-terra",
      output_text: "Hold position",
    });
    const checkpoint = response.headers.get(AUTH_CHECKPOINT_HEADER);
    expect(checkpoint).not.toBeNull();
    expect(decodeAuthCheckpoint(checkpoint ?? "")).toEqual({
      version: 2,
      provider: "codex",
      credential: {
        kind: "codex-chatgpt-oauth",
        accessToken: "rotated",
        refreshToken: "refresh",
        expiresAt: 42,
        accountId: "account-1",
      },
      base_fingerprint: baseFingerprint,
      observed_at: 42,
    });
  });

  it("preserves Commander structured-output contracts through a fake Claude runner", async () => {
    const decision = { summary: "Advance", commands: [] };
    const decisionSchema = {
      type: "object",
      properties: {
        summary: { type: "string" },
        commands: { type: "array", items: { type: "object" } },
      },
      required: ["summary", "commands"],
      additionalProperties: false,
    };
    let received: Parameters<SeatRunner["runMessages"]>[0] | undefined;
    const structuredRunner: SeatRunner = {
      ...runner,
      runMessages: (request) => {
        received = request;
        return Effect.succeed({
          id: "msg_structured",
          type: "message",
          role: "assistant",
          model: request.model,
          content: [{ type: "text", text: JSON.stringify(decision) }],
          stop_reason: "end_turn",
          stop_sequence: null,
          usage: { input_tokens: 4, output_tokens: 1 },
        });
      },
    };
    const response = await request(
      {
        config: {
          seatId: "claude",
          provider: "claude",
          aliases: { "stavka/commander": "claude-opus-4-6" },
        },
        runner: structuredRunner,
        authConfigured: Effect.succeed(true),
        authCheckpoint: () => Effect.succeed(undefined),
      },
      "/v1/messages",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "claude-opus-4-6",
          max_tokens: 64,
          messages: [{ role: "user", content: "Orders" }],
          output_config: {
            format: { type: "json_schema", schema: decisionSchema },
          },
        }),
      },
    );

    expect(response.status).toBe(200);
    expect(received?.output_config?.format).toEqual({
      type: "json_schema",
      schema: decisionSchema,
    });
    const body = (await response.json()) as {
      readonly type: string;
      readonly role: string;
      readonly content: ReadonlyArray<{ readonly type: string; readonly text: string }>;
    };
    expect(body).toMatchObject({
      type: "message",
      role: "assistant",
    });
    expect(JSON.parse(body.content[0]?.text ?? "")).toEqual(decision);
  });

  it("keeps health local and reports missing injected credentials", async () => {
    const response = await request(
      {
        config: {
          seatId: "codex",
          provider: "codex",
          aliases: { "stavka/heavy": "gpt-5.6-terra" },
        },
        runner,
        authConfigured: Effect.succeed(false),
        authCheckpoint: () => Effect.succeed(undefined),
        now: () => 99,
      },
      "/healthz",
    );

    expect(response.status).toBe(503);
    expect(response.headers.has(AUTH_CHECKPOINT_HEADER)).toBe(false);
    await expect(response.json()).resolves.toMatchObject({ ok: false, now: 99 });
  });

  it("rejects accepted-looking controls that the subscription SDK cannot honor", async () => {
    const base = {
      config: {
        seatId: "codex",
        provider: "codex" as const,
        aliases: { "stavka/heavy": "gpt-5.6-terra" },
      },
      runner,
      authConfigured: Effect.succeed(true),
      authCheckpoint: () => Effect.succeed(undefined),
    };
    const response = await request(base, "/v1/responses", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "gpt-5.6-terra",
        input: "Orders",
        max_output_tokens: 64,
      }),
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "INVALID_REQUEST", param: "max_output_tokens" },
    });
  });

  it.each([
    ["rate_limit", 429, true],
    ["timeout", 504, true],
    ["auth", 503, false],
  ] as const)(
    "maps %s provider failures to truthful HTTP status",
    async (reason, status, retryable) => {
      const failingRunner: SeatRunner = {
        ...runner,
        runMessages: () =>
          Effect.fail(
            new ProviderInvocationError({
              provider: "claude",
              reason,
              status,
              retryable,
              message: "provider detail must not leak",
              ...(reason === "rate_limit"
                ? {
                    resolvedModel: "claude-fable-5",
                    usage: {
                      inputTokens: 12,
                      outputTokens: 3,
                      estimatedCostUsd: 0.01,
                    },
                  }
                : {}),
            }),
          ),
      };
      const response = await request(
        {
          config: {
            seatId: "claude",
            provider: "claude",
            aliases: { "stavka/commander": "claude-fable-5" },
          },
          runner: failingRunner,
          authConfigured: Effect.succeed(true),
          authCheckpoint: () => Effect.succeed(undefined),
        },
        "/v1/messages",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            model: "claude-fable-5",
            max_tokens: 64,
            messages: [{ role: "user", content: "Orders" }],
          }),
        },
      );

      expect(response.status).toBe(status);
      await expect(response.json()).resolves.toMatchObject({
        error: {
          retryable,
          ...(reason === "rate_limit"
            ? {
                resolved_model: "claude-fable-5",
                usage: {
                  input_tokens: 12,
                  output_tokens: 3,
                  estimated_cost_usd: 0.01,
                },
              }
            : {}),
        },
      });
    },
  );
});
