import {
  ModelProviderError,
  redactProviderMessage,
  type ExecutionTransport,
  type ModelCompletion,
  type ModelProvider,
  type ModelRequest,
  type ModelStreamEvent,
  type UpstreamDiagnostic,
  type UsageMetadata,
} from "@stavka/model-provider";
import type { CodexOAuthCredential } from "@stavka/provider-auth";
import { Effect } from "effect";

import { parseServerSentEvents } from "./sse";

export const STAVKA_CODEX_PROVIDER_VERSION = "1.0.0";
const CODEX_RESPONSES_URL = "https://chatgpt.com/backend-api/codex/responses";
const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const numberAt = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;

const usageFrom = (response: Record<string, unknown>): UsageMetadata | undefined => {
  const usage = isRecord(response.usage) ? response.usage : undefined;
  if (!usage) return undefined;
  const inputDetails = isRecord(usage.input_tokens_details) ? usage.input_tokens_details : {};
  const outputDetails = isRecord(usage.output_tokens_details) ? usage.output_tokens_details : {};
  const inputTokens = numberAt(usage.input_tokens);
  const outputTokens = numberAt(usage.output_tokens);
  const cachedInputTokens = numberAt(inputDetails.cached_tokens);
  const reasoningTokens = numberAt(outputDetails.reasoning_tokens);
  return {
    ...(inputTokens === undefined ? {} : { inputTokens }),
    ...(outputTokens === undefined ? {} : { outputTokens }),
    ...(cachedInputTokens === undefined ? {} : { cachedInputTokens }),
    ...(reasoningTokens === undefined ? {} : { reasoningTokens }),
  };
};

const retryAfterMs = (headers: Headers): number | undefined => {
  const millisecondsValue = headers.get("retry-after-ms");
  if (millisecondsValue !== null) {
    const milliseconds = Number(millisecondsValue);
    if (Number.isFinite(milliseconds) && milliseconds >= 0) return milliseconds;
  }
  const value = headers.get("retry-after");
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1_000;
  const date = Date.parse(value);
  return Number.isNaN(date) ? undefined : Math.max(0, date - Date.now());
};

const diagnosticFrom = (response: Response): UpstreamDiagnostic => {
  const contentType = response.headers.get("content-type") ?? undefined;
  const challenged =
    response.headers.get("cf-mitigated") === "challenge" || contentType?.includes("text/html");
  return {
    status: response.status,
    ...(contentType ? { contentType } : {}),
    ...(response.headers.get("cf-ray") ? { cfRay: response.headers.get("cf-ray") as string } : {}),
    ...(response.headers.get("cf-mitigated")
      ? { cfMitigated: response.headers.get("cf-mitigated") as string }
      : {}),
    ...(response.headers.get("x-request-id") || response.headers.get("x-oai-request-id")
      ? {
          requestId: (response.headers.get("x-request-id") ??
            response.headers.get("x-oai-request-id")) as string,
        }
      : {}),
    category: challenged
      ? "challenge"
      : contentType?.includes("text/event-stream")
        ? "sse"
        : "json",
  };
};

const requestBody = (request: ModelRequest): Readonly<Record<string, unknown>> => ({
  model: request.model,
  store: false,
  stream: true,
  instructions: request.system ?? "Return only the requested answer.",
  input: [
    {
      role: "user",
      content: [{ type: "input_text", text: request.input }],
    },
  ],
  text: {
    verbosity: "low",
    ...(request.outputSchema
      ? {
          format: {
            type: "json_schema",
            name: request.outputSchemaName ?? "stavka_response",
            schema: request.outputSchema,
            strict: true,
          },
        }
      : {}),
  },
  include: ["reasoning.encrypted_content"],
  parallel_tool_calls: true,
  tool_choice: request.tools?.length ? "auto" : "none",
  ...(request.tools?.length
    ? {
        tools: request.tools.map((tool) => ({
          type: "function",
          name: tool.name,
          ...(tool.description ? { description: tool.description } : {}),
          parameters: tool.inputSchema,
          strict: true,
        })),
      }
    : {}),
  ...(request.reasoningEffort && request.reasoningEffort !== "none"
    ? { reasoning: { effort: request.reasoningEffort, summary: "auto" } }
    : {}),
});

const safeJson = (data: string): Record<string, unknown> => {
  try {
    const parsed = JSON.parse(data) as unknown;
    if (!isRecord(parsed)) throw new Error("event must be an object");
    return parsed;
  } catch (cause) {
    throw new ModelProviderError({
      provider: "codex",
      kind: "protocol",
      message: redactProviderMessage(
        cause instanceof Error
          ? `Malformed Codex SSE event: ${cause.message}`
          : "Malformed Codex SSE event",
      ),
    });
  }
};

const errorFromEvent = (event: Record<string, unknown>): ModelProviderError | undefined => {
  if (event.type !== "error" && event.type !== "response.failed") return undefined;
  const response = isRecord(event.response) ? event.response : undefined;
  const nested = isRecord(event.error)
    ? event.error
    : response && isRecord(response.error)
      ? response.error
      : undefined;
  const message = typeof nested?.message === "string" ? nested.message : "Codex response failed";
  const code = typeof nested?.code === "string" ? nested.code : "";
  return new ModelProviderError({
    provider: "codex",
    kind: /usage|limit|quota|rate/iu.test(`${code} ${message}`) ? "rate_limit" : "provider",
    message: redactProviderMessage(message),
  });
};

const sleep = (milliseconds: number, signal: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new DOMException("Request cancelled", "AbortError"));
      return;
    }
    const timer = setTimeout(resolve, milliseconds);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(new DOMException("Request cancelled", "AbortError"));
      },
      { once: true },
    );
  });

export interface CodexProviderOptions {
  readonly credential: CodexOAuthCredential;
  readonly fetcher?: typeof fetch;
  readonly endpoint?: string;
  readonly transport?: ExecutionTransport;
}

export class CodexProvider implements ModelProvider {
  readonly id = "codex" as const;
  readonly capabilities = {
    streaming: true,
    structuredOutput: true,
    toolCalling: true,
    agentRuntime: false,
    subscriptionBilling: true,
    serverSafeAuth: true,
  } as const;

  private readonly fetcher: typeof fetch;
  private readonly endpoint: string;
  private readonly transport: ExecutionTransport;

  constructor(private readonly options: CodexProviderOptions) {
    this.fetcher = options.fetcher ?? globalThis.fetch;
    this.endpoint = options.endpoint ?? CODEX_RESPONSES_URL;
    this.transport = options.transport ?? "worker-direct";
  }

  readonly complete = (request: ModelRequest) => this.stream(request, () => undefined);

  readonly stream = (
    request: ModelRequest,
    onEvent: (event: ModelStreamEvent) => void,
  ): Effect.Effect<ModelCompletion, ModelProviderError> =>
    Effect.tryPromise({
      try: async (parentSignal) => {
        if (request.maxOutputTokens !== undefined) {
          throw new ModelProviderError({
            provider: "codex",
            kind: "invalid_request",
            message: "The ChatGPT Codex subscription transport does not accept max_output_tokens",
          });
        }
        const maximumRetries = Math.max(0, Math.min(5, request.maxRetries ?? 0));
        const requestStartedAt = performance.now();
        const sessionId = crypto.randomUUID();
        let retries = 0;
        while (true) {
          const elapsedMs = performance.now() - requestStartedAt;
          const firstEventRemainingMs = (request.firstEventTimeoutMs ?? 30_000) - elapsedMs;
          const totalRemainingMs = (request.totalTimeoutMs ?? 120_000) - elapsedMs;
          if (firstEventRemainingMs <= 0 || totalRemainingMs <= 0) {
            throw new ModelProviderError({
              provider: "codex",
              kind: "timeout",
              message: `Codex ${totalRemainingMs <= 0 ? "total" : "first_event"} timeout`,
              retryCount: retries,
            });
          }
          const controller = new AbortController();
          let timeoutKind: "first_event" | "idle" | "total" | undefined;
          let receivedEvent = false;
          let firstEventLatencyMs: number | undefined;
          let idleTimer: ReturnType<typeof setTimeout> | undefined;
          const abortFromParent = (): void => controller.abort(parentSignal.reason);
          parentSignal.addEventListener("abort", abortFromParent, { once: true });
          const firstEventTimer = setTimeout(() => {
            timeoutKind = "first_event";
            controller.abort();
          }, firstEventRemainingMs);
          const totalTimer = setTimeout(() => {
            timeoutKind = "total";
            controller.abort();
          }, totalRemainingMs);
          const resetIdle = (): void => {
            if (idleTimer) clearTimeout(idleTimer);
            idleTimer = setTimeout(() => {
              timeoutKind = "idle";
              controller.abort();
            }, request.idleTimeoutMs ?? 30_000);
          };

          try {
            const credential = this.options.credential;
            if (!credential.accessToken || !credential.accountId) {
              throw new ModelProviderError({
                provider: "codex",
                kind: "auth",
                message: "Codex account is missing OAuth access or account identity",
              });
            }
            const response = await this.fetcher(this.endpoint, {
              method: "POST",
              headers: {
                authorization: `Bearer ${credential.accessToken}`,
                "chatgpt-account-id": credential.accountId,
                originator: "Codex Stavka",
                version: STAVKA_CODEX_PROVIDER_VERSION,
                "user-agent": `Codex Stavka/${STAVKA_CODEX_PROVIDER_VERSION}`,
                "openai-beta": "responses=experimental",
                session_id: sessionId,
                "x-client-request-id": crypto.randomUUID(),
                accept: "text/event-stream",
                "content-type": "application/json",
              },
              body: JSON.stringify(requestBody(request)),
              signal: controller.signal,
            });
            const diagnostic = diagnosticFrom(response);
            if (!response.ok) {
              const raw = (await response.text()).slice(0, 2_000);
              const challenged = diagnostic.category === "challenge";
              const kind = challenged
                ? "blocked"
                : response.status === 401 || response.status === 403
                  ? "auth"
                  : response.status === 429
                    ? "rate_limit"
                    : response.status >= 400 && response.status < 500
                      ? "invalid_request"
                      : "provider";
              if (retries < maximumRetries && RETRYABLE_STATUS.has(response.status)) {
                const delay = Math.min(
                  30_000,
                  retryAfterMs(response.headers) ?? 1_000 * 2 ** retries,
                );
                retries += 1;
                await sleep(Math.min(delay, totalRemainingMs), parentSignal);
                continue;
              }
              const retryDelay = retryAfterMs(response.headers);
              throw new ModelProviderError({
                provider: "codex",
                kind,
                message: challenged
                  ? "ChatGPT blocked the provider request before OAuth verification"
                  : redactProviderMessage(raw, `Codex returned HTTP ${response.status}`),
                status: response.status,
                ...(retryDelay === undefined ? {} : { retryAfterMs: retryDelay }),
                retryCount: retries,
                diagnostic,
              });
            }
            if (!response.body) {
              throw new ModelProviderError({
                provider: "codex",
                kind: "protocol",
                message: "Codex returned no response stream",
                diagnostic,
              });
            }

            let text = "";
            let resolvedModel = request.model;
            let responseId: string | undefined;
            let usage: UsageMetadata | undefined;
            let completed = false;
            const toolCalls: Extract<ModelStreamEvent, { readonly type: "tool.call" }>[] = [];
            onEvent({
              type: "response.started",
              ...(diagnostic.requestId ? { requestId: diagnostic.requestId } : {}),
            });
            for await (const frame of parseServerSentEvents(response.body, controller.signal)) {
              if (!receivedEvent) {
                receivedEvent = true;
                firstEventLatencyMs = performance.now() - requestStartedAt;
                clearTimeout(firstEventTimer);
              }
              resetIdle();
              if (!frame.data || frame.data === "[DONE]") continue;
              const event = safeJson(frame.data);
              const eventError = errorFromEvent(event);
              if (eventError) throw eventError;
              const type = typeof event.type === "string" ? event.type : frame.event;
              if (type === "response.output_text.delta" && typeof event.delta === "string") {
                text += event.delta;
                onEvent({ type: "output.delta", delta: event.delta });
              } else if (
                (type === "response.reasoning_summary_text.delta" ||
                  type === "response.reasoning_text.delta") &&
                typeof event.delta === "string"
              ) {
                onEvent({ type: "reasoning.delta", delta: event.delta });
              } else if (type === "response.output_item.done" && isRecord(event.item)) {
                const item = event.item;
                if (item.type === "function_call" && typeof item.name === "string") {
                  let argumentsValue: unknown = item.arguments;
                  if (typeof argumentsValue === "string") {
                    try {
                      argumentsValue = JSON.parse(argumentsValue) as unknown;
                    } catch {
                      // Preserve non-JSON tool arguments as their original string.
                    }
                  }
                  const call = {
                    type: "tool.call" as const,
                    id: typeof item.call_id === "string" ? item.call_id : crypto.randomUUID(),
                    name: item.name,
                    arguments: argumentsValue,
                  };
                  toolCalls.push(call);
                  onEvent(call);
                }
              } else if (type === "response.incomplete") {
                throw new ModelProviderError({
                  provider: "codex",
                  kind: "provider",
                  message: "Codex response was incomplete",
                  diagnostic,
                });
              } else if (type === "response.completed" || type === "response.done") {
                const completedResponse = isRecord(event.response) ? event.response : {};
                responseId =
                  typeof completedResponse.id === "string" ? completedResponse.id : undefined;
                resolvedModel =
                  typeof completedResponse.model === "string"
                    ? completedResponse.model
                    : request.model;
                usage = usageFrom(completedResponse);
                completed = true;
                onEvent({
                  type: "response.completed",
                  ...(responseId ? { responseId } : {}),
                });
              }
            }
            if (!receivedEvent) {
              throw new ModelProviderError({
                provider: "codex",
                kind: "protocol",
                message: "Codex stream ended without any events",
                diagnostic,
              });
            }
            if (!completed) {
              throw new ModelProviderError({
                provider: "codex",
                kind: "protocol",
                message: "Codex stream ended without a completion event",
                diagnostic,
              });
            }
            let structured: unknown;
            if (request.outputSchema) {
              try {
                structured = JSON.parse(text) as unknown;
              } catch {
                throw new ModelProviderError({
                  provider: "codex",
                  kind: "protocol",
                  message: "Codex structured response was not valid JSON",
                  diagnostic,
                });
              }
            }
            const providerRequestId = diagnostic.requestId ?? responseId;
            return {
              text,
              ...(structured !== undefined ? { structured } : {}),
              toolCalls,
              metadata: {
                provider: "codex",
                requestedModel: request.model,
                resolvedModel,
                billingMode: "subscription",
                latencyMs: performance.now() - requestStartedAt,
                ...(firstEventLatencyMs === undefined ? {} : { firstEventLatencyMs }),
                retryCount: retries,
                ...(usage === undefined ? {} : { usage }),
                transport: this.transport,
                ...(providerRequestId ? { providerRequestId } : {}),
                diagnostic,
              },
            } satisfies ModelCompletion;
          } catch (cause) {
            if (cause instanceof ModelProviderError) throw cause;
            if (parentSignal.aborted) {
              throw new ModelProviderError({
                provider: "codex",
                kind: "cancelled",
                message: "Codex request was cancelled",
                retryCount: retries,
              });
            }
            if (controller.signal.aborted || timeoutKind) {
              throw new ModelProviderError({
                provider: "codex",
                kind: "timeout",
                message: `Codex ${timeoutKind ?? "request"} timeout`,
                retryCount: retries,
              });
            }
            if (!receivedEvent && retries < maximumRetries) {
              const delay = 1_000 * 2 ** retries;
              retries += 1;
              await sleep(Math.min(delay, totalRemainingMs), parentSignal);
              continue;
            }
            throw new ModelProviderError({
              provider: "codex",
              kind: "provider",
              message: redactProviderMessage(
                cause instanceof Error ? cause.message : String(cause),
              ),
              retryCount: retries,
              diagnostic: { category: "network" },
            });
          } finally {
            parentSignal.removeEventListener("abort", abortFromParent);
            clearTimeout(firstEventTimer);
            clearTimeout(totalTimer);
            if (idleTimer) clearTimeout(idleTimer);
          }
        }
      },
      catch: (cause) =>
        cause instanceof ModelProviderError
          ? cause
          : new ModelProviderError({
              provider: "codex",
              kind: "provider",
              message: redactProviderMessage(
                cause instanceof Error ? cause.message : String(cause),
              ),
            }),
    });
}
