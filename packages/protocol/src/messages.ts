import { Schema } from "effect";

import { Command, CommandResult } from "./commands";
import { DoctrineId } from "./doctrine";
import { GameEvent, SergeantReport } from "./events";
import { GameSnapshot, MapBriefing, StateDelta } from "./state";

export const PROTOCOL_VERSION = 1 as const;

const NonEmptyString = Schema.String.pipe(Schema.check(Schema.isTrimmed(), Schema.isNonEmpty()));
const FiniteNumber = Schema.Number.pipe(Schema.check(Schema.isFinite()));
const NonNegativeFinite = FiniteNumber.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(0)));
const NonNegativeInteger = NonNegativeFinite.pipe(Schema.check(Schema.isInt()));
const PositiveFinite = FiniteNumber.pipe(Schema.check(Schema.isGreaterThan(0)));
const PositiveInteger = PositiveFinite.pipe(Schema.check(Schema.isInt()));

const CommandResults = Schema.Array(CommandResult).check(
  Schema.makeFilter((results) => {
    const commandIds = new Set<string>();
    for (let index = 0; index < results.length; index += 1) {
      const result = results[index];
      if (!result) continue;
      if (commandIds.has(result.command_id)) {
        return {
          path: [index, "command_id"],
          issue: "command_id must be unique within tick request command_results",
        };
      }
      commandIds.add(result.command_id);
    }
    return undefined;
  }),
);

const TickBase = {
  protocol_version: Schema.Literal(PROTOCOL_VERSION),
  session_id: NonEmptyString,
  faction: NonEmptyString,
  /** Native clients with a three-header limit carry epoch in the body. */
  mission_epoch: Schema.optional(NonNegativeInteger),
  tick_id: NonNegativeInteger,
  timestamp: NonNegativeFinite,
  full_snapshot_interval: PositiveInteger,
  sergeant_reports: Schema.Array(SergeantReport),
  events: Schema.Array(GameEvent),
  command_results: CommandResults,
};

export const FullTickRequest = Schema.Struct({
  ...TickBase,
  type: Schema.Literal("full"),
  snapshot: GameSnapshot,
});

export const DeltaTickRequest = Schema.Struct({
  ...TickBase,
  type: Schema.Literal("delta"),
  since_tick: NonNegativeInteger,
  changes: StateDelta,
  snapshot: Schema.optional(GameSnapshot),
}).check(
  Schema.makeFilter((request) =>
    request.since_tick < request.tick_id
      ? undefined
      : { path: ["since_tick"], issue: "delta since_tick must precede tick_id" },
  ),
);

export const TickRequest = Schema.Union([FullTickRequest, DeltaTickRequest]);
export type TickRequest = typeof TickRequest.Type;

export const CommanderDecisionSummary = Schema.Struct({
  id: NonEmptyString,
  timestamp: NonEmptyString,
  summary: Schema.String,
  model: NonEmptyString,
  latency_ms: NonNegativeFinite,
  cost_usd: NonNegativeFinite,
});
export type CommanderDecisionSummary = typeof CommanderDecisionSummary.Type;

export const CommanderCostAggregate = Schema.Struct({
  agent_tier: Schema.Literals(["commander", "sergeant"]),
  model: NonEmptyString,
  calls: NonNegativeInteger,
  input_tokens: NonNegativeInteger,
  output_tokens: NonNegativeInteger,
  cost_usd: NonNegativeFinite,
});
export type CommanderCostAggregate = typeof CommanderCostAggregate.Type;

export const CommanderStatus = Schema.Struct({
  connected: Schema.Boolean,
  mode: Schema.Literals(["rule", "llm", "degraded"]),
  doctrine: NonEmptyString,
  decision_pending: Schema.Boolean,
  active_groups: NonNegativeInteger,
  last_decision: Schema.optional(CommanderDecisionSummary),
  cost_aggregates: Schema.optional(Schema.Array(CommanderCostAggregate)),
});
export type CommanderStatus = typeof CommanderStatus.Type;

export const CommanderConfigUpdates = Schema.Struct({
  full_snapshot_interval: Schema.optional(PositiveInteger),
  detection_range_meters: Schema.optional(PositiveFinite),
  contact_expiry_seconds: Schema.optional(PositiveFinite),
  delta_movement_threshold_meters: Schema.optional(NonNegativeFinite),
});
export type CommanderConfigUpdates = typeof CommanderConfigUpdates.Type;

export const TickResponse = Schema.Struct({
  protocol_version: Schema.Literal(PROTOCOL_VERSION),
  tick_id: NonNegativeInteger,
  commands: Schema.Array(Command),
  tick_rate_hint: PositiveFinite,
  request_full_snapshot: Schema.Boolean,
  config_updates: CommanderConfigUpdates,
  commander_status: CommanderStatus,
}).check(
  Schema.makeFilter((response) => {
    const commandIds = new Set<string>();
    for (let index = 0; index < response.commands.length; index += 1) {
      const command = response.commands[index];
      if (!command) continue;
      if (commandIds.has(command.command_id)) {
        return {
          path: ["commands", index, "command_id"],
          issue: "command_id must be unique within a tick response",
        };
      }
      commandIds.add(command.command_id);
    }
    return undefined;
  }),
);
export type TickResponse = typeof TickResponse.Type;

export const ConnectRequest = Schema.Struct({
  protocol_version: Schema.Literal(PROTOCOL_VERSION),
  session_id: NonEmptyString,
  mission_id: NonEmptyString,
  mission_epoch: NonNegativeInteger,
  faction: NonEmptyString,
  map_name: NonEmptyString,
  doctrine: Schema.optional(DoctrineId),
});
export type ConnectRequest = typeof ConnectRequest.Type;

export const ConnectResponse = Schema.Struct({
  protocol_version: Schema.Literal(PROTOCOL_VERSION),
  accepted: Schema.Boolean,
  request_full_snapshot: Schema.Boolean,
  tick_rate_hint: PositiveFinite,
});
export type ConnectResponse = typeof ConnectResponse.Type;

export const DisconnectRequest = Schema.Struct({
  protocol_version: Schema.Literal(PROTOCOL_VERSION),
  session_id: NonEmptyString,
  faction: NonEmptyString,
  mission_epoch: Schema.optional(NonNegativeInteger),
  reason: Schema.optional(NonEmptyString),
});
export type DisconnectRequest = typeof DisconnectRequest.Type;

export const MapUploadRequest = Schema.Struct({
  protocol_version: Schema.Literal(PROTOCOL_VERSION),
  session_id: NonEmptyString,
  mission_id: NonEmptyString,
  mission_epoch: NonNegativeInteger,
  faction: NonEmptyString,
  briefing: MapBriefing,
});
export type MapUploadRequest = typeof MapUploadRequest.Type;

export const ErrorEnvelope = Schema.Struct({
  error: Schema.Struct({
    code: NonEmptyString,
    message: Schema.String,
    request_id: NonEmptyString,
    issues: Schema.Array(Schema.String),
  }),
});
export type ErrorEnvelope = typeof ErrorEnvelope.Type;

export const decodeTickRequest = Schema.decodeUnknownSync(TickRequest, {
  onExcessProperty: "error",
});
export const decodeTickResponse = Schema.decodeUnknownSync(TickResponse, {
  onExcessProperty: "error",
});
export const decodeConnectRequest = Schema.decodeUnknownSync(ConnectRequest, {
  onExcessProperty: "error",
});
export const decodeDisconnectRequest = Schema.decodeUnknownSync(DisconnectRequest, {
  onExcessProperty: "error",
});
export const decodeMapUploadRequest = Schema.decodeUnknownSync(MapUploadRequest, {
  onExcessProperty: "error",
});
