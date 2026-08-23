import { Data, Effect } from "effect";

/** Provider-neutral model execution contracts shared by every Stavka surface. */

export const ModelProviderIds = ["codex", "claude"] as const;
export type ModelProviderId = (typeof ModelProviderIds)[number];

export const BillingModes = ["subscription", "metered"] as const;
export type BillingMode = (typeof BillingModes)[number];

export const ExecutionTransports = ["worker-direct", "private-runner", "agent-runtime"] as const;
export type ExecutionTransport = (typeof ExecutionTransports)[number];

export interface ProviderCapabilities {
  readonly streaming: boolean;
  readonly structuredOutput: boolean;
  readonly toolCalling: boolean;
  readonly agentRuntime: boolean;
  readonly subscriptionBilling: boolean;
  readonly serverSafeAuth: boolean;
}

/** Sanitized upstream diagnostics. Credentials, account ids, and bodies are forbidden. */
export interface UpstreamDiagnostic {
  readonly status?: number;
  readonly contentType?: string;
  readonly cfRay?: string;
  readonly cfMitigated?: string;
  readonly requestId?: string;
  readonly category?: "sse" | "json" | "challenge" | "network" | "agent-runtime";
}

export interface UsageMetadata {
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly cachedInputTokens?: number;
  readonly reasoningTokens?: number;
  /** Only populated for metered credentials or an SDK-provided plan-credit estimate. */
  readonly actualCostUsd?: number;
  readonly planCreditUsd?: number;
}

export interface ProviderTool {
  readonly name: string;
  readonly description?: string;
  readonly inputSchema: Readonly<Record<string, unknown>>;
}

export interface ModelRequest {
  readonly model: string;
  readonly system?: string;
  readonly input: string;
  readonly outputSchema?: Readonly<Record<string, unknown>>;
  readonly outputSchemaName?: string;
  readonly tools?: readonly ProviderTool[];
  readonly reasoningEffort?: "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
  readonly maxOutputTokens?: number;
  readonly maxRetries?: number;
  readonly firstEventTimeoutMs?: number;
  readonly idleTimeoutMs?: number;
  readonly totalTimeoutMs?: number;
}

export type ModelStreamEvent =
  | { readonly type: "response.started"; readonly requestId?: string }
  | { readonly type: "reasoning.delta"; readonly delta: string }
  | { readonly type: "output.delta"; readonly delta: string }
  | {
      readonly type: "tool.call";
      readonly id: string;
      readonly name: string;
      readonly arguments: unknown;
    }
  | { readonly type: "response.completed"; readonly responseId?: string };

export interface CompletionMetadata {
  readonly provider: ModelProviderId;
  readonly requestedModel: string;
  /** Model id reported by the provider; falls back to requestedModel only when omitted upstream. */
  readonly resolvedModel: string;
  readonly billingMode: BillingMode;
  readonly latencyMs: number;
  readonly firstEventLatencyMs?: number;
  readonly retryCount: number;
  readonly usage?: UsageMetadata;
  readonly transport: ExecutionTransport;
  readonly providerRequestId?: string;
  readonly diagnostic?: UpstreamDiagnostic;
}

export interface ModelCompletion {
  readonly text: string;
  readonly structured?: unknown;
  readonly toolCalls: readonly Extract<ModelStreamEvent, { readonly type: "tool.call" }>[];
  readonly metadata: CompletionMetadata;
}

export class ModelProviderError extends Data.TaggedError("ModelProviderError")<{
  readonly provider: ModelProviderId;
  readonly kind:
    | "auth"
    | "rate_limit"
    | "blocked"
    | "invalid_request"
    | "protocol"
    | "provider"
    | "timeout"
    | "cancelled";
  readonly message: string;
  readonly status?: number;
  readonly retryAfterMs?: number;
  readonly retryCount?: number;
  readonly diagnostic?: UpstreamDiagnostic;
}> {}

export interface ModelProvider {
  readonly id: ModelProviderId;
  readonly capabilities: ProviderCapabilities;
  readonly complete: (request: ModelRequest) => Effect.Effect<ModelCompletion, ModelProviderError>;
  readonly stream: (
    request: ModelRequest,
    onEvent: (event: ModelStreamEvent) => void,
  ) => Effect.Effect<ModelCompletion, ModelProviderError>;
}

export const redactProviderMessage = (
  value: string,
  fallback = "Provider request failed",
): string =>
  (value.trim() || fallback)
    .replace(/Bearer\s+[^\s,;]+/giu, "Bearer [redacted]")
    .replace(/(?:sk|sess|eyJ)[-_a-zA-Z0-9.]{16,}/gu, "[redacted]")
    .slice(0, 500);
