import { can, type AccessIdentity } from "@stavka/access-auth";
import { DoctrineId } from "@stavka/protocol";
import { Schema } from "effect";

export const ScenarioName = Schema.Literals(["movement", "engagement", "mechanized"]);
export type ScenarioName = typeof ScenarioName.Type;

export const DoctrineName = DoctrineId;
export type DoctrineName = typeof DoctrineName.Type;

export const TimeScale = Schema.Literals([1, 10, 100]);
export type TimeScale = typeof TimeScale.Type;

export const SimulationMode = Schema.Literals(["single", "versus"]);
export type SimulationMode = typeof SimulationMode.Type;

const Seed = Schema.Number.check(
  Schema.isInt(),
  Schema.isBetween({ minimum: 1, maximum: 2_147_483_647 }),
);

const Faction = Schema.String.check(
  Schema.isTrimmed(),
  Schema.isNonEmpty(),
  Schema.isMaxLength(64),
);

export const ConfigureSimWorldInput = Schema.Struct({
  scenario: ScenarioName,
  seed: Seed,
  faction: Schema.optional(Faction),
  doctrine: Schema.optional(DoctrineName),
  timeScale: Schema.optional(TimeScale),
  mode: Schema.optional(SimulationMode),
});
export type ConfigureSimWorldInput = typeof ConfigureSimWorldInput.Type;

export const decodeConfigureSimWorldInput = Schema.decodeUnknownSync(ConfigureSimWorldInput);
export const decodePaused = Schema.decodeUnknownSync(Schema.Boolean);
export const decodeTimeScale = Schema.decodeUnknownSync(TimeScale);

/** Access roles with either operational or administrative authority may mutate a simulation. */
export const hasControlPermission = (identity: AccessIdentity): boolean =>
  can(identity, "operate") || can(identity, "admin");
