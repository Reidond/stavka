import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import {
  ModelProviderError,
  redactProviderMessage,
  type ExecutionTransport,
  type ModelCompletion,
  type ModelProvider,
  type ModelRequest,
  type ModelStreamEvent,
  type UsageMetadata,
} from "@stavka/model-provider";
import {
  ClaudeOAuthTokenSchema,
  type ClaudeSubscriptionCredential,
  type ProviderApiKeyCredential,
} from "@stavka/provider-auth";
import { Effect, Schema } from "effect";

export const STAVKA_CLAUDE_PROVIDER_VERSION = "1";
const ANTHROPIC_MESSAGES_URL = "https://api.anthropic.com/v1/messages";

const isSafeAgentEnvironmentKey = (key: string): boolean =>
  /^(?:PATH|HOME|TMPDIR|TMP|TEMP|LANG|LC_[A-Z_]+|SHELL|USER|LOGNAME|XDG_[A-Z_]+|SSL_CERT_FILE|SSL_CERT_DIR|NODE_EXTRA_CA_CERTS|HTTP_PROXY|HTTPS_PROXY|NO_PROXY|CI|CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC|DISABLE_AUTOUPDATER)$/u.test(
    key,
  );

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const numberAt = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;

export const sanitizeClaudeSubscriptionEnvironment = (
  environment: Readonly<Record<string, string | undefined>>,
  oauthToken: string,
): Record<string, string> => ({
  ...Object.fromEntries(
    Object.entries(environment).filter(
      ([key, value]) => isSafeAgentEnvironmentKey(key) && value !== undefined,
    ),
  ),
  CLAUDE_CODE_OAUTH_TOKEN: oauthToken,
});

const eventDelta = (
  message: SDKMessage,
): { readonly kind: "output" | "reasoning"; readonly text: string } | undefined => {
  if (message.type !== "stream_event") return undefined;
  const event: unknown = message.event;
  if (!isRecord(event) || event.type !== "content_block_delta" || !isRecord(event.delta))
    return undefined;
  if (event.delta.type === "text_delta" && typeof event.delta.text === "string") {
    return { kind: "output", text: event.delta.text };
  }
  if (event.delta.type === "thinking_delta" && typeof event.delta.thinking === "string") {
    return { kind: "reasoning", text: event.delta.thinking };
  }
  return undefined;
};

export interface ClaudeAgentProviderOptions {
  readonly credential: ClaudeSubscriptionCredential;
  readonly environment?: Readonly<Record<string, string | undefined>>;
}

/** Claude subscriptions execute only through the supported Claude Agent SDK runtime. */
export class ClaudeAgentProvider implements ModelProvider {
  readonly id = "claude" as const;
  readonly capabilities = {
    streaming: true,
    structuredOutput: true,
    toolCalling: false,
    agentRuntime: true,
    subscriptionBilling: true,
    serverSafeAuth: false,
  } as const;

  constructor(private readonly options: ClaudeAgentProviderOptions) {}

  readonly complete = (request: ModelRequest) => this.stream(request, () => undefined);

  readonly stream = (
    request: ModelRequest,
    onEvent: (event: ModelStreamEvent) => void,
  ): Effect.Effect<ModelCompletion, ModelProviderError> =>
    Effect.tryPromise({
      try: async (signal) => {
        if (!Schema.is(ClaudeOAuthTokenSchema)(this.options.credential.oauthToken)) {
          throw new ModelProviderError({
            provider: "claude",
            kind: "auth",
            message:
              "Claude subscription credential is malformed. Reconnect with only the setup-token value.",
          });
        }
        const startedAt = performance.now();
        const { query } = await import("@anthropic-ai/claude-agent-sdk");
        const controller = new AbortController();
        let timeoutKind: "first_event" | "idle" | "total" | undefined;
        let idleTimer: ReturnType<typeof setTimeout> | undefined;
        const abort = (): void => controller.abort(signal.reason);
        if (signal.aborted) abort();
        else signal.addEventListener("abort", abort, { once: true });
        const firstEventTimer = setTimeout(() => {
          timeoutKind = "first_event";
          controller.abort();
        }, request.firstEventTimeoutMs ?? 30_000);
        const totalTimer = setTimeout(() => {
          timeoutKind = "total";
          controller.abort();
        }, request.totalTimeoutMs ?? 120_000);
        const markEvent = (): void => {
          clearTimeout(firstEventTimer);
          if (idleTimer) clearTimeout(idleTimer);
          idleTimer = setTimeout(() => {
            timeoutKind = "idle";
            controller.abort();
          }, request.idleTimeoutMs ?? 30_000);
        };
        onEvent({ type: "response.started" });
        let firstEventLatencyMs: number | undefined;
        let text = "";
        try {
          const stream = query({
            prompt: request.input,
            options: {
              abortController: controller,
              env: {
                ...sanitizeClaudeSubscriptionEnvironment(
                  this.options.environment ?? process.env,
                  this.options.credential.oauthToken,
                ),
                ...(request.maxOutputTokens
                  ? { CLAUDE_CODE_MAX_OUTPUT_TOKENS: String(request.maxOutputTokens) }
                  : {}),
              },
              model: request.model,
              maxTurns: 1,
              tools: [],
              allowedTools: [],
              permissionMode: "dontAsk",
              settingSources: [],
              persistSession: false,
              includePartialMessages: true,
              systemPrompt: request.system ?? "Return only the requested answer. Do not use tools.",
              ...(request.reasoningEffort && request.reasoningEffort !== "none"
                ? {
                    effort:
                      request.reasoningEffort === "minimal"
                        ? ("low" as const)
                        : request.reasoningEffort,
                  }
                : {}),
              ...(request.outputSchema
                ? { outputFormat: { type: "json_schema" as const, schema: request.outputSchema } }
                : {}),
            },
          });
          for await (const message of stream) {
            markEvent();
            if (firstEventLatencyMs === undefined)
              firstEventLatencyMs = performance.now() - startedAt;
            const delta = eventDelta(message);
            if (delta) {
              if (delta.kind === "output") {
                text += delta.text;
                onEvent({ type: "output.delta", delta: delta.text });
              } else {
                onEvent({ type: "reasoning.delta", delta: delta.text });
              }
              continue;
            }
            if (message.type !== "result") continue;
            if (message.subtype !== "success" || message.is_error) {
              const failure =
                message.subtype === "success"
                  ? message.result
                  : message.errors.join("; ") || message.subtype;
              throw new ModelProviderError({
                provider: "claude",
                kind: /auth|login|oauth|token/iu.test(failure)
                  ? "auth"
                  : /rate|limit|credit/iu.test(failure)
                    ? "rate_limit"
                    : "provider",
                message: redactProviderMessage(failure),
                diagnostic: { category: "agent-runtime" },
              });
            }
            const structured = message.structured_output;
            if (!text)
              text = structured === undefined ? message.result : JSON.stringify(structured);
            const modelUsage = Object.entries(message.modelUsage)[0];
            const resolvedModel =
              modelUsage?.[1].canonicalModel ?? modelUsage?.[0] ?? request.model;
            onEvent({ type: "response.completed", responseId: message.uuid });
            return {
              text,
              ...(structured !== undefined ? { structured } : {}),
              toolCalls: [],
              metadata: {
                provider: "claude",
                requestedModel: request.model,
                resolvedModel,
                billingMode: "subscription",
                latencyMs: performance.now() - startedAt,
                ...(firstEventLatencyMs === undefined ? {} : { firstEventLatencyMs }),
                retryCount: 0,
                usage: {
                  inputTokens: message.usage.input_tokens,
                  outputTokens: message.usage.output_tokens,
                  cachedInputTokens: message.usage.cache_read_input_tokens ?? 0,
                  planCreditUsd: message.total_cost_usd,
                },
                transport: "agent-runtime",
                providerRequestId: message.uuid,
                diagnostic: { category: "agent-runtime" },
              },
            };
          }
          throw new ModelProviderError({
            provider: "claude",
            kind: "protocol",
            message: "Claude Agent SDK completed without a result",
            diagnostic: { category: "agent-runtime" },
          });
        } catch (cause) {
          if (signal.aborted) {
            throw new ModelProviderError({
              provider: "claude",
              kind: "cancelled",
              message: "Claude Agent SDK request was cancelled",
              diagnostic: { category: "agent-runtime" },
            });
          }
          if (timeoutKind) {
            throw new ModelProviderError({
              provider: "claude",
              kind: "timeout",
              message: `Claude Agent SDK ${timeoutKind} timeout`,
              diagnostic: { category: "agent-runtime" },
            });
          }
          throw cause;
        } finally {
          signal.removeEventListener("abort", abort);
          clearTimeout(firstEventTimer);
          clearTimeout(totalTimer);
          if (idleTimer) clearTimeout(idleTimer);
        }
      },
      catch: (cause) =>
        cause instanceof ModelProviderError
          ? cause
          : cause instanceof DOMException && cause.name === "AbortError"
            ? new ModelProviderError({
                provider: "claude",
                kind: "cancelled",
                message: "Anthropic request was cancelled",
              })
            : new ModelProviderError({
                provider: "claude",
                kind: "provider",
                message: redactProviderMessage(
                  cause instanceof Error ? cause.message : String(cause),
                ),
                diagnostic: { category: "agent-runtime" },
              }),
    });
}

const messagesRequestBody = (request: ModelRequest): Record<string, unknown> => ({
  model: request.model,
  max_tokens: request.maxOutputTokens ?? 4_096,
  messages: [{ role: "user", content: request.input }],
  ...(request.system ? { system: request.system } : {}),
  ...(request.outputSchema
    ? { output_config: { format: { type: "json_schema", schema: request.outputSchema } } }
    : {}),
});

export interface ClaudeApiProviderOptions {
  readonly credential: ProviderApiKeyCredential;
  readonly fetcher?: typeof fetch;
  readonly endpoint?: string;
  readonly transport?: ExecutionTransport;
}

/** Metered Anthropic API credentials use Messages directly; subscription tokens cannot enter here. */
export class ClaudeApiProvider implements ModelProvider {
  readonly id = "claude" as const;
  readonly capabilities = {
    streaming: false,
    structuredOutput: true,
    toolCalling: false,
    agentRuntime: false,
    subscriptionBilling: false,
    serverSafeAuth: true,
  } as const;

  constructor(private readonly options: ClaudeApiProviderOptions) {
    if (options.credential.kind !== "api-key")
      throw new TypeError("Claude API requires an API key credential");
  }

  readonly complete = (request: ModelRequest): Effect.Effect<ModelCompletion, ModelProviderError> =>
    Effect.tryPromise({
      try: async (signal) => {
        const startedAt = performance.now();
        const controller = new AbortController();
        let timeoutKind: "first_event" | "total" | undefined;
        const abort = (): void => controller.abort(signal.reason);
        if (signal.aborted) abort();
        else signal.addEventListener("abort", abort, { once: true });
        const firstEventTimer = setTimeout(() => {
          timeoutKind = "first_event";
          controller.abort();
        }, request.firstEventTimeoutMs ?? 30_000);
        const totalTimer = setTimeout(() => {
          timeoutKind = "total";
          controller.abort();
        }, request.totalTimeoutMs ?? 120_000);
        try {
          const response = await (this.options.fetcher ?? globalThis.fetch)(
            this.options.endpoint ?? ANTHROPIC_MESSAGES_URL,
            {
              method: "POST",
              headers: {
                "x-api-key": this.options.credential.apiKey,
                "anthropic-version": "2023-06-01",
                "content-type": "application/json",
              },
              body: JSON.stringify(messagesRequestBody(request)),
              signal: controller.signal,
            },
          );
          clearTimeout(firstEventTimer);
          const body: unknown = await response.json();
          if (!response.ok || !isRecord(body)) {
            throw new ModelProviderError({
              provider: "claude",
              kind:
                response.status === 401 || response.status === 403
                  ? "auth"
                  : response.status === 429
                    ? "rate_limit"
                    : "provider",
              message: `Anthropic returned HTTP ${response.status}`,
              status: response.status,
            });
          }
          const content = Array.isArray(body.content) ? body.content : [];
          const text = content
            .filter(
              (block): block is Record<string, unknown> => isRecord(block) && block.type === "text",
            )
            .map((block) => (typeof block.text === "string" ? block.text : ""))
            .join("");
          let structured: unknown;
          if (request.outputSchema) {
            try {
              structured = JSON.parse(text) as unknown;
            } catch {
              throw new ModelProviderError({
                provider: "claude",
                kind: "protocol",
                message: "Anthropic structured response was not valid JSON",
              });
            }
          }
          const usage = isRecord(body.usage) ? body.usage : {};
          const inputTokens = numberAt(usage.input_tokens);
          const outputTokens = numberAt(usage.output_tokens);
          const cachedInputTokens = numberAt(usage.cache_read_input_tokens);
          return {
            text,
            ...(structured === undefined ? {} : { structured }),
            toolCalls: [],
            metadata: {
              provider: "claude",
              requestedModel: request.model,
              resolvedModel: typeof body.model === "string" ? body.model : request.model,
              billingMode: "metered",
              latencyMs: performance.now() - startedAt,
              retryCount: 0,
              usage: {
                ...(inputTokens === undefined ? {} : { inputTokens }),
                ...(outputTokens === undefined ? {} : { outputTokens }),
                ...(cachedInputTokens === undefined ? {} : { cachedInputTokens }),
              } satisfies UsageMetadata,
              transport: this.options.transport ?? "worker-direct",
              ...(typeof body.id === "string" ? { providerRequestId: body.id } : {}),
            },
          };
        } catch (cause) {
          if (signal.aborted) {
            throw new ModelProviderError({
              provider: "claude",
              kind: "cancelled",
              message: "Anthropic request was cancelled",
            });
          }
          if (timeoutKind) {
            throw new ModelProviderError({
              provider: "claude",
              kind: "timeout",
              message: `Anthropic ${timeoutKind} timeout`,
            });
          }
          throw cause;
        } finally {
          signal.removeEventListener("abort", abort);
          clearTimeout(firstEventTimer);
          clearTimeout(totalTimer);
        }
      },
      catch: (cause) =>
        cause instanceof ModelProviderError
          ? cause
          : new ModelProviderError({
              provider: "claude",
              kind: "provider",
              message: redactProviderMessage(
                cause instanceof Error ? cause.message : String(cause),
              ),
            }),
    });

  readonly stream = (
    request: ModelRequest,
    onEvent: (event: ModelStreamEvent) => void,
  ): Effect.Effect<ModelCompletion, ModelProviderError> =>
    this.complete(request).pipe(
      Effect.tap((completion) =>
        Effect.sync(() => {
          onEvent({ type: "response.started" });
          onEvent({ type: "output.delta", delta: completion.text });
          onEvent({
            type: "response.completed",
            ...(completion.metadata.providerRequestId
              ? { responseId: completion.metadata.providerRequestId }
              : {}),
          });
        }),
      ),
    );
}
