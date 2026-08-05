import { CommandResult, DoctrineId, GameSnapshot, SergeantReport } from "@stavka/protocol";
import { Schema } from "effect";

import { EventFilterState } from "./events";
import { SergeantReporterState } from "./sergeants";

export const REST_COMMANDER_LINK_STATE_VERSION = 1 as const;

const FiniteNumber = Schema.Number.pipe(Schema.check(Schema.isFinite()));
const NonNegativeFinite = FiniteNumber.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(0)));
const Natural = NonNegativeFinite.pipe(Schema.check(Schema.isInt()));
const PositiveFinite = FiniteNumber.pipe(Schema.check(Schema.isGreaterThan(0)));
const PositiveInteger = PositiveFinite.pipe(Schema.check(Schema.isInt()));
const NonEmptyString = Schema.String.pipe(Schema.check(Schema.isTrimmed(), Schema.isNonEmpty()));

export const RestCommanderLinkCommandLifecycle = Schema.Struct({
  result: CommandResult,
  accepted_sent: Schema.Boolean,
  // The execution descriptor is kept alongside the result, rather than only
  // in memory, so a checkpoint/restart can continue observing an accepted
  // order without re-running it. Older v1 checkpoints legitimately lack it.
  execution: Schema.optional(
    Schema.Union([
      Schema.Struct({ kind: Schema.Literal("immediate") }),
      Schema.Struct({
        kind: Schema.Literal("waypoint"),
        group_id: NonEmptyString,
        waypoint_kind: Schema.Literals(["forced_move", "attack", "defend", "patrol", "sweep"]),
        destination: Schema.Tuple([FiniteNumber, FiniteNumber, FiniteNumber]),
        radius: NonNegativeFinite,
        issued_at_tick: Natural,
      }),
    ]),
  ),
});
export type RestCommanderLinkCommandLifecycle = typeof RestCommanderLinkCommandLifecycle.Type;

export const RestCommanderLinkState = Schema.Struct({
  version: Schema.Literal(REST_COMMANDER_LINK_STATE_VERSION),
  session_id: NonEmptyString,
  mission_id: NonEmptyString,
  mission_name: NonEmptyString,
  faction: NonEmptyString,
  mission_epoch: Natural,
  map_name: NonEmptyString,
  doctrine: Schema.optional(DoctrineId),
  full_snapshot_interval: PositiveInteger,
  detection_range_meters: PositiveFinite,
  contact_expiry_seconds: PositiveFinite,
  delta_movement_threshold_meters: NonNegativeFinite,
  connected: Schema.Boolean,
  tick_id: Natural,
  last_full_tick: Natural,
  last_snapshot: Schema.optional(GameSnapshot),
  force_full: Schema.Boolean,
  pending_results: Schema.Array(CommandResult),
  // Optional for backward-compatible restore of v1 checkpoints created
  // before the execution ledger was introduced.
  command_ledger: Schema.optional(Schema.Array(RestCommanderLinkCommandLifecycle)),
  pending_reports: Schema.Array(SergeantReport),
  tick_rate_hint: PositiveFinite,
  next_tick_at: FiniteNumber,
  event_filter: EventFilterState,
  sergeant_reporter: SergeantReporterState,
}).check(
  Schema.makeFilter((state) =>
    state.last_full_tick <= state.tick_id
      ? undefined
      : { path: ["last_full_tick"], issue: "last full tick cannot exceed current tick" },
  ),
);
export type RestCommanderLinkState = typeof RestCommanderLinkState.Type;
