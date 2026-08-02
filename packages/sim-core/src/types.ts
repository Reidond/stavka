import type { GameEvent, ObjectiveState, Vector3 } from "@stavka/protocol";

export const SIM_VERSION = 1 as const;
export const FIXED_STEP_MS = 100 as const;

export type WaypointKind = "move" | "forced_move" | "attack" | "defend" | "patrol" | "sweep";

export interface SimWaypoint {
  readonly kind: WaypointKind;
  readonly destination: Vector3;
  readonly radius: number;
  readonly issuedAtTick: number;
  readonly patrolCenter?: Vector3;
}

export interface SimAgent {
  readonly id: string;
  health: number;
  offset: Vector3;
}

export type SimObjective = ObjectiveState & {
  readonly ownerFaction?: string;
  readonly capturingFaction?: string;
};

export interface SimGroup {
  readonly id: string;
  readonly faction: string;
  readonly template: string;
  position: Vector3;
  readonly maxStrength: number;
  agents: SimAgent[];
  status:
    | "initializing"
    | "idle"
    | "moving"
    | "engaged"
    | "defending"
    | "patrolling"
    | "boarding"
    | "mounted"
    | "dismounting";
  behavior?: string;
  targetObjectiveId?: string;
  order?: SimWaypoint;
  readonly materializeAtMs: number;
  mountedVehicleId?: string;
  transitionAtMs?: number;
  transitionStallAtMs?: number;
  transitionWasStalled?: boolean;
}

export interface SimVehicle {
  readonly id: string;
  readonly template: string;
  readonly capacity: number;
  position: Vector3;
  health: number;
  occupiedByGroupId?: string;
  stallSequence?: number;
  nextStallAtMs?: number;
  stallUntilMs?: number;
}

export interface CombatExchange {
  readonly key: string;
  readonly groupA: string;
  readonly groupB: string;
  accumulatedMs: number;
  contactReported: boolean;
  reportingGroupId?: string;
  targetGroupId?: string;
}

export interface TerrainGrid {
  readonly width: number;
  readonly height: number;
  readonly cellSizeMeters: 10;
  readonly samples: readonly number[];
  readonly contentHash: string;
}

export interface SimQuirks {
  readonly brokenMoveWaypoint: boolean;
  readonly recoverableVehicleStalls: boolean;
}

export interface SimWorldState {
  readonly version: typeof SIM_VERSION;
  readonly seed: number;
  rngState: number;
  tick: number;
  timeMs: number;
  nextGroupId: number;
  nextEventId: number;
  groups: Record<string, SimGroup>;
  vehicles: Record<string, SimVehicle>;
  objectives: Record<string, SimObjective>;
  engagements: Record<string, CombatExchange>;
  events: GameEvent[];
  terrain: TerrainGrid;
  quirks: SimQuirks;
}

export interface CreateWorldOptions {
  readonly seed: number;
  readonly terrainWidth?: number;
  readonly terrainHeight?: number;
  readonly quirks?: Partial<SimQuirks>;
}
