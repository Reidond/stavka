import { Context, Effect, Layer } from "effect";

import {
  GatewayError,
  seatKinds,
  tierAliases,
  type AliasResolution,
  type SeatDefinition,
  type SeatKind,
  type SeatResolution,
  type TierAlias,
} from "../domain/types";
import type { GatewayConfigRepositoryService } from "../repositories/config-repository";

export class SeatRegistry {
  private aliases: AliasResolution[];
  private killed = false;
  private readonly budgetExhausted = new Set<SeatKind>();

  constructor(
    aliases: readonly AliasResolution[],
    private readonly seats: readonly SeatDefinition[],
    private readonly repository: GatewayConfigRepositoryService,
    private readonly apiFallbackAliases: readonly AliasResolution[] = [],
  ) {
    this.aliases = [...aliases];
  }

  initialize(): Effect.Effect<void, GatewayError> {
    return this.repository.load().pipe(Effect.map((persisted) => {
      if (!persisted) return;
      this.aliases = persisted.aliases.filter(
        (alias) => tierAliases.includes(alias.tier) && seatKinds.includes(alias.seat),
      );
      this.killed = persisted.killed;
    }));
  }

  isKilled(): boolean {
    return this.killed;
  }

  listAliases(): readonly AliasResolution[] {
    return [...this.aliases];
  }

  listSeats(): readonly SeatDefinition[] {
    return this.seats.map((seat) => ({
      ...seat,
      exhausted: seat.exhausted || this.budgetExhausted.has(seat.id),
    }));
  }

  setBudgetExhausted(seat: SeatKind, exhausted: boolean): Effect.Effect<void> {
    return Effect.sync(() => {
      if (exhausted) this.budgetExhausted.add(seat);
      else this.budgetExhausted.delete(seat);
    });
  }

  resolve(
    tier: TierAlias,
    budgetPolicy: "fallback" | "stretch" = "fallback",
    excludedSeats: ReadonlySet<SeatKind> = new Set(),
  ): Effect.Effect<SeatResolution, GatewayError> {
    return Effect.suspend(() => {
      const configured = this.aliases
        .filter((alias) => alias.tier === tier)
        .sort((left, right) => this.priority(right.seat) - this.priority(left.seat));
      if (configured.length === 0) {
        return Effect.fail(new GatewayError(
          503,
          "TIER_UNRESOLVED",
          `No resolution for ${tier}`,
        ));
      }
      const selected = configured.find((alias) =>
        !excludedSeats.has(alias.seat) && this.isRoutable(alias.seat));
      if (selected) {
        return Effect.succeed(selected);
      }

      const preferred = configured[0]!;
      const exhausted = configured.some((alias) => this.isExhausted(alias.seat));
      if (exhausted && budgetPolicy === "stretch") {
        return Effect.fail(new GatewayError(
          429,
          "SEAT_BUDGET_EXHAUSTED",
          `Seat budget exhausted for ${tier}; stretch the commander tick interval`,
          [`seat=${preferred.seat}`, "policy=stretch"],
        ));
      }

      const api = this.apiFallbackAliases.find((alias) => alias.tier === tier);
      if (
        preferred.seat !== "api" &&
        !excludedSeats.has("api") &&
        api &&
        this.isRoutable("api")
      ) {
        return Effect.succeed({
          ...api,
          fallbackFromSeat: preferred.seat,
          routingReason: exhausted ? "budget-fallback" : "unavailable-fallback",
        });
      }
      return Effect.fail(new GatewayError(
        503,
        "SEAT_UNAVAILABLE",
        `No healthy seat or API fallback can serve ${tier}`,
      ));
    });
  }

  remap(
    tier: TierAlias,
    seat: SeatKind,
    model: string,
  ): Effect.Effect<readonly AliasResolution[], GatewayError> {
    return Effect.gen({ self: this }, function*() {
      if (!tierAliases.includes(tier)) {
        return yield* Effect.fail(new GatewayError(400, "UNKNOWN_TIER", "Unknown tier alias"));
      }
      if (!seatKinds.includes(seat)) {
        return yield* Effect.fail(new GatewayError(400, "UNKNOWN_SEAT", "Unknown seat"));
      }
      if (!model.trim()) {
        return yield* Effect.fail(new GatewayError(400, "INVALID_MODEL", "model is required"));
      }
      this.aliases = [
        ...this.aliases.filter((alias) => alias.tier !== tier),
        { tier, seat, model: model.trim() },
      ].sort((left, right) => left.tier.localeCompare(right.tier));
      yield* this.persist();
      return this.listAliases();
    });
  }

  setKilled(killed: boolean): Effect.Effect<boolean, GatewayError> {
    return Effect.gen({ self: this }, function*() {
      this.killed = killed;
      yield* this.persist();
      return this.killed;
    });
  }

  private persist(): Effect.Effect<void, GatewayError> {
    return this.repository.save({ aliases: this.aliases, killed: this.killed });
  }

  private priority(seat: SeatKind): number {
    return this.seats.find((candidate) => candidate.id === seat)?.priority ?? Number.MIN_SAFE_INTEGER;
  }

  private isExhausted(seat: SeatKind): boolean {
    const configured = this.seats.find((candidate) => candidate.id === seat);
    return configured?.exhausted === true || this.budgetExhausted.has(seat);
  }

  private isRoutable(seat: SeatKind): boolean {
    const configured = this.seats.find((candidate) => candidate.id === seat);
    return configured !== undefined &&
      configured.status === "healthy" &&
      !this.isExhausted(seat);
  }
}

export class SeatRegistryService extends Context.Service<SeatRegistryService, SeatRegistry>()(
  "@stavka/maskirovka/SeatRegistry",
) {}

export const SeatRegistryLive = (
  aliases: readonly AliasResolution[],
  seats: readonly SeatDefinition[],
  repository: GatewayConfigRepositoryService,
  apiFallbackAliases: readonly AliasResolution[] = [],
): Layer.Layer<SeatRegistryService, GatewayError> =>
  Layer.effect(
    SeatRegistryService,
    Effect.gen(function*() {
      const registry = new SeatRegistry(aliases, seats, repository, apiFallbackAliases);
      yield* registry.initialize();
      return registry;
    }),
  );
