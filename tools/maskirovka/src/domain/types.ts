export const tierAliases = ["stavka/commander", "stavka/sergeant", "stavka/heavy"] as const;
export type TierAlias = (typeof tierAliases)[number];

export const seatKinds = ["mock", "claude", "codex", "api"] as const;
export type SeatKind = (typeof seatKinds)[number];

export type GatewayMode = "live" | "record" | "replay";
export type Dialect = "openai-responses" | "anthropic-messages";

export interface AliasResolution {
  readonly tier: TierAlias;
  readonly seat: SeatKind;
  readonly model: string;
}

export interface SeatResolution extends AliasResolution {
  readonly fallbackFromSeat?: SeatKind;
  readonly routingReason?: "budget-fallback" | "unavailable-fallback" | "retry-fallback";
}

export interface SeatDefinition {
  readonly id: SeatKind;
  readonly name: string;
  readonly mode: "local" | "container" | "contributor" | "api";
  readonly models: readonly string[];
  readonly monthlyBudgetUsd: number;
  readonly priority: number;
  readonly status: "healthy" | "unavailable" | "unchecked";
  readonly exhausted: boolean;
}

export interface NormalizedRequest {
  readonly dialect: Dialect;
  readonly tier: TierAlias;
  readonly request: Readonly<Record<string, unknown>>;
  readonly prompt: string;
  readonly system?: string;
  readonly outputSchema?: Readonly<Record<string, unknown>>;
  readonly structuredOutputName?: string;
}

export interface SeatInvocation extends NormalizedRequest {
  readonly model: string;
}

export interface SeatUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cachedInputTokens?: number;
  readonly actualCostUsd?: number;
  readonly planCreditUsd?: number;
}

export interface SeatResult {
  readonly text: string;
  readonly structured?: unknown;
  readonly raw?: unknown;
  readonly usage: SeatUsage;
}

export interface GatewayResponse {
  readonly status: number;
  readonly body: unknown;
  readonly metadata: RequestMetadata;
}

export interface RequestMetadata {
  readonly requestId: string;
  readonly timestamp: string;
  readonly tier: TierAlias;
  readonly seat: SeatKind;
  readonly model: string;
  readonly dialect: Dialect;
  readonly mode: GatewayMode;
  readonly cacheHit: boolean;
  readonly queueDepth: number;
  readonly latencyMs: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly actualCostUsd: number;
  readonly planCreditUsd: number;
  readonly apiListCostUsd: number;
  readonly estimatedSavedUsd: number;
  readonly fallbackFromSeat?: SeatKind;
  readonly routingReason?: "budget-fallback" | "unavailable-fallback" | "retry-fallback";
}

export interface CachedGatewayResponse {
  readonly version: 1;
  readonly key: string;
  readonly storedAt: string;
  readonly response: GatewayResponse;
}

export interface GatewayHealth {
  readonly ok: boolean;
  readonly service: "maskirovka";
  readonly mode: GatewayMode;
  readonly killed: boolean;
  readonly aliases: readonly AliasResolution[];
  readonly seats: readonly SeatHealth[];
  readonly savings: SavingsSnapshot;
  readonly accounting: {
    readonly kind: "estimate";
    readonly durable: boolean;
    readonly trackedSince: string;
    readonly note: string;
  };
}

export interface SeatHealth {
  readonly id: SeatKind;
  readonly name: string;
  readonly status: "healthy" | "unavailable" | "unchecked" | "exhausted";
  readonly active: number;
  readonly queueDepth: number;
  readonly callsInWindow: number;
  readonly tokensInWindow: number;
  readonly windowResetsAt: string;
  readonly budgetKind: "plan-credit" | "metered-cash" | "none";
  readonly budgetLimitUsd: number;
  readonly budgetUsedUsd: number;
  readonly headroom: {
    readonly kind: "monthly-plan-credit" | "rolling-plan-window" | "metered-cash" | "unlimited";
    readonly durable: boolean;
    readonly estimated: true;
    readonly resetsAt: string;
    readonly creditLimitUsd?: number;
    readonly callLimit?: number;
    readonly tokenLimit?: number;
    readonly remainingCreditUsd?: number;
    readonly remainingCalls?: number;
    readonly remainingTokens?: number;
  };
}

export interface SavingsSnapshot {
  readonly requests: number;
  readonly cacheHits: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly actualCostUsd: number;
  readonly planCreditUsd: number;
  readonly apiListEquivalentUsd: number;
  readonly savedVsApiUsd: number;
}

export interface DoctorCheck {
  readonly id: string;
  readonly status: "pass" | "warn" | "fail" | "skip";
  readonly message: string;
}

export interface DoctorReport {
  readonly ok: boolean;
  readonly checks: readonly DoctorCheck[];
  readonly wroteDevVars: readonly string[];
}

export class GatewayError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details: readonly string[] = [],
    readonly providerUsage?: SeatUsage,
    readonly resolvedModel?: string,
  ) {
    super(message);
  }
}
