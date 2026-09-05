import { Effect } from "effect";
import { describe, expect, it, vi } from "vitest";

import {
  ClaudeAgentProvider,
  ClaudeApiProvider,
  sanitizeClaudeSubscriptionEnvironment,
} from "../src/provider";

const sdk = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock("@anthropic-ai/claude-agent-sdk", () => ({ query: sdk.query }));

describe("Claude providers", () => {
  it("passes a small output cap through the SDK output limit without creating a task budget", async () => {
    sdk.query.mockClear();
    sdk.query.mockReturnValue(
      (async function* () {
        yield {
          type: "result",
          subtype: "success",
          is_error: false,
          result: "STAVKA_READY",
          uuid: "test-result",
          modelUsage: { "claude-fable-5": { canonicalModel: "claude-fable-5" } },
          usage: { input_tokens: 12, output_tokens: 4 },
          total_cost_usd: 0,
        };
      })(),
    );
    const provider = new ClaudeAgentProvider({
      credential: { kind: "claude-subscription", oauthToken: `sk-ant-oat01-${"x".repeat(24)}` },
      environment: { CLAUDE_CODE_MAX_OUTPUT_TOKENS: "99999" },
    });
    const response = await Effect.runPromise(
      provider.complete({ model: "claude-fable-5", input: "ready", maxOutputTokens: 64 }),
    );
    expect(response.text).toBe("STAVKA_READY");
    expect(sdk.query.mock.calls[0]?.[0].options.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS).toBe("64");
    expect(sdk.query.mock.calls[0]?.[0].options).not.toHaveProperty("taskBudget");
  });

  it("rejects a setup transcript before starting the SDK without echoing it", async () => {
    sdk.query.mockClear();
    const provider = new ClaudeAgentProvider({
      credential: {
        kind: "claude-subscription",
        oauthToken: "Welcome to setup\nsecret-terminal-output",
      },
    });
    await expect(
      Effect.runPromise(provider.complete({ model: "claude-fable-5", input: "ready" })),
    ).rejects.toMatchObject({
      kind: "auth",
      message:
        "Claude subscription credential is malformed. Reconnect with only the setup-token value.",
    });
    expect(sdk.query).not.toHaveBeenCalled();
  });

  it("treats an SDK success envelope with is_error as a redacted failure", async () => {
    const token = `sk-ant-oat01-${"x".repeat(24)}`;
    sdk.query.mockReturnValue(
      (async function* () {
        yield {
          type: "result",
          subtype: "success",
          is_error: true,
          result: `API Error: invalid Authorization Bearer ${token}`,
        };
      })(),
    );
    const provider = new ClaudeAgentProvider({
      credential: { kind: "claude-subscription", oauthToken: token },
    });
    await expect(
      Effect.runPromise(provider.complete({ model: "claude-fable-5", input: "ready" })),
    ).rejects.toMatchObject({
      kind: "auth",
      message: "API Error: invalid Authorization Bearer [redacted]",
    });
  });
  it("isolates subscription auth from metered provider credentials", () => {
    expect(
      sanitizeClaudeSubscriptionEnvironment(
        {
          PATH: "/bin",
          ANTHROPIC_API_KEY: "metered",
          OPENAI_API_KEY: "openai",
          CODEX_API_KEY: "codex",
          CLAUDE_CODE_OAUTH_TOKEN: "old",
          MASKIROVKA_GATEWAY_KEY: "gateway-secret",
          STAVKA_PROVIDER_ACCOUNT_B64: "account-secret",
          STAVKA_PROVIDER_VAULT_KEY: "vault-secret",
        },
        "subscription",
      ),
    ).toEqual({ PATH: "/bin", CLAUDE_CODE_OAUTH_TOKEN: "subscription" });
  });

  it("keeps direct Messages execution API-key only", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          id: "message-1",
          model: "claude-sonnet-4-5",
          content: [{ type: "text", text: "ready" }],
          usage: { input_tokens: 4, output_tokens: 1 },
        }),
        { headers: { "content-type": "application/json" } },
      ),
    );
    const provider = new ClaudeApiProvider({
      credential: { kind: "api-key", apiKey: "api-secret" },
      fetcher,
      endpoint: "https://example.test/messages",
    });

    const completion = await Effect.runPromise(
      provider.complete({ model: "claude-sonnet-4-5", input: "status" }),
    );
    expect(completion).toMatchObject({
      text: "ready",
      metadata: { billingMode: "metered", usage: { inputTokens: 4, outputTokens: 1 } },
    });
    expect(new Headers(fetcher.mock.calls[0]?.[1]?.headers).get("x-api-key")).toBe("api-secret");
  });

  it("enforces request timeouts for direct Messages calls", async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(
      (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener(
            "abort",
            () => reject(new DOMException("aborted", "AbortError")),
            { once: true },
          );
        }),
    );
    const provider = new ClaudeApiProvider({
      credential: { kind: "api-key", apiKey: "api-secret" },
      fetcher,
      endpoint: "https://example.test/messages",
    });

    await expect(
      Effect.runPromise(
        provider.complete({
          model: "claude-sonnet-4-5",
          input: "status",
          firstEventTimeoutMs: 5,
          totalTimeoutMs: 20,
        }),
      ),
    ).rejects.toMatchObject({ kind: "timeout", message: "Anthropic first_event timeout" });
  });
});
