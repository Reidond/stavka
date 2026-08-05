import { Clock, Context, Effect, Layer, Semaphore } from "effect";

import {
  GatewayError,
  type SavingsSnapshot,
  type SeatKind,
  type SeatUsage,
  type TierAlias,
} from "../domain/types";
import {
  MemoryWindowTrackerRepository,
  type PersistedWindowTracker,
  type WindowTrackerRepositoryService,
} from "../repositories/window-tracker-repository";

interface WindowEntry {
  readonly seat: SeatKind;
  readonly at: number;
  readonly tokens: number;
  readonly outcome: "success" | "failure";
  readonly failureCode?: string;
}

interface MonthlyUsage {
  readonly month: string;
  readonly usd: number;
}

export interface PlanReservation {
  readonly id: string;
  readonly seat: SeatKind;
  readonly at: number;
  readonly expiresAt: number;
  readonly expectedTokens: number;
  readonly expectedPlanCreditUsd: number;
}

export interface UsageAccountingInput {
  readonly seat: SeatKind;
  readonly tier: TierAlias;
  readonly usage: SeatUsage;
  readonly cacheHit: boolean;
  readonly actualCostUsd: number;
  readonly planCreditUsd: number;
  readonly outcome?: "success" | "failure";
  readonly failureCode?: string;
  readonly at?: number;
}

export interface UsageAccountingResult {
  readonly apiListCostUsd: number;
  readonly savedUsd: number;
  readonly budgetUsedUsd: number;
}

export interface WindowTrackerLimits {
  readonly claudeMonthlyCreditUsd: number;
  readonly codexWindowCalls: number;
  readonly codexWindowTokens: number;
  readonly codexWindowMs: number;
}

export interface SeatHeadroomSnapshot {
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
}

const defaultLimits: WindowTrackerLimits = {
  claudeMonthlyCreditUsd: 0,
  codexWindowCalls: 0,
  codexWindowTokens: 0,
  codexWindowMs: 5 * 60 * 60 * 1_000,
};

const apiRatesPerMillion: Readonly<Record<TierAlias, { input: number; output: number }>> = {
  "stavka/commander": { input: 5, output: 30 },
  "stavka/sergeant": { input: 1, output: 6 },
  "stavka/heavy": { input: 2.5, output: 15 },
};

const nonNegative = (value: number): number => (Number.isFinite(value) ? Math.max(0, value) : 0);

const nonNegativeInteger = (value: number): number => Math.floor(nonNegative(value));

const persistedFailureCodes = new Set([
  "API_SEAT_FAILURE",
  "CLAUDE_SEAT_FAILURE",
  "CODEX_SEAT_FAILURE",
  "INVALID_SEAT_RESPONSE",
  "UPSTREAM_ERROR",
]);

const safeFailureCode = (value: string): string =>
  persistedFailureCodes.has(value) ? value : "SEAT_INVOCATION_FAILED";

export const estimateApiListCost = (tier: TierAlias, usage: SeatUsage): number => {
  const rate = apiRatesPerMillion[tier];
  return (usage.inputTokens * rate.input + usage.outputTokens * rate.output) / 1_000_000;
};

export class WindowTracker {
  private trackedSince = new Date().toISOString();
  private entries: WindowEntry[] = [];
  private reservations: PlanReservation[] = [];
  private readonly monthlyUsage = new Map<SeatKind, MonthlyUsage>();
  private totals: SavingsSnapshot = {
    requests: 0,
    cacheHits: 0,
    inputTokens: 0,
    outputTokens: 0,
    actualCostUsd: 0,
    planCreditUsd: 0,
    apiListEquivalentUsd: 0,
    savedVsApiUsd: 0,
  };
  private readonly persistence = Semaphore.makeUnsafe(1);

  constructor(
    private readonly limits: WindowTrackerLimits = defaultLimits,
    private readonly repository: WindowTrackerRepositoryService = new MemoryWindowTrackerRepository(),
  ) {}

  get startedAt(): string {
    return this.trackedSince;
  }

  get durable(): boolean {
    return this.repository.durable;
  }

  initialize(): Effect.Effect<void, GatewayError> {
    return this.persistence.withPermit(
      Effect.gen({ self: this }, function* () {
        const persisted = yield* this.repository.load();
        if (persisted === undefined) return;
        this.restore(persisted);
        const before = this.reservations.length;
        this.prune(yield* Clock.currentTimeMillis);
        if (this.reservations.length !== before) yield* this.repository.save(this.persisted());
      }),
    );
  }

  record(input: UsageAccountingInput): Effect.Effect<UsageAccountingResult, GatewayError> {
    return this.persistence.withPermit(
      Effect.gen({ self: this }, function* () {
        const previous = this.persisted();
        const result = this.applyRecord(input, input.at ?? (yield* Clock.currentTimeMillis));
        yield* this.repository
          .save(this.persisted())
          .pipe(Effect.tapError(() => Effect.sync(() => this.restore(previous))));
        return result;
      }),
    );
  }

  reserve(input: {
    readonly seat: SeatKind;
    readonly tier: TierAlias;
    readonly expectedUsage: SeatUsage;
    readonly expectedPlanCreditUsd?: number;
    readonly at?: number;
    readonly ttlMs?: number;
  }): Effect.Effect<PlanReservation, GatewayError> {
    return this.persistence.withPermit(
      Effect.gen({ self: this }, function* () {
        const at = input.at ?? (yield* Clock.currentTimeMillis);
        const previous = this.persisted();
        this.prune(at);
        const expectedTokens = Math.max(
          1,
          nonNegativeInteger(input.expectedUsage.inputTokens) +
            nonNegativeInteger(input.expectedUsage.outputTokens),
        );
        const expectedPlanCreditUsd = nonNegative(
          input.expectedPlanCreditUsd ?? estimateApiListCost(input.tier, input.expectedUsage),
        );
        if (!this.hasConfiguredPlanLimit(input.seat)) {
          return yield* Effect.fail(
            new GatewayError(
              503,
              "SEAT_PLAN_LIMIT_REQUIRED",
              input.seat === "claude"
                ? "Claude admission requires a positive monthly plan-credit limit"
                : "Codex admission requires a positive rolling call or token limit",
            ),
          );
        }
        if (input.seat === "claude" && this.limits.claudeMonthlyCreditUsd > 0) {
          const reserved = this.reservations
            .filter(
              (reservation) =>
                reservation.seat === "claude" &&
                this.monthKey(reservation.at) === this.monthKey(at),
            )
            .reduce((total, reservation) => total + reservation.expectedPlanCreditUsd, 0);
          const projected = this.monthlySeatUsage("claude", at) + reserved + expectedPlanCreditUsd;
          if (projected > this.limits.claudeMonthlyCreditUsd) {
            return yield* Effect.fail(this.exhaustedError("claude", this.headroom("claude", at)));
          }
        }
        if (input.seat === "codex") {
          const window = this.seatWindow("codex", at);
          const reserved = this.reservations.filter((reservation) => reservation.seat === "codex");
          const projectedCalls = window.calls + reserved.length + 1;
          const projectedTokens =
            window.tokens +
            reserved.reduce((total, reservation) => total + reservation.expectedTokens, 0) +
            expectedTokens;
          if (
            (this.limits.codexWindowCalls > 0 && projectedCalls > this.limits.codexWindowCalls) ||
            (this.limits.codexWindowTokens > 0 && projectedTokens > this.limits.codexWindowTokens)
          ) {
            return yield* Effect.fail(this.exhaustedError("codex", this.headroom("codex", at)));
          }
        }
        const reservation: PlanReservation = {
          id: `reservation_${crypto.randomUUID()}`,
          seat: input.seat,
          at,
          expiresAt: at + Math.max(1_000, input.ttlMs ?? 10 * 60 * 1_000),
          expectedTokens,
          expectedPlanCreditUsd,
        };
        this.reservations.push(reservation);
        yield* this.repository
          .save(this.persisted())
          .pipe(Effect.tapError(() => Effect.sync(() => this.restore(previous))));
        return reservation;
      }),
    );
  }

  reconcile(
    reservation: PlanReservation,
    input: UsageAccountingInput,
  ): Effect.Effect<UsageAccountingResult, GatewayError> {
    return this.persistence.withPermit(
      Effect.gen({ self: this }, function* () {
        const previous = this.persisted();
        const index = this.reservations.findIndex((candidate) => candidate.id === reservation.id);
        if (index < 0) {
          return yield* Effect.fail(
            new GatewayError(
              500,
              "PLAN_RESERVATION_MISSING",
              `Usage reservation ${reservation.id} is no longer active`,
            ),
          );
        }
        if (input.seat !== reservation.seat) {
          return yield* Effect.fail(
            new GatewayError(
              500,
              "PLAN_RESERVATION_SEAT_MISMATCH",
              `Usage reservation ${reservation.id} belongs to ${reservation.seat}, not ${input.seat}`,
            ),
          );
        }
        this.reservations.splice(index, 1);
        const result = this.applyRecord(input, input.at ?? (yield* Clock.currentTimeMillis));
        yield* this.repository
          .save(this.persisted())
          .pipe(Effect.tapError(() => Effect.sync(() => this.restore(previous))));
        return result;
      }),
    );
  }

  refund(reservation: PlanReservation): Effect.Effect<void, GatewayError> {
    return this.persistence.withPermit(
      Effect.gen({ self: this }, function* () {
        const index = this.reservations.findIndex((candidate) => candidate.id === reservation.id);
        if (index < 0) return;
        const previous = this.persisted();
        this.reservations.splice(index, 1);
        yield* this.repository
          .save(this.persisted())
          .pipe(Effect.tapError(() => Effect.sync(() => this.restore(previous))));
      }),
    );
  }

  admit(seat: SeatKind, at = Date.now()): Effect.Effect<void, GatewayError> {
    return Effect.suspend(() => {
      if (seat !== "claude" && seat !== "codex") return Effect.void;
      if (!this.hasConfiguredPlanLimit(seat)) {
        return Effect.fail(
          new GatewayError(
            503,
            "SEAT_PLAN_LIMIT_REQUIRED",
            `${seat} admission requires an explicit positive plan limit`,
          ),
        );
      }
      const headroom = this.headroom(seat, at);
      const exhausted =
        headroom.remainingCreditUsd === 0 ||
        headroom.remainingCalls === 0 ||
        headroom.remainingTokens === 0;
      return exhausted ? Effect.fail(this.exhaustedError(seat, headroom)) : Effect.void;
    });
  }

  isExhausted(seat: SeatKind, at = Date.now()): boolean {
    if (seat !== "claude" && seat !== "codex") return false;
    if (!this.hasConfiguredPlanLimit(seat)) return true;
    const headroom = this.headroom(seat, at);
    return (
      headroom.remainingCreditUsd === 0 ||
      headroom.remainingCalls === 0 ||
      headroom.remainingTokens === 0
    );
  }

  monthlySeatUsage(seat: SeatKind, at = Date.now()): number {
    const current = this.monthlyUsage.get(seat);
    return current?.month === this.monthKey(at) ? current.usd : 0;
  }

  private hasConfiguredPlanLimit(seat: SeatKind): boolean {
    if (seat === "claude") return this.limits.claudeMonthlyCreditUsd > 0;
    if (seat === "codex") {
      return this.limits.codexWindowCalls > 0 || this.limits.codexWindowTokens > 0;
    }
    return true;
  }

  seatWindow(
    seat: SeatKind,
    at = Date.now(),
  ): {
    readonly calls: number;
    readonly tokens: number;
    readonly resetsAt: string;
  } {
    this.prune(at);
    const entries = this.entries.filter((entry) => entry.seat === seat);
    const oldest = entries[0]?.at ?? at;
    return {
      calls: entries.length,
      tokens: entries.reduce((total, entry) => total + entry.tokens, 0),
      resetsAt: new Date(oldest + this.limits.codexWindowMs).toISOString(),
    };
  }

  headroom(seat: SeatKind, at = Date.now()): SeatHeadroomSnapshot {
    this.prune(at);
    if (seat === "claude") {
      const used = this.monthlySeatUsage(seat, at);
      const reservations = this.reservations.filter(
        (reservation) =>
          reservation.seat === seat && this.monthKey(reservation.at) === this.monthKey(at),
      );
      const reservedCreditUsd = reservations.reduce(
        (total, reservation) => total + reservation.expectedPlanCreditUsd,
        0,
      );
      const nextMonth = new Date(at);
      nextMonth.setUTCMonth(nextMonth.getUTCMonth() + 1, 1);
      nextMonth.setUTCHours(0, 0, 0, 0);
      const resetsAt = Math.min(
        nextMonth.getTime(),
        ...reservations.map((reservation) => reservation.expiresAt),
      );
      return {
        kind: "monthly-plan-credit",
        durable: this.durable,
        estimated: true,
        resetsAt: new Date(resetsAt).toISOString(),
        creditLimitUsd: this.limits.claudeMonthlyCreditUsd,
        ...(this.limits.claudeMonthlyCreditUsd > 0
          ? {
              remainingCreditUsd: Math.max(
                0,
                this.limits.claudeMonthlyCreditUsd - used - reservedCreditUsd,
              ),
            }
          : {}),
      };
    }
    if (seat === "codex") {
      const window = this.seatWindow(seat, at);
      const reservations = this.reservations.filter((reservation) => reservation.seat === seat);
      const reservedTokens = reservations.reduce(
        (total, reservation) => total + reservation.expectedTokens,
        0,
      );
      const resetsAt = Math.min(
        Date.parse(window.resetsAt),
        ...reservations.map((reservation) => reservation.expiresAt),
      );
      return {
        kind: "rolling-plan-window",
        durable: this.durable,
        estimated: true,
        resetsAt: new Date(resetsAt).toISOString(),
        callLimit: this.limits.codexWindowCalls,
        tokenLimit: this.limits.codexWindowTokens,
        ...(this.limits.codexWindowCalls > 0
          ? {
              remainingCalls: Math.max(
                0,
                this.limits.codexWindowCalls - window.calls - reservations.length,
              ),
            }
          : {}),
        ...(this.limits.codexWindowTokens > 0
          ? {
              remainingTokens: Math.max(
                0,
                this.limits.codexWindowTokens - window.tokens - reservedTokens,
              ),
            }
          : {}),
      };
    }
    return {
      kind: seat === "api" ? "metered-cash" : "unlimited",
      durable: this.durable,
      estimated: true,
      resetsAt: this.seatWindow(seat, at).resetsAt,
    };
  }

  snapshot(): SavingsSnapshot {
    return { ...this.totals };
  }

  private applyRecord(input: UsageAccountingInput, at: number): UsageAccountingResult {
    const usage: SeatUsage = {
      inputTokens: nonNegativeInteger(input.usage.inputTokens),
      outputTokens: nonNegativeInteger(input.usage.outputTokens),
      ...(input.usage.cachedInputTokens === undefined
        ? {}
        : { cachedInputTokens: nonNegativeInteger(input.usage.cachedInputTokens) }),
    };
    const actualCostUsd = nonNegative(input.actualCostUsd);
    const planCreditUsd = nonNegative(input.planCreditUsd);
    const apiListCostUsd = nonNegative(estimateApiListCost(input.tier, usage));
    const savedUsd = Math.max(0, apiListCostUsd - actualCostUsd);
    const budgetUsageUsd = input.seat === "api" ? actualCostUsd : planCreditUsd;

    this.prune(at);
    if (!input.cacheHit) {
      this.entries.push({
        seat: input.seat,
        at,
        tokens: usage.inputTokens + usage.outputTokens,
        outcome: input.outcome ?? "success",
        ...(input.failureCode === undefined
          ? {}
          : { failureCode: safeFailureCode(input.failureCode) }),
      });
    }
    const budgetUsedUsd = input.cacheHit
      ? this.monthlySeatUsage(input.seat, at)
      : this.addMonthlyUsage(input.seat, budgetUsageUsd, at);
    this.totals = {
      requests: this.totals.requests + 1,
      cacheHits: this.totals.cacheHits + (input.cacheHit ? 1 : 0),
      inputTokens: this.totals.inputTokens + usage.inputTokens,
      outputTokens: this.totals.outputTokens + usage.outputTokens,
      actualCostUsd: this.totals.actualCostUsd + actualCostUsd,
      planCreditUsd: this.totals.planCreditUsd + planCreditUsd,
      apiListEquivalentUsd: this.totals.apiListEquivalentUsd + apiListCostUsd,
      savedVsApiUsd: this.totals.savedVsApiUsd + savedUsd,
    };
    return { apiListCostUsd, savedUsd, budgetUsedUsd };
  }

  private prune(at: number): void {
    const cutoff = at - this.limits.codexWindowMs;
    this.entries = this.entries.filter((entry) => entry.at >= cutoff);
    this.reservations = this.reservations.filter((reservation) => reservation.expiresAt > at);
  }

  private addMonthlyUsage(seat: SeatKind, usd: number, at: number): number {
    const month = this.monthKey(at);
    const current = this.monthlyUsage.get(seat);
    const next = (current?.month === month ? current.usd : 0) + usd;
    this.monthlyUsage.set(seat, { month, usd: next });
    return next;
  }

  private persisted(): PersistedWindowTracker {
    return {
      version: 1,
      startedAt: this.trackedSince,
      entries: this.entries.map((entry) => ({ ...entry })),
      monthlyUsage: [...this.monthlyUsage].map(([seat, usage]) => ({ seat, ...usage })),
      reservations: this.reservations.map((reservation) => ({ ...reservation })),
      totals: { ...this.totals },
    };
  }

  private restore(persisted: PersistedWindowTracker): void {
    this.trackedSince = persisted.startedAt;
    this.entries = persisted.entries.map((entry) => ({
      seat: entry.seat,
      at: entry.at,
      tokens: entry.tokens,
      outcome: entry.outcome ?? "success",
      ...(entry.failureCode === undefined ? {} : { failureCode: entry.failureCode }),
    }));
    this.reservations = (persisted.reservations ?? []).map((reservation) => ({ ...reservation }));
    this.monthlyUsage.clear();
    for (const usage of persisted.monthlyUsage) {
      this.monthlyUsage.set(usage.seat, { month: usage.month, usd: usage.usd });
    }
    this.totals = { ...persisted.totals };
  }

  private monthKey(at: number): string {
    return new Date(at).toISOString().slice(0, 7);
  }

  private exhaustedError(seat: SeatKind, headroom: SeatHeadroomSnapshot): GatewayError {
    return new GatewayError(
      429,
      "SEAT_PLAN_WINDOW_EXHAUSTED",
      `${seat} subscription plan headroom is exhausted until ${headroom.resetsAt}`,
    );
  }
}

export class WindowTrackerService extends Context.Service<WindowTrackerService, WindowTracker>()(
  "@stavka/maskirovka/WindowTracker",
) {}

export const WindowTrackerLive: Layer.Layer<WindowTrackerService> = Layer.succeed(
  WindowTrackerService,
  new WindowTracker(),
);
