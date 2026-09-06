import { Context, Effect, Layer } from "effect";

import type { MaskirovkaConfig } from "../config";
import { contentHash } from "../domain/canonical";
import { anthropicMessage, openAiResponse } from "../domain/protocol";
import {
  GatewayError,
  type CachedGatewayResponse,
  type GatewayHealth,
  type GatewayResponse,
  type NormalizedRequest,
  type RequestMetadata,
  type SeatKind,
  type SeatResolution,
  type SeatResult,
  type SeatUsage,
} from "../domain/types";
import type { CacheRepositoryService } from "../repositories/cache-repository";
import type { RequestLogRepositoryService } from "../repositories/request-log-repository";
import type { SeatAdapter } from "../seats/seat-adapter";
import { FairGovernor } from "./fair-governor";
import { SeatRegistry } from "./seat-registry";
import { estimateApiListCost, WindowTracker } from "./window-tracker";

const cacheKey = (request: NormalizedRequest): string =>
  contentHash({
    version: 1,
    tier: request.tier,
    dialect: request.dialect,
    request: request.request,
  });

interface RoutedSeatResult {
  readonly resolution: SeatResolution;
  readonly result: SeatResult;
  readonly queued: number;
  readonly accounting: {
    readonly actualCostUsd: number;
    readonly planCreditUsd: number;
    readonly apiListCostUsd: number;
    readonly savedUsd: number;
  };
}

const MAX_SEAT_ATTEMPTS = 3;

const positiveInteger = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : undefined;

const expectedUsage = (request: NormalizedRequest): SeatUsage => {
  const inputTokens = Math.max(
    1,
    Math.ceil(`${request.system ?? ""}\n${request.prompt}`.length / 4),
  );
  const requestedOutputTokens = positiveInteger(
    request.dialect === "openai-responses"
      ? request.request.max_output_tokens
      : request.request.max_tokens,
  );
  return {
    inputTokens,
    outputTokens: requestedOutputTokens ?? (request.outputSchema === undefined ? 512 : 1_024),
  };
};

const accountingAmounts = (
  tier: NormalizedRequest["tier"],
  seat: SeatKind,
  usage: SeatUsage,
): { readonly actualCostUsd: number; readonly planCreditUsd: number } => {
  const apiListCostUsd = estimateApiListCost(tier, usage);
  return {
    actualCostUsd: usage.actualCostUsd ?? (seat === "api" ? apiListCostUsd : 0),
    planCreditUsd:
      usage.planCreditUsd ?? (seat === "claude" || seat === "codex" ? apiListCostUsd : 0),
  };
};

export class GatewayService {
  private readonly adapters: ReadonlyMap<SeatKind, SeatAdapter>;
  private readonly governors: ReadonlyMap<SeatKind, FairGovernor>;
  private readonly tracker: WindowTracker;
  private liveSergeantsUsed = 0;

  constructor(
    private readonly config: MaskirovkaConfig,
    readonly registry: SeatRegistry,
    private readonly cache: CacheRepositoryService,
    private readonly logs: RequestLogRepositoryService,
    adapters: readonly SeatAdapter[],
    tracker?: WindowTracker,
  ) {
    this.tracker =
      tracker ??
      new WindowTracker({
        claudeMonthlyCreditUsd: config.claudeMonthlyCreditUsd,
        codexWindowCalls: config.codexWindowCallLimit,
        codexWindowTokens: config.codexWindowTokenLimit,
        codexWindowMs: config.codexWindowHours * 60 * 60 * 1_000,
      });
    this.adapters = new Map(adapters.map((adapter) => [adapter.id, adapter]));
    this.governors = new Map<SeatKind, FairGovernor>([
      ["mock", new FairGovernor(64)],
      ["claude", new FairGovernor(2)],
      ["codex", new FairGovernor(1)],
      ["api", new FairGovernor(8)],
    ]);
  }

  initialize(): Effect.Effect<void, GatewayError> {
    return this.tracker.initialize().pipe(Effect.andThen(this.registry.initialize()));
  }

  execute(request: NormalizedRequest): Effect.Effect<GatewayResponse, GatewayError> {
    return this.run(request);
  }

  run(request: NormalizedRequest): Effect.Effect<GatewayResponse, GatewayError> {
    return Effect.gen({ self: this }, function* () {
      const started = performance.now();
      const key = cacheKey(request);
      const shouldReadCache =
        this.config.mode === "record" ||
        this.config.mode === "replay" ||
        request.tier === "stavka/sergeant";
      if (shouldReadCache) {
        const cached = yield* this.cache.get(key);
        if (cached) return yield* this.recordCacheHit(request, cached, started);
        if (this.config.mode === "replay") {
          return yield* Effect.fail(
            new GatewayError(409, "REPLAY_MISS", `No replay entry for ${key}`, [
              "Replay mode never invokes a seat or the network",
            ]),
          );
        }
      }

      if (this.registry.isKilled()) {
        return yield* Effect.fail(
          new GatewayError(503, "KILL_SWITCH", "Maskirovka seat traffic is disabled"),
        );
      }

      yield* this.refreshBudgetExhaustion();
      const initialResolution = yield* this.registry.resolve(
        request.tier,
        this.config.budgetPolicy,
      );
      if (initialResolution.routingReason) {
        yield* Effect.logWarning(
          `${request.tier} ${initialResolution.routingReason}: ${initialResolution.fallbackFromSeat} -> ${initialResolution.seat}`,
        );
      }
      if (
        request.tier === "stavka/sergeant" &&
        initialResolution.seat !== "mock" &&
        this.config.liveSergeantBudget !== "hosted"
      ) {
        if (this.liveSergeantsUsed >= this.config.liveSergeantBudget) {
          return yield* Effect.fail(
            new GatewayError(
              429,
              "LIVE_SERGEANT_BUDGET",
              "Live sergeant budget exhausted; use cache/replay or raise --live-sergeants",
            ),
          );
        }
        this.liveSergeantsUsed += 1;
      }

      const routed = yield* this.invokeWithFailover(request, initialResolution);
      const { accounting, queued, resolution, result } = routed;
      const requestId = crypto.randomUUID();
      const body =
        result.raw ??
        (request.dialect === "openai-responses"
          ? openAiResponse(requestId, resolution.model, result)
          : anthropicMessage(requestId, resolution.model, result, request.structuredOutputName));
      yield* this.refreshBudgetExhaustion();
      const metadata: RequestMetadata = {
        requestId,
        timestamp: new Date().toISOString(),
        tier: request.tier,
        seat: resolution.seat,
        model: resolution.model,
        dialect: request.dialect,
        mode: this.config.mode,
        cacheHit: false,
        queueDepth: queued,
        latencyMs: Math.round(performance.now() - started),
        inputTokens: result.usage.inputTokens,
        outputTokens: result.usage.outputTokens,
        actualCostUsd: accounting.actualCostUsd,
        planCreditUsd: accounting.planCreditUsd,
        apiListCostUsd: accounting.apiListCostUsd,
        estimatedSavedUsd: accounting.savedUsd,
        ...(resolution.fallbackFromSeat ? { fallbackFromSeat: resolution.fallbackFromSeat } : {}),
        ...(resolution.routingReason ? { routingReason: resolution.routingReason } : {}),
      };
      const response = { status: 200, body, metadata } satisfies GatewayResponse;
      if (this.config.mode === "record") {
        yield* this.cache.put({
          version: 1,
          key,
          storedAt: new Date().toISOString(),
          response,
        });
      }
      yield* this.logs.append(metadata);
      return response;
    });
  }

  latestRequests(limit = 100): Effect.Effect<readonly RequestMetadata[], GatewayError> {
    return this.logs.latest(Math.max(1, Math.min(limit, 500)));
  }

  health(): Effect.Effect<GatewayHealth> {
    return Effect.gen({ self: this }, function* () {
      yield* this.refreshBudgetExhaustion();
      return {
        ok: !this.registry.isKilled(),
        service: "maskirovka" as const,
        mode: this.config.mode,
        killed: this.registry.isKilled(),
        aliases: this.registry.listAliases(),
        seats: this.registry.listSeats().map((seat) => {
          const governor = this.governors.get(seat.id)?.snapshot() ?? {
            active: 0,
            queueDepth: 0,
          };
          const window = this.tracker.seatWindow(seat.id);
          return {
            id: seat.id,
            name: seat.name,
            status: seat.exhausted ? ("exhausted" as const) : seat.status,
            active: governor.active,
            queueDepth: governor.queueDepth,
            callsInWindow: window.calls,
            tokensInWindow: window.tokens,
            windowResetsAt: window.resetsAt,
            budgetKind:
              seat.id === "api"
                ? ("metered-cash" as const)
                : seat.id === "claude" || seat.id === "codex"
                  ? ("plan-credit" as const)
                  : ("none" as const),
            budgetLimitUsd: seat.monthlyBudgetUsd,
            budgetUsedUsd: this.tracker.monthlySeatUsage(seat.id),
            headroom: this.tracker.headroom(seat.id),
          };
        }),
        savings: this.tracker.snapshot(),
        accounting: {
          kind: "estimate" as const,
          durable: this.tracker.durable,
          trackedSince: this.tracker.startedAt,
          note: this.tracker.durable
            ? "Usage estimates persist locally; provider dashboards remain authoritative. Plan credit is not metered cash spend."
            : "In-memory usage estimates reset on restart; plan credit is not metered cash spend.",
        },
      };
    });
  }

  private recordCacheHit(
    request: NormalizedRequest,
    cached: CachedGatewayResponse,
    started: number,
  ): Effect.Effect<GatewayResponse, GatewayError> {
    return Effect.gen({ self: this }, function* () {
      const original = cached.response.metadata;
      const usage: SeatUsage = {
        inputTokens: original.inputTokens,
        outputTokens: original.outputTokens,
        cachedInputTokens: original.inputTokens,
      };
      const savings = yield* this.tracker.record({
        seat: original.seat,
        tier: request.tier,
        usage,
        cacheHit: true,
        actualCostUsd: 0,
        planCreditUsd: 0,
      });
      const metadata: RequestMetadata = {
        requestId: crypto.randomUUID(),
        timestamp: new Date().toISOString(),
        tier: request.tier,
        seat: original.seat,
        model: original.model,
        dialect: request.dialect,
        mode: this.config.mode,
        cacheHit: true,
        queueDepth: this.governors.get(original.seat)?.snapshot().queueDepth ?? 0,
        latencyMs: Math.round(performance.now() - started),
        inputTokens: original.inputTokens,
        outputTokens: original.outputTokens,
        actualCostUsd: 0,
        planCreditUsd: 0,
        apiListCostUsd: savings.apiListCostUsd,
        estimatedSavedUsd: savings.savedUsd,
      };
      yield* this.logs.append(metadata);
      return { status: 200, body: cached.response.body, metadata };
    });
  }

  private invokeWithFailover(
    request: NormalizedRequest,
    initialResolution: SeatResolution,
  ): Effect.Effect<RoutedSeatResult, GatewayError> {
    return Effect.gen({ self: this }, function* () {
      const excluded = new Set<SeatKind>();
      let resolution = initialResolution;
      let firstFailure: GatewayError | undefined;
      for (let attempt = 0; attempt < MAX_SEAT_ATTEMPTS; attempt += 1) {
        const adapter = this.adapters.get(resolution.seat);
        const governor = this.governors.get(resolution.seat);
        const queued = governor?.snapshot().queueDepth ?? 0;
        const invocation =
          !adapter || !governor
            ? Effect.fail(
                new GatewayError(503, "SEAT_UNAVAILABLE", `Seat ${resolution.seat} has no adapter`),
              )
            : governor.run(
                Effect.acquireUseRelease(
                  this.tracker.reserve({
                    seat: resolution.seat,
                    tier: request.tier,
                    expectedUsage: expectedUsage(request),
                  }),
                  (reservation) =>
                    adapter.invoke({ ...request, model: resolution.model }).pipe(
                      Effect.flatMap((result) => {
                        const { actualCostUsd, planCreditUsd } = accountingAmounts(
                          request.tier,
                          resolution.seat,
                          result.usage,
                        );
                        return this.tracker
                          .reconcile(reservation, {
                            seat: resolution.seat,
                            tier: request.tier,
                            usage: result.usage,
                            cacheHit: false,
                            actualCostUsd,
                            planCreditUsd,
                          })
                          .pipe(
                            Effect.map((accounting) => ({
                              result,
                              accounting: {
                                actualCostUsd,
                                planCreditUsd,
                                apiListCostUsd: accounting.apiListCostUsd,
                                savedUsd: accounting.savedUsd,
                              },
                            })),
                          );
                      }),
                      Effect.catch((error) => {
                        if (error.providerUsage === undefined) return Effect.fail(error);
                        const { actualCostUsd, planCreditUsd } = accountingAmounts(
                          request.tier,
                          resolution.seat,
                          error.providerUsage,
                        );
                        return this.tracker
                          .reconcile(reservation, {
                            seat: resolution.seat,
                            tier: request.tier,
                            usage: error.providerUsage,
                            cacheHit: false,
                            actualCostUsd,
                            planCreditUsd,
                            outcome: "failure",
                            failureCode: error.code,
                          })
                          .pipe(Effect.andThen(Effect.fail(error)));
                      }),
                    ),
                  (reservation) => this.tracker.refund(reservation),
                ),
              );
        const outcome = yield* Effect.result(invocation);
        if (outcome._tag === "Success") {
          return { resolution, ...outcome.success, queued };
        }
        const failure = outcome.failure.resolvedModel
          ? outcome.failure
          : new GatewayError(
              outcome.failure.status,
              outcome.failure.code,
              outcome.failure.message,
              outcome.failure.details,
              outcome.failure.providerUsage,
              resolution.model,
            );
        if (!this.isRetryable(failure)) {
          return yield* Effect.fail(failure);
        }
        firstFailure ??= failure;
        excluded.add(resolution.seat);
        const next = yield* Effect.result(
          this.registry.resolve(request.tier, "fallback", excluded),
        );
        if (next._tag === "Failure") {
          return yield* Effect.fail(firstFailure);
        }
        const fallbackFromSeat = initialResolution.fallbackFromSeat ?? initialResolution.seat;
        resolution = {
          ...next.success,
          fallbackFromSeat,
          routingReason: "retry-fallback",
        };
        yield* Effect.logWarning(
          `${request.tier} retry-fallback after ${failure.code}: ${fallbackFromSeat} -> ${resolution.seat}`,
        );
      }
      return yield* Effect.fail(
        firstFailure ??
          new GatewayError(
            503,
            "SEAT_ATTEMPTS_EXHAUSTED",
            `No seat completed ${request.tier} within ${MAX_SEAT_ATTEMPTS} attempts`,
          ),
      );
    });
  }

  private isRetryable(error: GatewayError): boolean {
    if (
      error.code === "WINDOW_TRACKER_REPOSITORY_FAILURE" ||
      error.code === "PLAN_RESERVATION_MISSING" ||
      error.code === "PLAN_RESERVATION_SEAT_MISMATCH"
    )
      return false;
    return error.status === 429 || error.status >= 500;
  }

  private refreshBudgetExhaustion(): Effect.Effect<void> {
    return Effect.forEach(
      this.config.seats,
      (seat) =>
        this.registry.setBudgetExhausted(
          seat.id,
          this.tracker.isExhausted(seat.id) ||
            (seat.monthlyBudgetUsd > 0 &&
              this.tracker.monthlySeatUsage(seat.id) >= seat.monthlyBudgetUsd),
        ),
      { discard: true },
    );
  }
}

export class Gateway extends Context.Service<Gateway, GatewayService>()(
  "@stavka/maskirovka/Gateway",
) {}

export const GatewayLive = (
  config: MaskirovkaConfig,
  registry: SeatRegistry,
  cache: CacheRepositoryService,
  logs: RequestLogRepositoryService,
  adapters: readonly SeatAdapter[],
): Layer.Layer<Gateway, GatewayError> =>
  Layer.effect(
    Gateway,
    Effect.gen(function* () {
      const service = new GatewayService(config, registry, cache, logs, adapters);
      yield* service.initialize();
      return service;
    }),
  );
