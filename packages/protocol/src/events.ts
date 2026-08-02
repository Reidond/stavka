import { Schema } from "effect";

import { Vector3 } from "./commands";

const NonEmptyString = Schema.String.pipe(Schema.check(Schema.isTrimmed(), Schema.isNonEmpty()));
const FiniteNumber = Schema.Number.pipe(Schema.check(Schema.isFinite()));
const NonNegativeFinite = FiniteNumber.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(0)));
const Natural = NonNegativeFinite.pipe(Schema.check(Schema.isInt()));
const ReportStrength = Schema.Struct({ current: Natural, max: Natural }).check(
  Schema.makeFilter((strength) =>
    strength.current <= strength.max
      ? undefined
      : { path: ["current"], issue: "current strength cannot exceed maximum strength" },
  ),
);

export const EventSignificance = Schema.Literals(["routine", "notable", "urgent"]);
export type EventSignificance = typeof EventSignificance.Type;

export const GameEvent = Schema.Struct({
  id: NonEmptyString,
  type: NonEmptyString,
  timestamp: NonNegativeFinite,
  significance: EventSignificance,
  group_id: Schema.optional(NonEmptyString),
  objective_id: Schema.optional(NonEmptyString),
  position: Schema.optional(Vector3),
  details: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
});
export type GameEvent = typeof GameEvent.Type;

export const Contact = Schema.Struct({
  type: Schema.Literals(["infantry", "vehicle", "unknown"]),
  estimated_count: Natural,
  bearing: FiniteNumber.pipe(Schema.check(Schema.isBetween({ minimum: 0, maximum: 360 }))),
  distance: NonNegativeFinite,
});
export type Contact = typeof Contact.Type;

export const SergeantReport = Schema.Struct({
  type: Schema.Literal("sergeant_report"),
  timestamp: NonNegativeFinite,
  payload: Schema.Struct({
    group_id: NonEmptyString,
    report_type: Schema.Literals(["sitrep", "contact", "casualty", "objective", "support_request"]),
    position: Vector3,
    strength: ReportStrength,
    status: Schema.Literals(["idle", "moving", "engaged", "boarding", "mounted", "destroyed"]),
    contacts: Schema.Array(Contact),
    ammo_status: Schema.Literals(["critical", "low", "adequate", "full"]),
    morale: Schema.Literals(["broken", "shaken", "steady", "confident"]),
    local_decision: NonEmptyString,
    request: Schema.optional(
      Schema.Literals([
        "none",
        "requesting_support",
        "requesting_reinforcement",
        "requesting_extraction",
      ]),
    ),
  }),
});
export type SergeantReport = typeof SergeantReport.Type;
