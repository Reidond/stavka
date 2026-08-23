import type { ModelProvider, ModelRequest } from "@stavka/model-provider";
import { ClaudeAgentProvider, ClaudeApiProvider } from "@stavka/model-provider-claude";
import { CodexProvider } from "@stavka/model-provider-codex";
import { Effect, Schema } from "effect";

import {
  anthropicPrompt,
  anthropicSystem,
  outputJsonSchema,
  responsesPrompt,
  type AnthropicMessagesRequest,
  type OpenAIResponsesRequest,
} from "../contracts";
import type { SeatProvider } from "../config";
import type { AnthropicMessagesResult, OpenAIResponsesResult } from "../http-contract";
import { subscriptionCredential } from "./auth-state";

export interface SeatRunner {
  readonly runResponses: (
    request: OpenAIResponsesRequest,
  ) => Effect.Effect<OpenAIResponsesResult, ProviderInvocationError>;
  readonly runMessages: (
    request: AnthropicMessagesRequest,
  ) => Effect.Effect<AnthropicMessagesResult, ProviderInvocationError>;
}

export class ProviderInvocationError extends Schema.TaggedErrorClass<ProviderInvocationError>(
  "stavka/maskirovka-seat/ProviderInvocationError",
)("ProviderInvocationError", {
  provider: Schema.Literals(["claude", "codex"]),
  reason: Schema.Literals(["auth", "rate_limit", "timeout", "provider", "misconfigured"]),
  status: Schema.Number,
  retryable: Schema.Boolean,
  message: Schema.String,
  resolvedModel: Schema.optional(Schema.String),
  usage: Schema.optional(
    Schema.Struct({
      inputTokens: Schema.Number,
      outputTokens: Schema.Number,
      cachedInputTokens: Schema.optional(Schema.Number),
      estimatedCostUsd: Schema.optional(Schema.Number),
    }),
  ),
}) {}

const DEFAULT_PROVIDER_TIMEOUT_MS = 120_000;
const openAiId = (prefix: string): string => `${prefix}_${crypto.randomUUID().replaceAll("-", "")}`;
const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const providerError = (
  provider: SeatProvider,
  cause: unknown,
  resolvedModel: string,
): ProviderInvocationError => {
  if (cause instanceof ProviderInvocationError) return cause;
  const tagged = cause as {
    readonly kind?: string;
    readonly status?: number;
    readonly message?: string;
  };
  const reason =
    tagged.kind === "auth"
      ? "auth"
      : tagged.kind === "rate_limit"
        ? "rate_limit"
        : tagged.kind === "timeout"
          ? "timeout"
          : "provider";
  const status =
    tagged.status ??
    (reason === "auth" ? 401 : reason === "rate_limit" ? 429 : reason === "timeout" ? 504 : 502);
  return new ProviderInvocationError({
    provider,
    reason,
    status,
    retryable: reason !== "auth",
    message: tagged.message ?? `${provider} provider request failed`,
    resolvedModel,
  });
};

export class LiveSeatRunner implements SeatRunner {
  constructor(
    private readonly provider: SeatProvider,
    private readonly providerFactory?: () => Effect.Effect<ModelProvider, ProviderInvocationError>,
    private readonly timeoutMs: number = DEFAULT_PROVIDER_TIMEOUT_MS,
  ) {}

  private withTimeout<A>(
    effect: Effect.Effect<A, ProviderInvocationError>,
    resolvedModel: string,
  ): Effect.Effect<A, ProviderInvocationError> {
    return effect.pipe(
      Effect.timeoutOrElse({
        duration: Math.max(1, this.timeoutMs),
        orElse: () =>
          Effect.fail(
            new ProviderInvocationError({
              provider: this.provider,
              reason: "timeout",
              status: 504,
              retryable: true,
              message: `${this.provider} provider invocation timed out`,
              resolvedModel,
            }),
          ),
      }),
    );
  }

  private modelProvider(): Effect.Effect<ModelProvider, ProviderInvocationError> {
    if (this.providerFactory) return this.providerFactory();
    return subscriptionCredential(this.provider).pipe(
      Effect.mapError((cause) => providerError(this.provider, cause, "unresolved")),
      Effect.flatMap((credential): Effect.Effect<ModelProvider, ProviderInvocationError> => {
        if (this.provider === "codex" && credential.kind === "codex-chatgpt-oauth") {
          return Effect.succeed(new CodexProvider({ credential, transport: "private-runner" }));
        }
        if (this.provider === "claude" && credential.kind === "claude-subscription") {
          return Effect.succeed(new ClaudeAgentProvider({ credential }));
        }
        if (this.provider === "claude" && credential.kind === "api-key") {
          return Effect.succeed(new ClaudeApiProvider({ credential, transport: "private-runner" }));
        }
        return Effect.fail(
          new ProviderInvocationError({
            provider: this.provider,
            reason: "misconfigured",
            status: 500,
            retryable: false,
            message: `Configured credential cannot execute the ${this.provider} seat`,
          }),
        );
      }),
    );
  }

  runResponses(
    request: OpenAIResponsesRequest,
  ): Effect.Effect<OpenAIResponsesResult, ProviderInvocationError> {
    if (this.provider !== "codex") {
      return Effect.fail(
        new ProviderInvocationError({
          provider: this.provider,
          reason: "misconfigured",
          status: 500,
          retryable: false,
          message: "Codex seat required",
          resolvedModel: request.model,
        }),
      );
    }
    return this.withTimeout(
      Effect.gen({ self: this }, function* () {
        const provider = yield* this.modelProvider();
        const schema = outputJsonSchema(request);
        const modelRequest: ModelRequest = {
          model: request.model,
          input: responsesPrompt(request),
          ...(request.instructions ? { system: request.instructions } : {}),
          ...(isRecord(schema) ? { outputSchema: schema } : {}),
          ...(request.text?.format?.type === "json_schema" && request.text.format.name
            ? { outputSchemaName: request.text.format.name }
            : {}),
          ...(request.reasoning?.effort ? { reasoningEffort: request.reasoning.effort } : {}),
          ...(request.max_output_tokens ? { maxOutputTokens: request.max_output_tokens } : {}),
          maxRetries: 0,
        };
        const completion = yield* provider
          .complete(modelRequest)
          .pipe(Effect.mapError((cause) => providerError("codex", cause, request.model)));
        const inputTokens = completion.metadata.usage?.inputTokens ?? 0;
        const outputTokens = completion.metadata.usage?.outputTokens ?? 0;
        return {
          id: openAiId("resp"),
          object: "response" as const,
          created_at: Math.floor(Date.now() / 1_000),
          status: "completed" as const,
          error: null,
          incomplete_details: null,
          model: completion.metadata.resolvedModel,
          output: [
            {
              id: openAiId("msg"),
              type: "message" as const,
              status: "completed" as const,
              role: "assistant" as const,
              content: [{ type: "output_text" as const, text: completion.text, annotations: [] }],
            },
          ],
          output_text: completion.text,
          usage: {
            input_tokens: inputTokens,
            input_tokens_details: {
              cached_tokens: completion.metadata.usage?.cachedInputTokens ?? 0,
            },
            output_tokens: outputTokens,
            output_tokens_details: {
              reasoning_tokens: completion.metadata.usage?.reasoningTokens ?? 0,
            },
            total_tokens: inputTokens + outputTokens,
          },
        };
      }),
      request.model,
    );
  }

  runMessages(
    request: AnthropicMessagesRequest,
  ): Effect.Effect<AnthropicMessagesResult, ProviderInvocationError> {
    if (this.provider !== "claude") {
      return Effect.fail(
        new ProviderInvocationError({
          provider: this.provider,
          reason: "misconfigured",
          status: 500,
          retryable: false,
          message: "Claude seat required",
          resolvedModel: request.model,
        }),
      );
    }
    return this.withTimeout(
      Effect.gen({ self: this }, function* () {
        const provider = yield* this.modelProvider();
        const system = anthropicSystem(request);
        const modelRequest: ModelRequest = {
          model: request.model,
          input: anthropicPrompt(request),
          ...(system ? { system } : {}),
          ...(request.output_config?.format?.schema
            ? { outputSchema: request.output_config.format.schema }
            : {}),
          maxOutputTokens: request.max_tokens,
          maxRetries: 0,
        };
        const completion = yield* provider
          .complete(modelRequest)
          .pipe(Effect.mapError((cause) => providerError("claude", cause, request.model)));
        return {
          id: `msg_${completion.metadata.providerRequestId ?? crypto.randomUUID()}`,
          type: "message" as const,
          role: "assistant" as const,
          model: completion.metadata.resolvedModel,
          content: [{ type: "text" as const, text: completion.text }],
          stop_reason: "end_turn" as const,
          stop_sequence: null,
          usage: {
            input_tokens: completion.metadata.usage?.inputTokens ?? 0,
            output_tokens: completion.metadata.usage?.outputTokens ?? 0,
          },
        };
      }),
      request.model,
    );
  }
}
