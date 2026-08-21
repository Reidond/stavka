import { Schema } from "effect";

export const Side = Schema.Literals(["blue", "red"]);
export type Side = typeof Side.Type;

export const Vec2 = Schema.Struct({ x: Schema.Number, y: Schema.Number });
export type Vec2 = typeof Vec2.Type;

export const Unit = Schema.Struct({
  id: Schema.String,
  side: Side,
  hp: Schema.Number,
  attack: Schema.Number,
  position: Vec2,
});
export type Unit = typeof Unit.Type;

export const Objective = Schema.Struct({
  id: Schema.String,
  position: Vec2,
  owner: Schema.Literals(["blue", "red", "neutral"]),
});
export type Objective = typeof Objective.Type;

export const Observation = Schema.Struct({
  tick: Schema.Number,
  units: Schema.Array(Unit),
  objectives: Schema.Array(Objective),
});
export type Observation = typeof Observation.Type;

export const Order = Schema.Union([
  Schema.Struct({ unitId: Schema.String, type: Schema.Literal("move"), target: Vec2 }),
  Schema.Struct({ unitId: Schema.String, type: Schema.Literal("attack"), targetId: Schema.String }),
  Schema.Struct({ unitId: Schema.String, type: Schema.Literal("hold") }),
]);
export type Order = typeof Order.Type;

export const Decision = Schema.Struct({ orders: Schema.Array(Order) });
export type Decision = typeof Decision.Type;

export interface MatchMetrics {
  readonly score: number;
  readonly won: boolean;
  readonly invalidDecisions: number;
  readonly decisionCount: number;
  readonly decisionLatenciesMs: readonly number[];
}
