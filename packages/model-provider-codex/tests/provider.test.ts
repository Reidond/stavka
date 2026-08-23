import { Effect } from "effect";
import { describe, expect, it, vi } from "vitest";

import { CodexProvider } from "../src/provider";

const credential = {
  kind: "codex-chatgpt-oauth" as const,
  accessToken: "access-secret",
  refreshToken: "refresh-secret",
  expiresAt: Date.now() + 60_000,
  accountId: "account-1",
};

const sseResponse = (...events: readonly unknown[]): Response =>
  new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), {
    headers: { "content-type": "text/event-stream", "x-request-id": "request-header" },
  });

describe("CodexProvider", () => {
  it("uses the direct ChatGPT Responses transport and preserves metadata", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      sseResponse(
        { type: "response.output_text.delta", delta: '{"ok":' },
        { type: "response.output_text.delta", delta: "true}" },
        {
          type: "response.completed",
          response: {
            id: "response-1",
            model: "gpt-5.6-sol",
            usage: {
              input_tokens: 10,
              output_tokens: 3,
              input_tokens_details: { cached_tokens: 4 },
              output_tokens_details: { reasoning_tokens: 2 },
            },
          },
        },
      ),
    );
    const provider = new CodexProvider({
      credential,
      fetcher,
      endpoint: "https://example.test/responses",
    });
    const events: string[] = [];

    const completion = await Effect.runPromise(
      provider.stream(
        {
          model: "gpt-5.6-sol",
          input: "Return JSON",
          outputSchema: { type: "object", properties: { ok: { type: "boolean" } } },
        },
        (event) => events.push(event.type),
      ),
    );

    expect(completion).toMatchObject({
      text: '{"ok":true}',
      structured: { ok: true },
      metadata: {
        provider: "codex",
        billingMode: "subscription",
        resolvedModel: "gpt-5.6-sol",
        providerRequestId: "request-header",
        usage: { inputTokens: 10, outputTokens: 3, cachedInputTokens: 4, reasoningTokens: 2 },
      },
    });
    expect(events).toEqual([
      "response.started",
      "output.delta",
      "output.delta",
      "response.completed",
    ]);
    const request = fetcher.mock.calls[0]?.[1];
    expect(new Headers(request?.headers).get("authorization")).toBe("Bearer access-secret");
    expect(new Headers(request?.headers).get("chatgpt-account-id")).toBe("account-1");
    expect(new Headers(request?.headers).get("originator")).toBe("Codex Stavka");
    expect(new Headers(request?.headers).get("version")).toBe("1.0.0");
    expect(new Headers(request?.headers).get("openai-beta")).toBe("responses=experimental");
    expect(new Headers(request?.headers).get("session_id")).toBeTruthy();
    expect(new Headers(request?.headers).get("x-client-request-id")).toBeTruthy();
    expect(JSON.parse(String(request?.body))).toMatchObject({
      store: false,
      stream: true,
      model: "gpt-5.6-sol",
    });
  });

  it("rejects unsupported output-token caps before network execution", async () => {
    const fetcher = vi.fn<typeof fetch>();
    const provider = new CodexProvider({ credential, fetcher });

    await expect(
      Effect.runPromise(provider.complete({ model: "gpt", input: "hello", maxOutputTokens: 32 })),
    ).rejects.toMatchObject({ kind: "invalid_request" });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("classifies auth failures without exposing bearer credentials", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      new Response("Bearer eyJsecretsecretsecret was rejected", {
        status: 401,
        headers: { "content-type": "application/json" },
      }),
    );
    const provider = new CodexProvider({ credential, fetcher });

    await expect(
      Effect.runPromise(provider.complete({ model: "gpt", input: "hello" })),
    ).rejects.toMatchObject({
      kind: "auth",
      status: 401,
      message: expect.not.stringContaining("eyJsecret"),
    });
  });

  it("rejects incomplete streams and keeps timeouts global across retries", async () => {
    const incomplete = new CodexProvider({
      credential,
      fetcher: vi
        .fn<typeof fetch>()
        .mockResolvedValue(sseResponse({ type: "response.incomplete", response: {} })),
    });
    await expect(
      Effect.runPromise(incomplete.complete({ model: "gpt", input: "hello" })),
    ).rejects.toMatchObject({ kind: "provider", message: "Codex response was incomplete" });

    const truncated = new CodexProvider({
      credential,
      fetcher: vi
        .fn<typeof fetch>()
        .mockResolvedValue(sseResponse({ type: "response.output_text.delta", delta: "partial" })),
    });
    await expect(
      Effect.runPromise(truncated.complete({ model: "gpt", input: "hello" })),
    ).rejects.toMatchObject({
      kind: "protocol",
      message: "Codex stream ended without a completion event",
    });

    const retryingFetch = vi
      .fn<typeof fetch>()
      .mockImplementation(async () => new Response("busy", { status: 503 }));
    const retrying = new CodexProvider({ credential, fetcher: retryingFetch });
    await expect(
      Effect.runPromise(
        retrying.complete({
          model: "gpt",
          input: "hello",
          maxRetries: 2,
          firstEventTimeoutMs: 20,
          totalTimeoutMs: 20,
        }),
      ),
    ).rejects.toMatchObject({ kind: "timeout" });
    expect(retryingFetch.mock.calls.length).toBeLessThan(3);
  });
});
