import { Context, Effect, Layer } from "effect";

import {
  GatewayError,
  type SeatInvocation,
  type SeatKind,
  type SeatResult,
} from "../domain/types";

export interface SeatAdapter {
  readonly id: SeatKind;
  readonly invoke: (request: SeatInvocation) => Effect.Effect<SeatResult, GatewayError>;
}

export interface SeatAdaptersService {
  readonly get: (seat: SeatKind) => SeatAdapter | undefined;
  readonly list: () => readonly SeatAdapter[];
}

export class SeatAdapters extends Context.Service<SeatAdapters, SeatAdaptersService>()(
  "@stavka/maskirovka/SeatAdapters",
) {}

export const SeatAdaptersLive = (
  adapters: readonly SeatAdapter[],
): Layer.Layer<SeatAdapters> => {
  const byId = new Map(adapters.map((adapter) => [adapter.id, adapter]));
  return Layer.succeed(SeatAdapters, {
    get: (seat) => byId.get(seat),
    list: () => [...byId.values()],
  });
};

export const estimateTokens = (value: string): number => Math.max(1, Math.ceil(value.length / 4));
