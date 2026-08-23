import type { ModelProvider, ModelRequest } from "@stavka/model-provider";
import { Effect } from "effect";

import { GatewayError, type SeatInvocation, type SeatResult } from "../domain/types";
import { estimateTokens, type SeatAdapter } from "./seat-adapter";

export class ClaudeSeat implements SeatAdapter {
  readonly id = "claude" as const;

  constructor(private readonly provider: ModelProvider) {}

  invoke(request: SeatInvocation): Effect.Effect<SeatResult, GatewayError> {
    const maxTokens =
      request.dialect === "anthropic-messages" && typeof request.request.max_tokens === "number"
        ? request.request.max_tokens
        : undefined;
    const modelRequest: ModelRequest = {
      model: request.model,
      input: request.prompt,
      system: request.system ?? "Return only the requested answer. Do not use tools.",
      ...(request.outputSchema ? { outputSchema: request.outputSchema } : {}),
      ...(request.structuredOutputName ? { outputSchemaName: request.structuredOutputName } : {}),
      ...(maxTokens === undefined ? {} : { maxOutputTokens: maxTokens }),
      maxRetries: 0,
    };
    return this.provider.complete(modelRequest).pipe(
      Effect.map((completion) => ({
        text: completion.text,
        ...(completion.structured === undefined ? {} : { structured: completion.structured }),
        usage: {
          inputTokens: completion.metadata.usage?.inputTokens ?? estimateTokens(request.prompt),
          outputTokens: completion.metadata.usage?.outputTokens ?? estimateTokens(completion.text),
          cachedInputTokens: completion.metadata.usage?.cachedInputTokens ?? 0,
          ...(completion.metadata.usage?.actualCostUsd === undefined
            ? {}
            : { actualCostUsd: completion.metadata.usage.actualCostUsd }),
          ...(completion.metadata.usage?.planCreditUsd === undefined
            ? {}
            : { planCreditUsd: completion.metadata.usage.planCreditUsd }),
        },
      })),
      Effect.mapError(
        (error) =>
          new GatewayError(
            error.kind === "auth" ? 401 : error.kind === "rate_limit" ? 429 : 502,
            `CLAUDE_${error.kind.toUpperCase()}`,
            error.message,
            [],
            undefined,
            request.model,
          ),
      ),
    );
  }
}
