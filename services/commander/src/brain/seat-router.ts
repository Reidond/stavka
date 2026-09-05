import type { LlmTierAlias } from "@stavka/protocol";
import { Data, Effect, Schema } from "effect";
import { resolveOrchestrator } from "../durable/resolve-orchestrator";

import { AiDecisionResult, runAiDecision } from "./llm-client";
import type { CommanderConfig, Env } from "../config";
import type { SeatRegistration } from "../state/types";

export const SEAT_REGISTRY_NAME = "__seat-registry__";

export class ContributorSeatError extends Data.TaggedError("ContributorSeatError")<{
  readonly seatId: string;
  readonly cause: unknown;
}> {}

export class ContributorResultError extends Data.TaggedError("ContributorResultError")<{
  readonly code: string;
  readonly message: string;
  readonly retryable: boolean;
  readonly tokenUsage?: { readonly input: number; readonly output: number };
  readonly costUsd?: number;
  readonly resolvedModel?: string;
}> {
  get isRetryable(): boolean {
    return this.retryable;
  }
}

export class LlmRouteUnavailable extends Data.TaggedError("LlmRouteUnavailable")<{
  readonly stretched: boolean;
  readonly cause?: unknown;
}> {}

export interface RoutedAiCostAttribution {
  readonly model: string;
  readonly tokenUsage: { readonly input: number; readonly output: number };
  readonly costUsd: number;
  readonly seatId?: string;
}

export interface RoutedAiDecision extends AiDecisionResult {
  readonly seatId?: string;
  readonly fallback: boolean;
  /** Actual provider usage for every settled attempt, including failovers. */
  readonly costAttributions?: readonly RoutedAiCostAttribution[];
}

/**
 * Keep settled provider-attempt accounting attached to a terminal route
 * failure. This lets the durable planner emit the spend even when it falls
 * back to rules rather than returning a decision.
 */
export class RoutedAiFailure extends Data.TaggedError("RoutedAiFailure")<{
  readonly cause: unknown;
  readonly costAttributions: readonly RoutedAiCostAttribution[];
}> {}

export interface ResolvedLlmRoute {
  readonly config: CommanderConfig;
  readonly seatId?: string;
  readonly fallback: boolean;
  readonly stretched: boolean;
  readonly contributor: boolean;
}

export const servesTier = (seat: SeatRegistration, tier: LlmTierAlias): boolean =>
  seat.models.includes(tier);

const hasBudget = (seat: SeatRegistration): boolean =>
  seat.monthlyBudgetUsd > 0 && seat.spentUsd + seat.reservedUsd < seat.monthlyBudgetUsd;

const hasIsolatedCredential = (seat: SeatRegistration, config: CommanderConfig): boolean =>
  seat.mode === "contributor" || config.seatKeys[seat.id] !== undefined;

export const seatIsHealthy = (seat: SeatRegistration, nowSeconds = Date.now() / 1_000): boolean =>
  seat.healthy && (seat.healthExpiresAt === undefined || seat.healthExpiresAt > nowSeconds);

/** Resolve registered HTTP seats first; Maskirovka remains the metered fallback. */
export const resolveLlmRoute = (
  seats: readonly SeatRegistration[],
  config: CommanderConfig,
  tier: LlmTierAlias,
  nowSeconds = Date.now() / 1_000,
): ResolvedLlmRoute => {
  const registered = seats.filter((seat) => servesTier(seat, tier));
  const selected = registered
    .filter(
      (seat) =>
        seatIsHealthy(seat, nowSeconds) &&
        !seat.exhausted &&
        hasBudget(seat) &&
        hasIsolatedCredential(seat, config),
    )
    .sort((left, right) => right.priority - left.priority)[0];
  if (selected?.mode === "contributor") {
    return {
      config,
      seatId: selected.id,
      fallback: false,
      stretched: false,
      contributor: true,
    };
  }
  if (selected !== undefined && "endpoint" in selected) {
    return {
      config: {
        ...config,
        aiProvider: selected.provider === "claude" ? "anthropic" : "openai",
        aiBaseUrl: selected.endpoint,
        ...(config.seatKeys[selected.id] ? { aiKey: config.seatKeys[selected.id] } : {}),
      },
      seatId: selected.id,
      fallback: false,
      stretched: false,
      contributor: false,
    };
  }
  if (registered.length === 0) {
    return { config, fallback: false, stretched: false, contributor: false };
  }
  if (config.seatExhaustionPolicy === "stretch") {
    return { config, fallback: false, stretched: true, contributor: false };
  }
  return { config, fallback: true, stretched: false, contributor: false };
};

const ContributorInvocationFailure = Schema.Struct({
  code: Schema.String,
  message: Schema.String,
  retryable: Schema.Boolean,
  tokenUsage: Schema.optional(Schema.Struct({ input: Schema.Number, output: Schema.Number })),
  costUsd: Schema.optional(Schema.Number),
  resolvedModel: Schema.optional(Schema.String),
});

const ContributorInvocationOutcome = Schema.Union([
  Schema.Struct({ ok: Schema.Literal(true), result: AiDecisionResult }),
  Schema.Struct({ ok: Schema.Literal(false), failure: ContributorInvocationFailure }),
]);

export const invokeContributorSeat = (
  env: Env,
  seatId: string,
  tier: LlmTierAlias,
  prompt: string,
  timeoutSeconds: number,
  jobId?: string,
  leaseId?: string,
): Effect.Effect<AiDecisionResult, ContributorSeatError | ContributorResultError> =>
  resolveOrchestrator(env, SEAT_REGISTRY_NAME).pipe(
    Effect.flatMap((registry) =>
      Effect.tryPromise({
        // Durable Object RPC does not promise to preserve Error subclasses. The
        // registry therefore returns known contributor failures as a data result,
        // so the protocol retryable flag survives this boundary verbatim.
        try: (): Promise<unknown> =>
          registry.invokeContributorOutcome(seatId, tier, prompt, timeoutSeconds, jobId, leaseId),
        catch: (cause) => cause,
      }),
    ),
    Effect.mapError((cause) => new ContributorSeatError({ seatId, cause })),
    Effect.flatMap(Schema.decodeUnknownEffect(ContributorInvocationOutcome)),
    Effect.flatMap((outcome) => {
      if (outcome.ok) return Effect.succeed(outcome.result);
      const failure = outcome.failure;
      return Effect.fail(
        new ContributorResultError({
          code: failure.code,
          message: failure.message,
          retryable: failure.retryable,
          ...(failure.tokenUsage === undefined ? {} : { tokenUsage: failure.tokenUsage }),
          ...(failure.costUsd === undefined ? {} : { costUsd: failure.costUsd }),
          ...(failure.resolvedModel === undefined ? {} : { resolvedModel: failure.resolvedModel }),
        }),
      );
    }),
    Effect.mapError((cause) =>
      cause instanceof ContributorSeatError || cause instanceof ContributorResultError
        ? cause
        : new ContributorSeatError({ seatId, cause }),
    ),
  );

const seatConfig = (
  seat: Exclude<SeatRegistration, { readonly mode: "contributor" }>,
  config: CommanderConfig,
): CommanderConfig => {
  const { aiKey: _globalAiKey, ...isolated } = config;
  const seatKey = config.seatKeys[seat.id];
  return {
    ...isolated,
    aiProvider: seat.provider === "claude" ? "anthropic" : "openai",
    aiBaseUrl: seat.endpoint,
    ...(seatKey === undefined ? {} : { aiKey: seatKey }),
  };
};

export const estimatedSeatReservationUsd = (tier: LlmTierAlias): number => {
  switch (tier) {
    case "stavka/sergeant":
      return 0.05;
    case "stavka/commander":
      return 0.25;
    case "stavka/heavy":
      return 0.5;
  }
};

const errorRecord = (cause: unknown): Record<string, unknown> | undefined =>
  typeof cause === "object" && cause !== null ? (cause as Record<string, unknown>) : undefined;

/** Only transport, timeout, rate-limit, and unavailable failures may fail over. */
export const isRetryableSeatFailure = (cause: unknown): boolean => {
  const record = errorRecord(cause);
  if (record === undefined) return false;
  if (typeof record.isRetryable === "boolean") return record.isRetryable;
  const tag = typeof record._tag === "string" ? record._tag : "";
  if (
    tag === "ParseError" ||
    tag === "InvalidOutputError" ||
    tag === "StructuredOutputError" ||
    tag === "InvalidRequestError" ||
    tag === "AuthenticationError" ||
    tag === "ContentPolicyError"
  )
    return false;
  if (
    tag === "TimeoutException" ||
    tag === "RequestError" ||
    tag === "ResponseError" ||
    tag === "NetworkError" ||
    tag === "RateLimitError"
  )
    return true;
  if ("cause" in record && record.cause !== cause) {
    const nested = isRetryableSeatFailure(record.cause);
    if (nested) return true;
    if (tag === "ContributorSeatError") return false;
  }
  if (cause instanceof Error) {
    return /timed?\s*out|unavailable|disconnect|network|transport|fetch failed/i.test(
      cause.message,
    );
  }
  return false;
};

export const reportedSeatFailureUsage = (
  cause: unknown,
): {
  readonly tokenUsage: { readonly input: number; readonly output: number };
  readonly costUsd: number;
  readonly resolvedModel?: string;
} => {
  const record = errorRecord(cause);
  if (record !== undefined) {
    if (
      typeof record.costUsd === "number" &&
      typeof record.tokenUsage === "object" &&
      record.tokenUsage !== null
    ) {
      const usage = record.tokenUsage as Record<string, unknown>;
      if (typeof usage.input === "number" && typeof usage.output === "number") {
        return {
          tokenUsage: { input: usage.input, output: usage.output },
          costUsd: record.costUsd,
          ...(typeof record.resolvedModel === "string"
            ? { resolvedModel: record.resolvedModel }
            : {}),
        };
      }
    }
    if ("cause" in record && record.cause !== cause) {
      return reportedSeatFailureUsage(record.cause);
    }
  }
  return { tokenUsage: { input: 0, output: 0 }, costUsd: 0 };
};

export const routedFailureCostAttributions = (
  cause: unknown,
): readonly RoutedAiCostAttribution[] =>
  cause instanceof RoutedAiFailure ? cause.costAttributions : [];

const providerAttribution = (
  model: string,
  result: {
    readonly tokenUsage: { readonly input: number; readonly output: number };
    readonly costUsd: number;
  },
  seatId?: string,
): RoutedAiCostAttribution => ({
  model,
  tokenUsage: {
    input: Math.max(0, result.tokenUsage.input),
    output: Math.max(0, result.tokenUsage.output),
  },
  costUsd: Math.max(0, result.costUsd),
  ...(seatId === undefined ? {} : { seatId }),
});

const hasMeasuredUsage = (attribution: RoutedAiCostAttribution): boolean =>
  attribution.costUsd > 0 || attribution.tokenUsage.input > 0 || attribution.tokenUsage.output > 0;

const registryFailure = (operation: string, cause: unknown): Error =>
  new Error(`Seat registry ${operation} failed`, { cause });

/**
 * Shared bounded routing for Commander and Sergeant. Registered seats are
 * attempted once in priority order, with a registry-side budget reservation
 * before provider work. Semantic output failures stop immediately; only
 * retryable availability failures advance to another seat or API fallback.
 */
export const runRoutedAiDecision = (
  env: Env,
  seats: readonly SeatRegistration[],
  config: CommanderConfig,
  tier: LlmTierAlias,
  prompt: string,
  invocationId: string = crypto.randomUUID(),
): Effect.Effect<RoutedAiDecision, unknown> =>
  Effect.gen(function* () {
    const registered = seats.filter((seat) => servesTier(seat, tier));
    const candidates = registered
      .filter(
        (seat) =>
          seatIsHealthy(seat) &&
          !seat.exhausted &&
          hasBudget(seat) &&
          hasIsolatedCredential(seat, config),
      )
      .sort((left, right) => right.priority - left.priority);
    const registry = yield* resolveOrchestrator(env, SEAT_REGISTRY_NAME).pipe(
      Effect.mapError((cause) => registryFailure("initialization", cause)),
    );
    const reservationUsd = estimatedSeatReservationUsd(tier);
    const costAttributions: RoutedAiCostAttribution[] = [];
    let availabilityFailure = false;
    let registryUnavailable = false;

    for (const seat of candidates) {
      const reservationId = `${invocationId}:${seat.id}`;
      const reservation = yield* Effect.result(
        Effect.tryPromise({
          try: () => registry.reserveSeatBudget(seat.id, reservationUsd, reservationId),
          catch: (cause) => registryFailure("reservation", cause),
        }),
      );
      if (reservation._tag === "Failure") {
        registryUnavailable = true;
        break;
      }
      if (!reservation.success.accepted) continue;

      const attempted = yield* Effect.result(
        seat.mode === "contributor"
          ? invokeContributorSeat(
              env,
              seat.id,
              tier,
              prompt,
              config.seatJobTimeoutSeconds,
              invocationId,
              reservationId,
            )
          : runAiDecision(seatConfig(seat, config), { model: tier, prompt }),
      );
      if (attempted._tag === "Success") {
        // A successful provider response is not committed until its reservation
        // is reconciled. Let the durable caller retain/retry this invocation if
        // the registry is temporarily unavailable; returning the decision here
        // would strand the conservative reservation indefinitely.
        yield* Effect.tryPromise({
          try: () =>
            registry.reconcileSeatBudget(
              seat.id,
              reservationUsd,
              attempted.success.costUsd,
              reservationId,
            ),
          catch: (cause) => registryFailure("reconciliation", cause),
        });
        return {
          ...attempted.success,
          resolvedModel: attempted.success.resolvedModel ?? `${tier}@${seat.id}`,
          seatId: seat.id,
          fallback: false,
          costAttributions: [
            ...costAttributions,
            providerAttribution(
              attempted.success.resolvedModel ?? `${tier}@${seat.id}`,
              attempted.success,
              seat.id,
            ),
          ],
        };
      }

      const reportedFailure = reportedSeatFailureUsage(attempted.failure);
      const failedAttribution = providerAttribution(
        reportedFailure.resolvedModel ?? `${tier}@${seat.id}`,
        reportedFailure,
        seat.id,
      );
      if (hasMeasuredUsage(failedAttribution)) costAttributions.push(failedAttribution);

      const refunded = yield* Effect.result(
        Effect.tryPromise({
          try: () =>
            registry.reconcileSeatBudget(
              seat.id,
              reservationUsd,
              reportedFailure.costUsd,
              reservationId,
            ),
          catch: (cause) => registryFailure("refund", cause),
        }),
      );
      // Do not continue to another seat with an unresolved reservation. The
      // registry ledger is the accounting source of truth, and retrying this
      // durable decision later reuses the invocation id.
      if (refunded._tag === "Failure") {
        return yield* Effect.fail(refunded.failure);
      }
      if (!isRetryableSeatFailure(attempted.failure)) {
        return yield* Effect.fail(
          new RoutedAiFailure({
            cause: attempted.failure,
            costAttributions,
          }),
        );
      }
      availabilityFailure = true;
      yield* Effect.result(
        Effect.tryPromise({
          try: () => registry.markSeatUnhealthy(seat.id),
          catch: (cause) => registryFailure("health downgrade", cause),
        }),
      );
    }

    if (
      registered.length > 0 &&
      config.seatExhaustionPolicy === "stretch" &&
      !availabilityFailure &&
      !registryUnavailable
    ) {
      return yield* new LlmRouteUnavailable({ stretched: true });
    }
    const fallbackAttempt = yield* Effect.result(runAiDecision(config, { model: tier, prompt }));
    if (fallbackAttempt._tag === "Failure") {
      const reportedFailure = reportedSeatFailureUsage(fallbackAttempt.failure);
      const attribution = providerAttribution(
        reportedFailure.resolvedModel ?? (registered.length > 0 ? `${tier}:api-fallback` : tier),
        reportedFailure,
      );
      if (hasMeasuredUsage(attribution)) costAttributions.push(attribution);
      return yield* Effect.fail(
        new RoutedAiFailure({
          cause: fallbackAttempt.failure,
          costAttributions,
        }),
      );
    }
    const fallback = fallbackAttempt.success;
    const fallbackModel =
      fallback.resolvedModel ?? (registered.length > 0 ? `${tier}:api-fallback` : tier);
    return {
      ...fallback,
      resolvedModel: fallbackModel,
      fallback: registered.length > 0,
      costAttributions: [...costAttributions, providerAttribution(fallbackModel, fallback)],
    };
  });

export const chargeSeat = (
  seats: readonly SeatRegistration[],
  seatId: string | undefined,
  costUsd: number,
): readonly SeatRegistration[] =>
  seatId === undefined || costUsd <= 0
    ? seats
    : seats.map((seat) => {
        if (seat.id !== seatId) return seat;
        const spentUsd = seat.spentUsd + costUsd;
        return {
          ...seat,
          spentUsd,
          exhausted: spentUsd + seat.reservedUsd >= seat.monthlyBudgetUsd,
        };
      });

export const stretchedInterval = (
  route: ResolvedLlmRoute,
  interval: number,
  multiplier: number,
): number => (route.stretched ? Math.round(interval * multiplier) : interval);
