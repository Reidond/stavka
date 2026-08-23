import { Effect } from "effect";
import { describe, expect, it, vi } from "vitest";

import { ClaudeApiProvider, sanitizeClaudeSubscriptionEnvironment } from "../src/provider";

describe("Claude providers", () => {
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
