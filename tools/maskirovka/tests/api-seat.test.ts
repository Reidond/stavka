import { Effect } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";

import { normalizeRequest } from "../src/domain/protocol";
import { ApiSeat } from "../src/seats/api-seat";

afterEach(() => vi.unstubAllGlobals());

describe("metered API seat", () => {
  it("translates an OpenAI-shaped request to an Anthropic fallback model", async () => {
    const fetchMock = vi.fn(async (
      _input: string | URL | Request,
      _init?: RequestInit,
    ) => new Response(JSON.stringify({
      id: "msg_metered",
      type: "message",
      role: "assistant",
      model: "claude-sonnet-4-6",
      content: [{ type: "text", text: "{\"summary\":\"hold\",\"commands\":[]}" }],
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: { input_tokens: 12, output_tokens: 5 },
    }), { status: 200, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);
    const normalized = normalizeRequest("openai-responses", {
      model: "stavka/commander",
      input: "Hold position",
      text: {
        format: {
          type: "json_schema",
          schema: {
            type: "object",
            properties: {
              summary: { type: "string" },
              commands: { type: "array" },
            },
            required: ["summary", "commands"],
          },
        },
      },
    });
    const result = await Effect.runPromise(new ApiSeat(undefined, "anthropic-key").invoke({
      ...normalized,
      model: "claude-sonnet-4-6",
    }));

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://api.anthropic.com/v1/messages");
    expect(init?.headers).toMatchObject({ "x-api-key": "anthropic-key" });
    expect(JSON.parse(String(init?.body))).toMatchObject({
      model: "claude-sonnet-4-6",
      messages: [{ role: "user", content: "Hold position" }],
      output_config: { format: { type: "json_schema" } },
    });
    expect(result).toMatchObject({
      structured: { summary: "hold", commands: [] },
      usage: { inputTokens: 12, outputTokens: 5 },
    });
    expect(result.raw).toBeUndefined();
  });

  it("translates an Anthropic-shaped request to an OpenAI fallback model", async () => {
    const fetchMock = vi.fn(async (
      _input: string | URL | Request,
      _init?: RequestInit,
    ) => new Response(JSON.stringify({
      id: "resp_metered",
      object: "response",
      status: "completed",
      output_text: "{\"summary\":\"advance\",\"commands\":[]}",
      output: [],
      usage: { input_tokens: 9, output_tokens: 4 },
    }), { status: 200, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);
    const schema = {
      type: "object",
      properties: {
        summary: { type: "string" },
        commands: { type: "array" },
      },
      required: ["summary", "commands"],
    };
    const normalized = normalizeRequest("anthropic-messages", {
      model: "stavka/commander",
      max_tokens: 64,
      messages: [{ role: "user", content: "Advance" }],
      output_config: { format: { type: "json_schema", schema } },
    });
    const result = await Effect.runPromise(new ApiSeat("openai-key").invoke({
      ...normalized,
      model: "gpt-5.6-sol",
    }));

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://api.openai.com/v1/responses");
    expect(init?.headers).toMatchObject({ authorization: "Bearer openai-key" });
    expect(JSON.parse(String(init?.body))).toMatchObject({
      model: "gpt-5.6-sol",
      input: "user: Advance",
      text: { format: { type: "json_schema", schema } },
    });
    expect(result).toMatchObject({
      structured: { summary: "advance", commands: [] },
      usage: { inputTokens: 9, outputTokens: 4 },
    });
    expect(result.raw).toBeUndefined();
  });
});
