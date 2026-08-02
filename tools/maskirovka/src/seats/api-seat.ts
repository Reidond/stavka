import { Effect } from "effect";

import { GatewayError, type SeatInvocation, type SeatResult } from "../domain/types";
import { estimateTokens, type SeatAdapter } from "./seat-adapter";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

type ApiProvider = "openai" | "anthropic";

const usageFrom = (provider: ApiProvider, body: unknown, fallbackInput: string): SeatResult["usage"] => {
  const usage = isRecord(body) && isRecord(body.usage) ? body.usage : {};
  if (provider === "openai") {
    return {
      inputTokens: typeof usage.input_tokens === "number" ? usage.input_tokens : estimateTokens(fallbackInput),
      outputTokens: typeof usage.output_tokens === "number" ? usage.output_tokens : 1,
    };
  }
  return {
    inputTokens: typeof usage.input_tokens === "number" ? usage.input_tokens : estimateTokens(fallbackInput),
    outputTokens: typeof usage.output_tokens === "number" ? usage.output_tokens : 1,
  };
};

const explicitUsageFrom = (provider: ApiProvider, body: unknown): SeatResult["usage"] | undefined => {
  const usage = isRecord(body) && isRecord(body.usage) ? body.usage : undefined;
  if (usage === undefined) return undefined;
  const inputTokens = typeof usage.input_tokens === "number" ? usage.input_tokens : undefined;
  const outputTokens = typeof usage.output_tokens === "number" ? usage.output_tokens : undefined;
  if (inputTokens === undefined && outputTokens === undefined) return undefined;
  return {
    inputTokens: inputTokens ?? 0,
    outputTokens: outputTokens ?? 0,
    ...(provider === "openai" && typeof usage.cached_input_tokens === "number"
      ? { cachedInputTokens: usage.cached_input_tokens }
      : {}),
  };
};

const openAiText = (body: unknown): string => {
  if (!isRecord(body)) return "";
  if (typeof body.output_text === "string") return body.output_text;
  if (!Array.isArray(body.output)) return "";
  return body.output.flatMap((item) => isRecord(item) && Array.isArray(item.content)
    ? item.content
    : []).map((part) => isRecord(part) && typeof part.text === "string" ? part.text : "")
    .filter(Boolean)
    .join("\n");
};

const anthropicResult = (body: unknown): { readonly text: string; readonly structured?: unknown } => {
  if (!isRecord(body) || !Array.isArray(body.content)) return { text: "" };
  const toolUse = body.content.find((part) => isRecord(part) && part.type === "tool_use");
  if (isRecord(toolUse) && toolUse.input !== undefined) {
    return { text: JSON.stringify(toolUse.input), structured: toolUse.input };
  }
  return {
    text: body.content
      .map((part) => isRecord(part) && typeof part.text === "string" ? part.text : "")
      .filter(Boolean)
      .join("\n"),
  };
};

const parseStructured = (text: string, expected: boolean): unknown => {
  if (!expected) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
};

const providerPayload = (
  provider: ApiProvider,
  request: SeatInvocation,
): Readonly<Record<string, unknown>> => {
  if (provider === "openai") {
    if (request.dialect === "openai-responses") {
      return { ...request.request, model: request.model };
    }
    return {
      model: request.model,
      input: request.prompt,
      ...(request.system ? { instructions: request.system } : {}),
      ...(request.outputSchema
        ? {
            text: {
              format: {
                type: "json_schema",
                name: request.structuredOutputName ?? "stavka_response",
                schema: request.outputSchema,
                strict: true,
              },
            },
          }
        : {}),
    };
  }
  if (request.dialect === "anthropic-messages") {
    return { ...request.request, model: request.model };
  }
  return {
    model: request.model,
    max_tokens: 4_096,
    messages: [{ role: "user", content: request.prompt }],
    ...(request.system ? { system: request.system } : {}),
    ...(request.outputSchema
      ? {
          output_config: {
            format: { type: "json_schema", schema: request.outputSchema },
          },
        }
      : {}),
  };
};

export class ApiSeat implements SeatAdapter {
  readonly id = "api" as const;

  constructor(
    private readonly openAiApiKey?: string,
    private readonly anthropicApiKey?: string,
  ) {}

  invoke(request: SeatInvocation): Effect.Effect<SeatResult, GatewayError> {
    const provider: ApiProvider = request.model.startsWith("claude-")
      ? "anthropic"
      : "openai";
    const key = provider === "openai" ? this.openAiApiKey : this.anthropicApiKey;
    if (!key) {
      return Effect.fail(new GatewayError(
        503,
        "API_SEAT_UNAVAILABLE",
        `${provider === "openai" ? "OPENAI" : "ANTHROPIC"}_API_KEY is not configured`,
      ));
    }
    return Effect.tryPromise({
      try: async (signal) => {
        const endpoint = provider === "openai"
          ? "https://api.openai.com/v1/responses"
          : "https://api.anthropic.com/v1/messages";
        const headers: Record<string, string> = provider === "openai"
          ? { authorization: `Bearer ${key}`, "content-type": "application/json" }
          : {
              "x-api-key": key,
              "anthropic-version": "2023-06-01",
              "content-type": "application/json",
            };
        const response = await fetch(endpoint, {
          method: "POST",
          headers,
          body: JSON.stringify(providerPayload(provider, request)),
          signal,
        });
        const body = await response.json().catch(() => ({
          error: { message: "Provider returned non-JSON" },
        }));
        if (!response.ok) {
          const providerMessage = isRecord(body) &&
              isRecord(body.error) &&
              typeof body.error.message === "string"
            ? body.error.message
            : `Provider returned HTTP ${response.status}`;
          throw new GatewayError(
            response.status,
            "UPSTREAM_ERROR",
            providerMessage,
            [],
            explicitUsageFrom(provider, body),
          );
        }
        const sameDialect = (provider === "openai" && request.dialect === "openai-responses") ||
          (provider === "anthropic" && request.dialect === "anthropic-messages");
        const extracted = provider === "openai"
          ? { text: openAiText(body) }
          : anthropicResult(body);
        const structured = extracted.structured ?? parseStructured(
          extracted.text,
          request.outputSchema !== undefined,
        );
        return {
          text: extracted.text,
          ...(structured !== undefined ? { structured } : {}),
          ...(sameDialect ? { raw: body } : {}),
          usage: usageFrom(provider, body, request.prompt),
        };
      },
      catch: (cause) => cause instanceof GatewayError
        ? cause
        : new GatewayError(
            502,
            "API_SEAT_FAILURE",
            cause instanceof Error ? cause.message : "Metered API invocation failed",
          ),
    });
  }
}
