import { ModelProviderError, type ModelProvider } from "@stavka/model-provider";
import { Effect, Schema } from "effect";
import { describe, expect, it } from "vitest";

import { LiveSeatRunner } from "../src/container/runner";
import { SeatInvocationGovernor } from "../src/seat-invocation-governor";

const CommanderDecision = Schema.Struct({
  summary: Schema.String,
  commands: Schema.Array(Schema.Unknown),
});

const provider = (complete: ModelProvider["complete"]): ModelProvider => ({
  id: "claude",
  capabilities: {
    streaming: true,
    structuredOutput: true,
    toolCalling: false,
    agentRuntime: true,
    subscriptionBilling: true,
    serverSafeAuth: false,
  },
  complete,
  stream: (request) => complete(request),
});

describe("hosted Claude seat runner", () => {
  it("passes JSON Schema through the shared provider and returns structured text", async () => {
    const decision = { summary: "Hold position", commands: [] };
    let receivedSchema: Readonly<Record<string, unknown>> | undefined;
    const modelProvider = provider((request) => {
      receivedSchema = request.outputSchema;
      return Effect.succeed({
        text: JSON.stringify(decision),
        structured: decision,
        toolCalls: [],
        metadata: {
          provider: "claude",
          requestedModel: request.model,
          resolvedModel: "claude-fable-5",
          billingMode: "subscription",
          latencyMs: 10,
          retryCount: 0,
          usage: { inputTokens: 12, outputTokens: 5 },
          transport: "agent-runtime",
        },
      });
    });
    const runner = new LiveSeatRunner("claude", () => Effect.succeed(modelProvider));
    const schema = {
      type: "object",
      properties: {
        summary: { type: "string" },
        commands: { type: "array", items: { type: "object" } },
      },
      required: ["summary", "commands"],
      additionalProperties: false,
    };

    const response = await Effect.runPromise(
      runner.runMessages({
        model: "claude-fable-5",
        max_tokens: 512,
        messages: [{ role: "user", content: "Issue orders" }],
        output_config: { format: { type: "json_schema", schema } },
      }),
    );

    expect(receivedSchema).toEqual(schema);
    const content = response.content[0];
    expect(Schema.decodeUnknownSync(CommanderDecision)(JSON.parse(content?.text ?? ""))).toEqual(
      decision,
    );
    expect(response.usage).toEqual({ input_tokens: 12, output_tokens: 5 });
  });

  it("times out a hung provider before releasing the only lane", async () => {
    const hung = provider(() => Effect.never);
    const runner = new LiveSeatRunner("claude", () => Effect.succeed(hung), 10);
    const governor = new SeatInvocationGovernor(1, 1);
    const request = {
      model: "claude-fable-5",
      max_tokens: 64,
      messages: [{ role: "user" as const, content: "Wait forever" }],
    };

    await expect(
      Effect.runPromise(governor.run(runner.runMessages(request))),
    ).rejects.toMatchObject({
      reason: "timeout",
      status: 504,
      retryable: true,
    });
    await expect(Effect.runPromise(governor.run(Effect.succeed("next")))).resolves.toBe("next");
  });

  it("classifies provider rate limits as retryable", async () => {
    const limited = provider(() =>
      Effect.fail(
        new ModelProviderError({
          provider: "claude",
          kind: "rate_limit",
          message: "plan window exhausted",
          status: 429,
        }),
      ),
    );
    const runner = new LiveSeatRunner("claude", () => Effect.succeed(limited));
    await expect(
      Effect.runPromise(
        runner.runMessages({
          model: "claude-fable-5",
          max_tokens: 64,
          messages: [{ role: "user", content: "Orders" }],
        }),
      ),
    ).rejects.toMatchObject({ reason: "rate_limit", status: 429, retryable: true });
  });
});
