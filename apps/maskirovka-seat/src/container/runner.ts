import { query, type SDKResultError, type SDKResultSuccess } from "@anthropic-ai/claude-agent-sdk";
import { Codex, type ModelReasoningEffort } from "@openai/codex-sdk";
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
import { subscriptionEnvironment } from "./auth-state";

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
  usage: Schema.optional(Schema.Struct({
    inputTokens: Schema.Number,
    outputTokens: Schema.Number,
    cachedInputTokens: Schema.optional(Schema.Number),
    estimatedCostUsd: Schema.optional(Schema.Number),
  })),
}) {}

const DEFAULT_PROVIDER_TIMEOUT_MS = 120_000;

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const providerError = (
  provider: SeatProvider,
  cause: unknown,
  resolvedModel: string,
): ProviderInvocationError => {
  if (cause instanceof ProviderInvocationError) return cause;
  const statusValue = isRecord(cause)
    ? (typeof cause.status === "number" ? cause.status : cause.statusCode)
    : undefined;
  const status = typeof statusValue === "number" && Number.isInteger(statusValue)
    ? statusValue
    : 502;
  const reason = status === 401 || status === 403
    ? "auth" as const
    : status === 429
      ? "rate_limit" as const
      : "provider" as const;
  return new ProviderInvocationError({
    provider,
    reason,
    status,
    retryable: status === 429 || status >= 500,
    message: cause instanceof Error ? cause.message : `${provider} SDK request failed`,
    resolvedModel,
  });
};

const openAiId = (prefix: string): string => `${prefix}_${crypto.randomUUID().replaceAll("-", "")}`;

const reasoningEffort = (request: OpenAIResponsesRequest): ModelReasoningEffort | undefined => {
  const effort = request.reasoning?.effort;
  if (!effort) return undefined;
  return effort === "max" ? "xhigh" : effort;
};

interface CachedCodexClient {
  readonly credential: string | undefined;
  readonly client: Codex;
}

type ClaudeSeatResult =
  | (Pick<SDKResultSuccess, "result" | "stop_reason" | "structured_output" | "subtype" | "uuid"> & {
      readonly usage: Pick<SDKResultSuccess["usage"], "input_tokens" | "output_tokens">;
    })
  | (Pick<SDKResultError, "errors" | "subtype" | "total_cost_usd"> & {
      readonly usage: Pick<SDKResultError["usage"], "input_tokens" | "output_tokens" | "cache_read_input_tokens">;
    });

export type ClaudeResultQuery = (
  request: Parameters<typeof query>[0],
) => AsyncIterable<ClaudeSeatResult>;

const liveClaudeResults: ClaudeResultQuery = async function* (request) {
  for await (const message of query(request)) {
    if (message.type === "result") yield message;
  }
};

export class LiveSeatRunner implements SeatRunner {
  private cachedCodex: CachedCodexClient | undefined;

  constructor(
    private readonly provider: SeatProvider,
    private readonly claudeResults: ClaudeResultQuery = liveClaudeResults,
    private readonly timeoutMs: number = DEFAULT_PROVIDER_TIMEOUT_MS,
  ) {}

  private withTimeout<A>(
    effect: Effect.Effect<A, ProviderInvocationError>,
    resolvedModel: string,
  ): Effect.Effect<A, ProviderInvocationError> {
    return effect.pipe(Effect.timeoutOrElse({
      duration: Math.max(1, this.timeoutMs),
      orElse: () => Effect.fail(new ProviderInvocationError({
          provider: this.provider,
          reason: "timeout",
          status: 504,
          retryable: true,
          message: `${this.provider} provider invocation timed out`,
          resolvedModel,
        })),
    }));
  }

  private codexClient(environment: Record<string, string>): Codex {
    const credential = environment.CODEX_ACCESS_TOKEN;
    if (this.cachedCodex && this.cachedCodex.credential === credential) {
      return this.cachedCodex.client;
    }
    const client = new Codex({
      env: environment,
      config: {
        analytics: { enabled: false },
        shell_environment_policy: {
          inherit: "none",
          include_only: ["PATH", "HOME", "LANG", "LC_ALL", "SHELL", "USER", "TMPDIR"],
        },
      },
    });
    this.cachedCodex = { credential, client };
    return client;
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
    return this.withTimeout(Effect.gen({ self: this }, function* () {
      const environment = yield* subscriptionEnvironment("codex");
      return yield* Effect.tryPromise({
        try: async (signal) => {
          const codex = this.codexClient(environment);
          const effort = reasoningEffort(request);
          const thread = codex.startThread({
            model: request.model,
            sandboxMode: "read-only",
            workingDirectory: "/workspace",
            skipGitRepoCheck: true,
            networkAccessEnabled: false,
            webSearchMode: "disabled",
            approvalPolicy: "never",
            ...(effort ? { modelReasoningEffort: effort } : {}),
          });
          const schema = outputJsonSchema(request);
          const turn = await thread.run(
            responsesPrompt(request),
            schema === undefined ? { signal } : { signal, outputSchema: schema },
          );
          const usage = turn.usage;
          const inputTokens = usage?.input_tokens ?? 0;
          const outputTokens = usage?.output_tokens ?? 0;
          const responseId = openAiId("resp");
          return {
            id: responseId,
            object: "response" as const,
            created_at: Math.floor(Date.now() / 1_000),
            status: "completed" as const,
            error: null,
            incomplete_details: null,
            model: request.model,
            output: [
              {
                id: openAiId("msg"),
                type: "message" as const,
                status: "completed" as const,
                role: "assistant" as const,
                content: [
                  {
                    type: "output_text" as const,
                    text: turn.finalResponse,
                    annotations: [],
                  },
                ],
              },
            ],
            output_text: turn.finalResponse,
            usage: {
              input_tokens: inputTokens,
              input_tokens_details: { cached_tokens: usage?.cached_input_tokens ?? 0 },
              output_tokens: outputTokens,
              output_tokens_details: { reasoning_tokens: usage?.reasoning_output_tokens ?? 0 },
              total_tokens: inputTokens + outputTokens,
            },
          };
        },
        catch: (cause) => providerError("codex", cause, request.model),
      });
    }), request.model);
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
    return this.withTimeout(Effect.gen({ self: this }, function* () {
      const environment = yield* subscriptionEnvironment("claude");
      return yield* Effect.tryPromise({
        try: async (signal) => {
          const abortController = new AbortController();
          const abort = (): void => abortController.abort(signal.reason);
          if (signal.aborted) abort();
          else signal.addEventListener("abort", abort, { once: true });

          let result: ClaudeSeatResult | undefined;
          try {
            const systemPrompt = anthropicSystem(request);
            for await (const message of this.claudeResults({
              prompt: anthropicPrompt(request),
              options: {
                abortController,
                model: request.model,
                maxTurns: 1,
                taskBudget: { total: request.max_tokens },
                tools: [],
                persistSession: false,
                settingSources: [],
                cwd: "/workspace",
                env: environment,
                ...(systemPrompt ? { systemPrompt } : {}),
                ...(request.output_config?.format
                  ? {
                      outputFormat: {
                        type: "json_schema" as const,
                        schema: { ...request.output_config.format.schema },
                      },
                    }
                  : {}),
              },
            })) {
              result = message;
            }
          } finally {
            signal.removeEventListener("abort", abort);
          }

          if (!result) throw new Error("Claude Agent SDK returned no result");
          if (result.subtype !== "success") {
            const message = result.errors.join("; ") || result.subtype;
            const normalized = message.toLowerCase();
            const reason = normalized.includes("rate limit") || normalized.includes("credit")
              ? "rate_limit" as const
              : normalized.includes("auth") || normalized.includes("login") ||
                  normalized.includes("token")
                ? "auth" as const
                : "provider" as const;
            throw new ProviderInvocationError({
              provider: "claude",
              reason,
              status: reason === "rate_limit" ? 429 : reason === "auth" ? 401 : 502,
              retryable: reason !== "auth",
              message,
              resolvedModel: request.model,
              usage: {
                inputTokens: result.usage.input_tokens,
                outputTokens: result.usage.output_tokens,
                cachedInputTokens: result.usage.cache_read_input_tokens ?? 0,
                estimatedCostUsd: result.total_cost_usd,
              },
            });
          }
          const responseText =
            result.structured_output === undefined
              ? result.result
              : JSON.stringify(result.structured_output);
          return {
            id: `msg_${result.uuid}`,
            type: "message" as const,
            role: "assistant" as const,
            model: request.model,
            content: [{ type: "text" as const, text: responseText }],
            stop_reason: result.stop_reason ?? "end_turn",
            stop_sequence: null,
            usage: {
              input_tokens: result.usage.input_tokens,
              output_tokens: result.usage.output_tokens,
            },
          };
        },
        catch: (cause) => providerError("claude", cause, request.model),
      });
    }), request.model);
  }
}
