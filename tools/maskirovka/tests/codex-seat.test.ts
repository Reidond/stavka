import type { ModelProvider, ModelRequest } from "@stavka/model-provider";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import type { SeatInvocation } from "../src/domain/types";
import { CodexSeat } from "../src/seats/codex-seat";

const invocation = (prompt: string): SeatInvocation => ({
  dialect: "openai-responses",
  tier: "stavka/commander",
  request: { model: "stavka/commander", input: prompt, reasoning: { effort: "high" } },
  prompt,
  model: "gpt-5.6-sol",
});

describe("Codex subscription seat isolation", () => {
  it("issues one stateless provider request for every independent invocation", async () => {
    const requests: ModelRequest[] = [];
    const provider: ModelProvider = {
      id: "codex",
      capabilities: {
        streaming: true,
        structuredOutput: true,
        toolCalling: true,
        agentRuntime: false,
        subscriptionBilling: true,
        serverSafeAuth: true,
      },
      complete: (request) => {
        requests.push(request);
        return Effect.succeed({
          text: `response-${requests.length}`,
          toolCalls: [],
          metadata: {
            provider: "codex",
            requestedModel: request.model,
            resolvedModel: request.model,
            billingMode: "subscription",
            latencyMs: 1,
            retryCount: 0,
            transport: "worker-direct",
          },
        });
      },
      stream: (request) => provider.complete(request),
    };
    const seat = new CodexSeat(provider);

    const first = await Effect.runPromise(seat.invoke(invocation("first independent request")));
    const second = await Effect.runPromise(seat.invoke(invocation("second independent request")));

    expect(first.text).toBe("response-1");
    expect(second.text).toBe("response-2");
    expect(requests).toHaveLength(2);
    expect(requests[0]).toMatchObject({
      input: "first independent request",
      reasoningEffort: "high",
    });
    expect(requests[1]).toMatchObject({
      input: "second independent request",
      reasoningEffort: "high",
    });
  });
});
