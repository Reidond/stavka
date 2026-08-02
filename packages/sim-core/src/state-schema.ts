import { GameEvent, ObjectiveState, Vector3 } from "@stavka/protocol";
import { Schema } from "effect";

import { hashTerrainSamples } from "./terrain";
import { FIXED_STEP_MS, SIM_VERSION, type SimWorldState } from "./types";

const FiniteNumber = Schema.Number.pipe(Schema.check(Schema.isFinite()));
const NonNegativeFinite = FiniteNumber.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(0)));
const Integer = FiniteNumber.pipe(Schema.check(Schema.isInt()));
const Natural = Integer.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(0)));
const PositiveInteger = Integer.pipe(Schema.check(Schema.isGreaterThan(0)));
const Uint32 = Natural.pipe(Schema.check(Schema.isLessThanOrEqualTo(0xffff_ffff)));
const NonEmptyString = Schema.String.pipe(Schema.check(Schema.isTrimmed(), Schema.isNonEmpty()));

export const SimWaypointSchema = Schema.Struct({
  kind: Schema.Literals(["move", "forced_move", "attack", "defend", "patrol", "sweep"]),
  destination: Vector3,
  radius: NonNegativeFinite,
  issuedAtTick: Natural,
  patrolCenter: Schema.optional(Vector3),
}).check(
  Schema.makeFilter((waypoint) => {
    if (waypoint.kind === "patrol" && waypoint.patrolCenter === undefined) {
      return { path: ["patrolCenter"], issue: "patrol waypoints require a patrol center" };
    }
    if (waypoint.kind !== "patrol" && waypoint.patrolCenter !== undefined) {
      return {
        path: ["patrolCenter"],
        issue: "only patrol waypoints may carry a patrol center",
      };
    }
    return undefined;
  }),
);

export const SimAgentSchema = Schema.Struct({
  id: NonEmptyString,
  health: NonNegativeFinite,
  offset: Vector3,
});

export const SimGroupSchema = Schema.Struct({
  id: NonEmptyString,
  faction: NonEmptyString,
  template: NonEmptyString,
  position: Vector3,
  maxStrength: PositiveInteger,
  agents: Schema.Array(SimAgentSchema),
  status: Schema.Literals([
    "initializing",
    "idle",
    "moving",
    "engaged",
    "defending",
    "patrolling",
    "boarding",
    "mounted",
    "dismounting",
  ]),
  behavior: Schema.optional(NonEmptyString),
  targetObjectiveId: Schema.optional(NonEmptyString),
  order: Schema.optional(SimWaypointSchema),
  materializeAtMs: Natural,
  mountedVehicleId: Schema.optional(NonEmptyString),
  transitionAtMs: Schema.optional(Natural),
  transitionStallAtMs: Schema.optional(Natural),
  transitionWasStalled: Schema.optional(Schema.Boolean),
}).check(
  Schema.makeFilter((group) => {
    const issues: Schema.FilterIssue[] = [];
    if (group.agents.length > group.maxStrength) {
      issues.push({ path: ["agents"], issue: "agent roster cannot exceed maximum strength" });
    }
    const transitioning = group.status === "boarding" || group.status === "dismounting";
    if (transitioning !== (group.transitionAtMs !== undefined)) {
      issues.push({
        path: ["transitionAtMs"],
        issue: "boarding and dismounting groups require exactly one active transition",
      });
    }
    const vehicleState =
      group.status === "boarding" || group.status === "mounted" || group.status === "dismounting";
    if (vehicleState && group.mountedVehicleId === undefined) {
      issues.push({
        path: ["mountedVehicleId"],
        issue: "vehicle lifecycle status requires a mounted vehicle",
      });
    }
    return issues;
  }),
);

export const SimVehicleSchema = Schema.Struct({
  id: NonEmptyString,
  template: NonEmptyString,
  capacity: PositiveInteger,
  position: Vector3,
  health: NonNegativeFinite,
  occupiedByGroupId: Schema.optional(NonEmptyString),
  stallSequence: Schema.optional(Natural),
  nextStallAtMs: Schema.optional(Natural),
  stallUntilMs: Schema.optional(Natural),
});

export const CombatExchangeSchema = Schema.Struct({
  key: NonEmptyString,
  groupA: NonEmptyString,
  groupB: NonEmptyString,
  accumulatedMs: NonNegativeFinite,
  contactReported: Schema.Boolean,
  reportingGroupId: Schema.optional(NonEmptyString),
  targetGroupId: Schema.optional(NonEmptyString),
}).check(
  Schema.makeFilter((exchange) => {
    const hasDirection =
      exchange.reportingGroupId !== undefined && exchange.targetGroupId !== undefined;
    if (exchange.contactReported !== hasDirection) {
      return {
        path: ["contactReported"],
        issue: "reported contacts require both reporting and target groups",
      };
    }
    if (exchange.groupA === exchange.groupB) {
      return { path: ["groupB"], issue: "combat exchange groups must be distinct" };
    }
    return undefined;
  }),
);

export const TerrainGridSchema = Schema.Struct({
  width: PositiveInteger,
  height: PositiveInteger,
  cellSizeMeters: Schema.Literal(10),
  samples: Schema.Array(FiniteNumber),
  contentHash: NonEmptyString,
}).check(
  Schema.makeFilter((terrain) => {
    const issues: Schema.FilterIssue[] = [];
    if (terrain.samples.length !== terrain.width * terrain.height) {
      issues.push({
        path: ["samples"],
        issue: "terrain sample count must equal width multiplied by height",
      });
    }
    if (
      terrain.contentHash !==
      hashTerrainSamples(terrain.samples, terrain.width, terrain.height, terrain.cellSizeMeters)
    ) {
      issues.push({ path: ["contentHash"], issue: "terrain content hash does not match samples" });
    }
    return issues;
  }),
);

export const SimObjectiveSchema = Schema.Struct({
  ...ObjectiveState.fields,
  ownerFaction: Schema.optional(NonEmptyString),
  capturingFaction: Schema.optional(NonEmptyString),
});

export const SimWorldStateSchema = Schema.Struct({
  version: Schema.Literal(SIM_VERSION),
  seed: Integer,
  rngState: Uint32,
  tick: Natural,
  timeMs: Natural,
  nextGroupId: PositiveInteger,
  nextEventId: PositiveInteger,
  groups: Schema.Record(Schema.String, SimGroupSchema),
  vehicles: Schema.Record(Schema.String, SimVehicleSchema),
  objectives: Schema.Record(Schema.String, SimObjectiveSchema),
  engagements: Schema.Record(Schema.String, CombatExchangeSchema),
  events: Schema.Array(GameEvent),
  terrain: TerrainGridSchema,
  quirks: Schema.Struct({
    brokenMoveWaypoint: Schema.Boolean,
    recoverableVehicleStalls: Schema.Boolean,
  }),
}).check(
  Schema.makeFilter((world) => {
    const issues: Schema.FilterIssue[] = [];
    if (world.timeMs !== world.tick * FIXED_STEP_MS) {
      issues.push({ path: ["timeMs"], issue: "simulation clock must match the fixed-step tick" });
    }

    const agentIds = new Set<string>();
    for (const [key, group] of Object.entries(world.groups)) {
      if (key !== group.id) {
        issues.push({ path: ["groups", key, "id"], issue: "group record key must match id" });
      }
      if (group.order !== undefined && group.order.issuedAtTick > world.tick) {
        issues.push({
          path: ["groups", key, "order", "issuedAtTick"],
          issue: "waypoint cannot be issued in a future tick",
        });
      }
      if (
        group.targetObjectiveId !== undefined &&
        world.objectives[group.targetObjectiveId] === undefined
      ) {
        issues.push({
          path: ["groups", key, "targetObjectiveId"],
          issue: "target objective does not exist",
        });
      }
      if (
        group.mountedVehicleId !== undefined &&
        world.vehicles[group.mountedVehicleId] === undefined
      ) {
        issues.push({
          path: ["groups", key, "mountedVehicleId"],
          issue: "mounted vehicle does not exist",
        });
      }
      if (group.mountedVehicleId !== undefined) {
        const vehicle = world.vehicles[group.mountedVehicleId];
        if (vehicle !== undefined && vehicle.occupiedByGroupId !== group.id) {
          issues.push({
            path: ["groups", key, "mountedVehicleId"],
            issue: "vehicle lifecycle group and occupancy must be reciprocal",
          });
        }
      }
      for (let index = 0; index < group.agents.length; index += 1) {
        const agent = group.agents[index];
        if (!agent) continue;
        if (agentIds.has(agent.id)) {
          issues.push({
            path: ["groups", key, "agents", index, "id"],
            issue: "agent id is duplicated",
          });
        }
        agentIds.add(agent.id);
      }
    }

    for (const [key, vehicle] of Object.entries(world.vehicles)) {
      if (key !== vehicle.id) {
        issues.push({ path: ["vehicles", key, "id"], issue: "vehicle record key must match id" });
      }
      if (vehicle.occupiedByGroupId !== undefined) {
        const group = world.groups[vehicle.occupiedByGroupId];
        if (group === undefined) {
          issues.push({
            path: ["vehicles", key, "occupiedByGroupId"],
            issue: "occupied group does not exist",
          });
        } else if (group.mountedVehicleId !== vehicle.id) {
          issues.push({
            path: ["vehicles", key, "occupiedByGroupId"],
            issue: "vehicle occupancy must be reciprocal",
          });
        } else if (group.agents.length > vehicle.capacity) {
          issues.push({
            path: ["vehicles", key, "capacity"],
            issue: "occupied group exceeds vehicle capacity",
          });
        }
      }
    }

    for (const [key, objective] of Object.entries(world.objectives)) {
      if (key !== objective.id) {
        issues.push({
          path: ["objectives", key, "id"],
          issue: "objective record key must match id",
        });
      }
    }

    for (const [key, exchange] of Object.entries(world.engagements)) {
      if (key !== exchange.key) {
        issues.push({
          path: ["engagements", key, "key"],
          issue: "engagement record key must match key",
        });
      }
      for (const field of ["groupA", "groupB", "reportingGroupId", "targetGroupId"] as const) {
        const groupId = exchange[field];
        if (groupId !== undefined && world.groups[groupId] === undefined) {
          issues.push({
            path: ["engagements", key, field],
            issue: "engagement references an unknown group",
          });
        }
      }
    }
    return issues;
  }),
);

export const decodeSimWorldState = (input: unknown): SimWorldState => {
  const decoded = Schema.decodeUnknownSync(SimWorldStateSchema, {
    onExcessProperty: "error",
  })(input);
  return structuredClone(decoded) as SimWorldState;
};
