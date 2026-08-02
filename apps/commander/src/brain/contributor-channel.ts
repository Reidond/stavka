import { Effect, Schema } from "effect";

import { AiDecision, type AiDecision as AiDecisionType } from "./llm-client";
import type { SeatRegistration } from "../state/types";

export const decodeContributorDecision = (
  value: unknown,
): Effect.Effect<AiDecisionType, unknown> => Schema.decodeUnknownEffect(AiDecision)(value);

export const isActiveSeatConnection = (
  seats: readonly SeatRegistration[],
  seatId: string,
  connectionId: string,
): boolean => seats.some((seat) =>
  seat.id === seatId && seat.activeConnectionId === connectionId);
