/**
 * Provider-neutral model execution contracts shared by Stavka applications.
 * Concrete providers (for example Pi/Codex in `@stavka/model-provider-pi`)
 * implement these; callers must never depend on a specific SDK shape.
 */

/**
 * How a model request physically travels. `worker-direct` sends the request
 * from the Worker itself; `private-runner` forwards it to an authenticated
 * private runner outside the Worker runtime.
 */
export const ExecutionTransports = ["worker-direct", "private-runner"] as const;
export type ExecutionTransport = (typeof ExecutionTransports)[number];

/**
 * Sanitized upstream diagnostics. Never include authorization headers,
 * account ids, tokens, or raw challenge bodies — only coarse request
 * identification useful for classifying failures.
 */
export interface UpstreamDiagnostic {
  readonly status?: number;
  readonly contentType?: string;
  readonly cfRay?: string;
  readonly cfMitigated?: string;
  readonly requestId?: string;
  /** Coarse response category, for example "challenge", "json", or "sse". */
  readonly category?: string;
}

export interface UsageMetadata {
  readonly inputTokens?: number;
  readonly outputTokens?: number;
}

export interface CompletionMetadata {
  /** The model id actually resolved by the provider, not the requested alias. */
  readonly resolvedModel: string;
  readonly latencyMs: number;
  readonly usage?: UsageMetadata;
  readonly transport: ExecutionTransport;
  readonly diagnostic?: UpstreamDiagnostic;
}

export interface ProviderFailure {
  readonly kind: "auth" | "rate_limit" | "blocked" | "invalid_request" | "provider" | "timeout";
  readonly message: string;
  readonly diagnostic?: UpstreamDiagnostic;
}
