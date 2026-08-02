import type { Command, TickRequest, TickResponse } from "@stavka/protocol";

/** Explicit boundary for the pre-v1 Test 12 harness. New code never emits this shape. */
export interface LegacyTest12Request {
  readonly tick: number;
  readonly groups: readonly {
    readonly id: string;
    readonly pos: readonly [number, number, number];
    readonly alive: number;
  }[];
}

export const toLegacyTest12Request = (request: TickRequest): LegacyTest12Request => {
  const snapshot = request.type === "full" ? request.snapshot : request.snapshot;
  if (!snapshot) throw new Error("A full snapshot is required for the legacy Test 12 adapter");
  return {
    tick: request.tick_id,
    groups: snapshot.friendly_groups.map((group) => ({
      id: group.id,
      pos: [...group.position],
      alive: group.strength.current,
    })),
  };
};

export const fromLegacyTest12Response = (
  tickId: number,
  commands: readonly Command[],
): TickResponse => ({
  protocol_version: 1,
  tick_id: tickId,
  commands: [...commands],
  tick_rate_hint: 1_000,
  request_full_snapshot: false,
  config_updates: {},
  commander_status: {
    connected: true,
    mode: "rule",
    doctrine: "balanced",
    decision_pending: false,
    active_groups: 0,
  },
});
