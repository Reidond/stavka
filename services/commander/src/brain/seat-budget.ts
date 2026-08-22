import type { SeatRegistration } from "../state/types";

const roundedUsd = (value: number): number =>
  Math.round(Math.max(0, value) * 1_000_000) / 1_000_000;

export const utcBudgetPeriod = (timestamp = Date.now()): string =>
  new Date(timestamp).toISOString().slice(0, 7);

export const rollSeatBudgetPeriod = (seat: SeatRegistration, period: string): SeatRegistration =>
  seat.budgetPeriod === period
    ? seat
    : {
        ...seat,
        budgetPeriod: period,
        spentUsd: 0,
        reservedUsd: 0,
        exhausted: false,
      };

export interface SeatBudgetMutation {
  readonly accepted: boolean;
  readonly seats: readonly SeatRegistration[];
}

/**
 * Reserve a conservative upper bound before starting provider work. The
 * registry Durable Object serializes this transition across all factions.
 */
export const reserveSeatBudgetState = (
  seats: readonly SeatRegistration[],
  seatId: string,
  amountUsd: number,
  period: string,
): SeatBudgetMutation => {
  const reservation = roundedUsd(amountUsd);
  let accepted = false;
  const next = seats.map((candidate): SeatRegistration => {
    if (candidate.id !== seatId) return candidate;
    const seat = rollSeatBudgetPeriod(candidate, period);
    const available = Math.max(0, seat.monthlyBudgetUsd - seat.spentUsd - seat.reservedUsd);
    if (reservation <= 0 || reservation > available) return seat;
    accepted = true;
    const reservedUsd = roundedUsd(seat.reservedUsd + reservation);
    return {
      ...seat,
      reservedUsd,
      exhausted: seat.spentUsd + reservedUsd >= seat.monthlyBudgetUsd,
    };
  });
  return { accepted, seats: next };
};

/** Reconcile one reservation with actual spend, or refund it on failure. */
export const reconcileSeatBudgetState = (
  seats: readonly SeatRegistration[],
  seatId: string,
  reservedAmountUsd: number,
  actualCostUsd: number,
  period: string,
): readonly SeatRegistration[] =>
  seats.map((candidate): SeatRegistration => {
    if (candidate.id !== seatId) return candidate;
    const seat = rollSeatBudgetPeriod(candidate, period);
    const reservedUsd = roundedUsd(seat.reservedUsd - roundedUsd(reservedAmountUsd));
    const spentUsd = roundedUsd(seat.spentUsd + roundedUsd(actualCostUsd));
    return {
      ...seat,
      reservedUsd,
      spentUsd,
      exhausted: spentUsd + reservedUsd >= seat.monthlyBudgetUsd,
    };
  });
