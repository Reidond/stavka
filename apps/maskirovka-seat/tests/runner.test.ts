import { Effect, Schema } from "effect";
import { afterEach, describe, expect, it } from "vitest";

import { type ClaudeResultQuery, LiveSeatRunner } from "../src/container/runner";
import { SeatInvocationGovernor } from "../src/seat-invocation-governor";

const originalEnvironment = { ...process.env };

afterEach(() => {
  for (const name of Object.keys(process.env)) delete process.env[name];
  Object.assign(process.env, originalEnvironment);
});

const CommanderDecision = Schema.Struct({
  summary: Schema.String,
  commands: Schema.Array(Schema.Unknown),
});

describe("hosted Claude seat runner", () => {
  it("passes Commander JSON Schema to the Agent SDK and returns parseable structured text", async () => {
    const decision = { summary: "Hold position", commands: [] };
    const decisionSchema = {
      type: "object",
      properties: {
        summary: { type: "string" },
        commands: { type: "array", items: { type: "object" } },
      },
      required: ["summary", "commands"],
      additionalProperties: false,
    };
    let sdkRequest: Parameters<ClaudeResultQuery>[0] | undefined;
    const fakeClaudeResults: ClaudeResultQuery = async function* (request) {
      sdkRequest = request;
      yield {
        subtype: "success",
        result: "ignored unstructured fallback",
        structured_output: decision,
        stop_reason: "end_turn",
        usage: { input_tokens: 12, output_tokens: 5 },
        uuid: "00000000-0000-4000-8000-000000000001",
      };
    };
    process.env.CLAUDE_CODE_OAUTH_TOKEN = "subscription-token";
    const runner = new LiveSeatRunner("claude", fakeClaudeResults);

    const response = await Effect.runPromise(
      runner.runMessages({
        model: "claude-fable-5",
        max_tokens: 512,
        messages: [{ role: "user", content: "Issue orders" }],
        output_config: {
          format: { type: "json_schema", schema: decisionSchema },
        },
      }),
    );

    expect(sdkRequest?.options?.outputFormat).toEqual({
      type: "json_schema",
      schema: decisionSchema,
    });
    expect(sdkRequest?.options?.taskBudget).toEqual({ total: 512 });
    const content = response.content[0];
    expect(content?.type).toBe("text");
    const parsed = JSON.parse(content?.text ?? "") as unknown;
    expect(Schema.decodeUnknownSync(CommanderDecision)(parsed)).toEqual(decision);
    expect(response.usage).toEqual({ input_tokens: 12, output_tokens: 5 });
  });

  it("times out and cancels a hung provider before releasing the only lane", async () => {
    let aborted = false;
    const hungClaudeResults: ClaudeResultQuery = async function* (request) {
      await new Promise<void>((resolve) => {
        const signal = request.options?.abortController?.signal;
        if (signal?.aborted) {
          aborted = true;
          resolve();
          return;
        }
        signal?.addEventListener(
          "abort",
          () => {
            aborted = true;
            resolve();
          },
          { once: true },
        );
      });
      yield* [];
    };
    process.env.CLAUDE_CODE_OAUTH_TOKEN = "subscription-token";
    const runner = new LiveSeatRunner("claude", hungClaudeResults, 10);
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
    expect(aborted).toBe(true);
    await expect(Effect.runPromise(governor.run(Effect.succeed("next")))).resolves.toBe("next");
    await expect(Effect.runPromise(governor.snapshot)).resolves.toMatchObject({
      active: 0,
      queueDepth: 0,
    });
  });

  it("classifies provider rate limits as retryable", async () => {
    const rateLimited: ClaudeResultQuery = async function* () {
      yield* [];
      throw Object.assign(new Error("plan window exhausted"), { status: 429 });
    };
    process.env.CLAUDE_CODE_OAUTH_TOKEN = "subscription-token";
    const runner = new LiveSeatRunner("claude", rateLimited);

    await expect(
      Effect.runPromise(
        runner.runMessages({
          model: "claude-fable-5",
          max_tokens: 64,
          messages: [{ role: "user", content: "Orders" }],
        }),
      ),
    ).rejects.toMatchObject({
      reason: "rate_limit",
      status: 429,
      retryable: true,
    });
  });

  it("retains provider usage and resolved model on failed results", async () => {
    const failedWithUsage: ClaudeResultQuery = async function* () {
      yield {
        subtype: "error_during_execution",
        errors: ["provider execution failed"],
        total_cost_usd: 0.012,
        usage: {
          input_tokens: 21,
          output_tokens: 4,
          cache_read_input_tokens: 3,
        },
      };
    };
    process.env.CLAUDE_CODE_OAUTH_TOKEN = "subscription-token";
    const runner = new LiveSeatRunner("claude", failedWithUsage);

    await expect(
      Effect.runPromise(
        runner.runMessages({
          model: "claude-fable-5",
          max_tokens: 64,
          messages: [{ role: "user", content: "Orders" }],
        }),
      ),
    ).rejects.toMatchObject({
      resolvedModel: "claude-fable-5",
      usage: {
        inputTokens: 21,
        outputTokens: 4,
        cachedInputTokens: 3,
        estimatedCostUsd: 0.012,
      },
    });
  });
});
