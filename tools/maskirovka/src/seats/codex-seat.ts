import type { ModelProvider, ModelRequest } from "@stavka/model-provider";
import { Effect } from "effect";

import { GatewayError, type SeatInvocation, type SeatResult } from "../domain/types";
import { estimateTokens, type SeatAdapter } from "./seat-adapter";

const reasoningEffort = (request: SeatInvocation): ModelRequest["reasoningEffort"] => {
  const reasoning = request.request.reasoning;
  if (reasoning === null || typeof reasoning !== "object" || Array.isArray(reasoning))
    return undefined;
  const effort = (reasoning as Readonly<Record<string, unknown>>).effort;
  return effort === "minimal" ||
    effort === "low" ||
    effort === "medium" ||
    effort === "high" ||
    effort === "xhigh" ||
    effort === "max"
    ? effort
    : undefined;
};

export class CodexSeat implements SeatAdapter {
  readonly id = "codex" as const;

  constructor(private readonly provider: ModelProvider) {}

  invoke(request: SeatInvocation): Effect.Effect<SeatResult, GatewayError> {
    const effort = reasoningEffort(request);
    const modelRequest: ModelRequest = {
      model: request.model,
      input: request.prompt,
      system:
        request.system ??
        "Return only the requested answer. Do not use tools, inspect files, or perform actions.",
      ...(request.outputSchema ? { outputSchema: request.outputSchema } : {}),
      ...(request.structuredOutputName ? { outputSchemaName: request.structuredOutputName } : {}),
      ...(effort ? { reasoningEffort: effort } : {}),
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
            `CODEX_${error.kind.toUpperCase()}`,
            error.message,
            [],
            undefined,
            request.model,
          ),
      ),
    );
  }
}
