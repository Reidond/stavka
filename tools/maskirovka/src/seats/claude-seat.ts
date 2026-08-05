import { Effect } from "effect";

import { GatewayError, type SeatInvocation, type SeatResult } from "../domain/types";
import type { SeatAdapter } from "./seat-adapter";

const oauthEnvironment = (): NodeJS.ProcessEnv => ({
  ...process.env,
  ANTHROPIC_API_KEY: undefined,
});

export class ClaudeSeat implements SeatAdapter {
  readonly id = "claude" as const;

  invoke(request: SeatInvocation): Effect.Effect<SeatResult, GatewayError> {
    return Effect.tryPromise({
      try: async (signal) => {
        const { query } = await import("@anthropic-ai/claude-agent-sdk");
        const abortController = new AbortController();
        const abort = (): void => abortController.abort();
        if (signal.aborted) abort();
        else signal.addEventListener("abort", abort, { once: true });
        try {
          const stream = query({
            prompt: request.prompt,
            options: {
              abortController,
              env: oauthEnvironment(),
              model: request.model,
              maxTurns: 1,
              tools: [],
              allowedTools: [],
              permissionMode: "dontAsk",
              systemPrompt: request.system ?? "Return only the requested answer. Do not use tools.",
              ...(request.dialect === "anthropic-messages" &&
              typeof request.request.max_tokens === "number"
                ? { taskBudget: { total: request.request.max_tokens } }
                : {}),
              ...(request.outputSchema
                ? { outputFormat: { type: "json_schema" as const, schema: request.outputSchema } }
                : {}),
            },
          });
          for await (const message of stream) {
            if (message.type !== "result") continue;
            if (message.subtype !== "success") {
              throw new GatewayError(
                502,
                "CLAUDE_SEAT_FAILURE",
                message.errors.join("; ") || message.subtype,
                [],
                {
                  inputTokens: message.usage.input_tokens,
                  outputTokens: message.usage.output_tokens,
                  cachedInputTokens: message.usage.cache_read_input_tokens ?? 0,
                  planCreditUsd: message.total_cost_usd,
                },
              );
            }
            const structured = message.structured_output;
            const text = structured === undefined ? message.result : JSON.stringify(structured);
            return {
              text,
              ...(structured !== undefined ? { structured } : {}),
              usage: {
                inputTokens: message.usage.input_tokens,
                outputTokens: message.usage.output_tokens,
                cachedInputTokens: message.usage.cache_read_input_tokens ?? 0,
                planCreditUsd: message.total_cost_usd,
              },
            };
          }
          throw new Error("Claude Agent SDK completed without a result message");
        } finally {
          signal.removeEventListener("abort", abort);
        }
      },
      catch: (cause) =>
        cause instanceof GatewayError
          ? cause
          : new GatewayError(
              502,
              "CLAUDE_SEAT_FAILURE",
              cause instanceof Error ? cause.message : "Claude Agent SDK invocation failed",
            ),
    });
  }
}
