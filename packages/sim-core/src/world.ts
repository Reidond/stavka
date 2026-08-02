import type { Command, GameEvent, ObjectiveState, Vector3 } from "@stavka/protocol";

import { randomFromWorld } from "./prng";
import { decodeSimWorldState } from "./state-schema";
import { createTerrain } from "./terrain";
import {
  FIXED_STEP_MS,
  SIM_VERSION,
  type CreateWorldOptions,
  type SimAgent,
  type SimGroup,
  type SimObjective,
  type SimVehicle,
  type SimWorldState,
  type WaypointKind,
} from "./types";

const distance2d = (a: Vector3, b: Vector3): number => Math.hypot(a[0] - b[0], a[2] - b[2]);

export const MAX_TRAVERSABLE_SLOPE_DEGREES = 35;
const OBJECTIVE_CAPTURE_RADIUS_METERS = 25;
const OBJECTIVE_CAPTURE_DURATION_MS = 30_000;

const deterministicFraction = (world: SimWorldState, key: string, sequence = 0): number => {
  let hash = (0x811c_9dc5 ^ world.seed ^ sequence) >>> 0;
  for (let index = 0; index < key.length; index += 1) {
    hash ^= key.charCodeAt(index);
    hash = Math.imul(hash, 0x0100_0193) >>> 0;
  }
  return hash / 0x1_0000_0000;
};

const terrainElevationAt = (
  world: SimWorldState,
  gridX: number,
  gridZ: number,
): number | undefined => {
  if (gridX < 0 || gridZ < 0 || gridX >= world.terrain.width || gridZ >= world.terrain.height) {
    return undefined;
  }
  const elevation = world.terrain.samples[gridZ * world.terrain.width + gridX];
  return elevation === undefined || elevation === -256 ? undefined : elevation;
};

const terrainMovementFactor = (
  world: SimWorldState,
  from: Vector3,
  destination: Vector3,
): number => {
  const cellSize = world.terrain.cellSizeMeters;
  const gridX = Math.floor(from[0] / cellSize);
  const gridZ = Math.floor(from[2] / cellSize);
  const currentElevation = terrainElevationAt(world, gridX, gridZ);
  // Legacy scenarios can start in a sentinel fringe. Let them move back onto valid terrain.
  if (currentElevation === undefined) return 1;
  const deltaX = destination[0] - from[0];
  const deltaZ = destination[2] - from[2];
  const nextGridX = gridX + (Math.abs(deltaX) >= Math.abs(deltaZ) ? Math.sign(deltaX) : 0);
  const nextGridZ = gridZ + (Math.abs(deltaZ) > Math.abs(deltaX) ? Math.sign(deltaZ) : 0);
  if (nextGridX === gridX && nextGridZ === gridZ) return 1;
  const nextElevation = terrainElevationAt(world, nextGridX, nextGridZ);
  if (nextElevation === undefined) return 0;
  const grade = Math.abs(nextElevation - currentElevation) / cellSize;
  const slopeRadians = Math.atan(grade);
  const slopeDegrees = (slopeRadians * 180) / Math.PI;
  return slopeDegrees > MAX_TRAVERSABLE_SLOPE_DEGREES ? 0 : Math.cos(slopeRadians);
};

const approach = (value: number, target: number, maximumChange: number): number =>
  value < target
    ? Math.min(value + maximumChange, target)
    : Math.max(value - maximumChange, target);

const updateAdvancingDispersion = (world: SimWorldState, group: SimGroup): void => {
  if (group.agents.length < 2) return;
  const phase =
    deterministicFraction(world, `dispersion:${group.id}`) * Math.PI * 2 +
    (world.timeMs / 240_000) * Math.PI * 2;
  for (let index = 0; index < group.agents.length; index += 1) {
    const agent = group.agents[index];
    if (!agent) continue;
    const radius = 28 + deterministicFraction(world, agent.id) * 4;
    const angle = phase + (index / group.agents.length) * Math.PI * 2;
    const targetX = Math.cos(angle) * radius;
    const targetZ = Math.sin(angle) * radius;
    agent.offset = [
      approach(agent.offset[0], targetX, 0.1),
      0,
      approach(agent.offset[2], targetZ, 0.1),
    ];
  }
};

const detectsForCombat = (observer: SimGroup, target: SimGroup): boolean => {
  const order = observer.order;
  if (order?.kind !== "attack" && order?.kind !== "sweep") return false;
  const range = distance2d(observer.position, target.position);
  if (order.kind === "attack") return range <= 80;
  if (range > 200) return false;
  const forwardX = order.destination[0] - observer.position[0];
  const forwardZ = order.destination[2] - observer.position[2];
  const forwardLength = Math.hypot(forwardX, forwardZ);
  if (forwardLength === 0 || range === 0) return true;
  const targetX = target.position[0] - observer.position[0];
  const targetZ = target.position[2] - observer.position[2];
  const cosine = (forwardX * targetX + forwardZ * targetZ) / (forwardLength * range);
  return cosine >= Math.cos(Math.PI / 3);
};

const moveTowards = (from: Vector3, to: Vector3, distance: number): Vector3 => {
  const total = distance2d(from, to);
  if (total <= distance || total === 0) return [to[0], to[1], to[2]];
  const ratio = distance / total;
  return [
    from[0] + (to[0] - from[0]) * ratio,
    from[1] + (to[1] - from[1]) * ratio,
    from[2] + (to[2] - from[2]) * ratio,
  ];
};

const event = (
  world: SimWorldState,
  type: string,
  significance: GameEvent["significance"],
  fields: Partial<Pick<GameEvent, "group_id" | "objective_id" | "position" | "details">> = {},
): void => {
  const id = `evt_${String(world.nextEventId).padStart(6, "0")}`;
  world.nextEventId += 1;
  world.events.push({
    id,
    type,
    timestamp: world.timeMs / 1000,
    significance,
    ...fields,
  });
};

const makeAgent = (world: SimWorldState, groupId: string, index: number): SimAgent => {
  const angle = randomFromWorld(world) * Math.PI * 2;
  const radius = 8 + randomFromWorld(world) * 24;
  return {
    id: `${groupId}:agent:${index + 1}`,
    health: 100,
    offset: [Math.cos(angle) * radius, 0, Math.sin(angle) * radius],
  };
};

export const createWorld = (options: CreateWorldOptions): SimWorldState => ({
  version: SIM_VERSION,
  seed: options.seed,
  rngState: options.seed >>> 0,
  tick: 0,
  timeMs: 0,
  nextGroupId: 1,
  nextEventId: 1,
  groups: {},
  vehicles: {},
  objectives: {},
  engagements: {},
  events: [],
  terrain: createTerrain(options.seed, options.terrainWidth, options.terrainHeight),
  quirks: {
    brokenMoveWaypoint: options.quirks?.brokenMoveWaypoint ?? true,
    recoverableVehicleStalls: options.quirks?.recoverableVehicleStalls ?? true,
  },
});

export const spawnGroup = (
  world: SimWorldState,
  input: {
    readonly id?: string;
    readonly faction: string;
    readonly template: string;
    readonly position: Vector3;
    readonly strength?: number;
  },
): SimGroup => {
  const id = input.id ?? `grp_${String(world.nextGroupId).padStart(3, "0")}`;
  if (world.groups[id]) throw new Error(`Group ${id} already exists`);
  world.nextGroupId += input.id ? 0 : 1;
  const group: SimGroup = {
    id,
    faction: input.faction,
    template: input.template,
    position: [...input.position],
    maxStrength: input.strength ?? 6,
    agents: [],
    status: "initializing",
    materializeAtMs: world.timeMs + 1_000,
  };
  world.groups[id] = group;
  event(world, "group_spawned", "notable", { group_id: id, position: group.position });
  return group;
};

export const spawnVehicle = (
  world: SimWorldState,
  input: {
    readonly id: string;
    readonly template: string;
    readonly position: Vector3;
    readonly capacity?: number;
  },
): SimVehicle => {
  const vehicle: SimVehicle = {
    id: input.id,
    template: input.template,
    capacity: input.capacity ?? 5,
    position: [...input.position],
    health: 2_000,
  };
  world.vehicles[vehicle.id] = vehicle;
  return vehicle;
};

export const issueWaypoint = (
  world: SimWorldState,
  groupId: string,
  kind: WaypointKind,
  destination: Vector3,
  radius = 2,
): void => {
  const group = world.groups[groupId];
  if (!group) throw new Error(`Unknown group ${groupId}`);
  if (!Number.isFinite(radius) || radius < 0) {
    throw new Error("Waypoint radius must be a non-negative finite number");
  }
  group.order = {
    kind,
    destination: [...destination],
    radius,
    issuedAtTick: world.tick,
    ...(kind === "patrol" ? { patrolCenter: [...destination] } : {}),
  };
  group.behavior = kind;
  if (group.status !== "initializing" && group.status !== "mounted") {
    group.status = kind === "defend" ? "defending" : kind === "patrol" ? "patrolling" : "moving";
  }
  event(world, "order_issued", "notable", {
    group_id: groupId,
    position: destination,
    details: { waypoint: kind },
  });
};

export const beginBoarding = (world: SimWorldState, groupId: string, vehicleId: string): void => {
  const group = world.groups[groupId];
  const vehicle = world.vehicles[vehicleId];
  if (!group || !vehicle) throw new Error("Unknown group or vehicle");
  if (group.mountedVehicleId !== undefined) {
    throw new Error(`Group ${groupId} is already assigned to vehicle ${group.mountedVehicleId}`);
  }
  if (vehicle.occupiedByGroupId !== undefined) {
    throw new Error(`Vehicle ${vehicleId} is occupied by ${vehicle.occupiedByGroupId}`);
  }
  if (group.agents.length > vehicle.capacity) throw new Error("Vehicle capacity exceeded");
  group.status = "boarding";
  group.mountedVehicleId = vehicleId;
  vehicle.occupiedByGroupId = groupId;
  group.transitionAtMs = world.timeMs + 27_500;
  if (
    world.quirks.recoverableVehicleStalls &&
    deterministicFraction(world, `boarding:${groupId}:${vehicleId}`) < 0.2
  ) {
    group.transitionStallAtMs = world.timeMs + 20_000;
    group.transitionWasStalled = true;
    group.transitionAtMs += 7_500;
  }
};

export const beginDismount = (world: SimWorldState, groupId: string): void => {
  const group = world.groups[groupId];
  if (!group?.mountedVehicleId) throw new Error("Group is not mounted");
  group.status = "dismounting";
  group.transitionAtMs = world.timeMs + 9_000;
};

const removeGroup = (world: SimWorldState, groupId: string): boolean => {
  const group = world.groups[groupId];
  if (!group) return false;

  for (const vehicle of Object.values(world.vehicles)) {
    if (vehicle.occupiedByGroupId === groupId) delete vehicle.occupiedByGroupId;
  }
  for (const [key, exchange] of Object.entries(world.engagements)) {
    if (
      exchange.groupA === groupId ||
      exchange.groupB === groupId ||
      exchange.reportingGroupId === groupId ||
      exchange.targetGroupId === groupId
    ) {
      delete world.engagements[key];
    }
  }
  delete world.groups[groupId];
  return true;
};

export const applyCasualty = (world: SimWorldState, groupId: string): void => {
  const group = world.groups[groupId];
  if (!group || group.agents.length === 0) return;
  const removed = group.agents.pop();
  event(world, "casualty", "urgent", {
    group_id: groupId,
    position: group.position,
    details: { agent_id: removed?.id ?? "unknown" },
  });
  if (group.agents.length === 0) {
    event(world, "group_wiped", "urgent", { group_id: groupId, position: group.position });
    removeGroup(world, groupId);
  }
};

const updateMaterialization = (world: SimWorldState, group: SimGroup): void => {
  if (group.status !== "initializing" || world.timeMs < group.materializeAtMs) return;
  group.agents = Array.from({ length: group.maxStrength }, (_, index) =>
    makeAgent(world, group.id, index),
  );
  group.status = group.order
    ? group.order.kind === "defend"
      ? "defending"
      : group.order.kind === "patrol"
        ? "patrolling"
        : "moving"
    : "idle";
  event(world, "agents_materialized", "notable", {
    group_id: group.id,
    position: group.position,
  });
};

const updateVehicleTransition = (world: SimWorldState, group: SimGroup): void => {
  if (group.transitionStallAtMs !== undefined && world.timeMs >= group.transitionStallAtMs) {
    event(world, "boarding_stalled", "notable", {
      group_id: group.id,
      position: group.position,
      details: { recoverable: true },
    });
    delete group.transitionStallAtMs;
  }
  if (!group.transitionAtMs || world.timeMs < group.transitionAtMs) return;
  const vehicle = group.mountedVehicleId ? world.vehicles[group.mountedVehicleId] : undefined;
  if (group.status === "boarding" && vehicle) {
    group.status = "mounted";
    vehicle.occupiedByGroupId = group.id;
    group.position = [...vehicle.position];
    if (group.transitionWasStalled) {
      event(world, "boarding_recovered", "notable", {
        group_id: group.id,
        position: group.position,
      });
    }
    event(world, "group_mounted", "notable", { group_id: group.id, position: group.position });
  } else if (group.status === "dismounting") {
    if (vehicle) {
      group.position = [...vehicle.position];
      delete vehicle.occupiedByGroupId;
    }
    delete group.mountedVehicleId;
    delete group.order;
    group.status = "idle";
    event(world, "group_dismounted", "notable", { group_id: group.id, position: group.position });
  }
  delete group.transitionAtMs;
  delete group.transitionStallAtMs;
  delete group.transitionWasStalled;
};

const vehicleCanAdvance = (world: SimWorldState, group: SimGroup, vehicle: SimVehicle): boolean => {
  if (!world.quirks.recoverableVehicleStalls) return true;
  const sequence = vehicle.stallSequence ?? 0;
  if (vehicle.stallUntilMs !== undefined) {
    if (world.timeMs < vehicle.stallUntilMs) return false;
    delete vehicle.stallUntilMs;
    event(world, "vehicle_recovered", "notable", {
      group_id: group.id,
      position: vehicle.position,
      details: { vehicle_id: vehicle.id },
    });
    vehicle.nextStallAtMs =
      world.timeMs +
      45_000 +
      Math.floor(deterministicFraction(world, `stall-gap:${vehicle.id}`, sequence) * 30_000);
  }
  if (vehicle.nextStallAtMs === undefined) {
    vehicle.nextStallAtMs =
      world.timeMs +
      45_000 +
      Math.floor(deterministicFraction(world, `stall-gap:${vehicle.id}`, sequence) * 30_000);
  }
  if (world.timeMs < vehicle.nextStallAtMs) return true;
  const duration =
    15_000 +
    Math.floor(deterministicFraction(world, `stall-duration:${vehicle.id}`, sequence) * 15_000);
  vehicle.stallSequence = sequence + 1;
  vehicle.stallUntilMs = world.timeMs + duration;
  delete vehicle.nextStallAtMs;
  event(world, "vehicle_stalled", "notable", {
    group_id: group.id,
    position: vehicle.position,
    details: { vehicle_id: vehicle.id, duration_ms: duration, recoverable: true },
  });
  return false;
};

const updateMovement = (world: SimWorldState, group: SimGroup): void => {
  const order = group.order;
  if (
    !order ||
    group.status === "initializing" ||
    group.status === "boarding" ||
    group.status === "dismounting"
  )
    return;
  if (order.kind === "move" && world.quirks.brokenMoveWaypoint) {
    group.status = "idle";
    return;
  }
  if (order.kind === "defend") {
    const phase = (world.tick + group.id.length * 13) / 25;
    const drift = Math.min(order.radius, 3);
    group.position = [
      order.destination[0] + Math.sin(phase) * drift,
      order.destination[1],
      order.destination[2] + Math.cos(phase) * drift,
    ];
    group.status = "defending";
    return;
  }

  if (order.kind === "attack" || order.kind === "sweep") {
    const nearestEnemy = Object.values(world.groups)
      .filter(
        (candidate) =>
          candidate.faction !== group.faction &&
          candidate.agents.length > 0 &&
          detectsForCombat(group, candidate),
      )
      .reduce<SimGroup | undefined>((nearest, candidate) => {
        if (!nearest) return candidate;
        return distance2d(group.position, candidate.position) <
          distance2d(group.position, nearest.position)
          ? candidate
          : nearest;
      }, undefined);
    if (nearestEnemy && distance2d(group.position, nearestEnemy.position) <= 80) {
      group.status = "engaged";
      return;
    }
  }

  const mounted = group.mountedVehicleId ? world.vehicles[group.mountedVehicleId] : undefined;
  if (mounted && !vehicleCanAdvance(world, group, mounted)) {
    group.status = "mounted";
    return;
  }
  // Active driving is provisionally calibrated above the measured ~10 km/h journey
  // average so two persisted 15-30 second recovery stalls do not double-count slowdown.
  const speedMetersPerSecond = mounted ? 13_200 / 3_600 : 2;
  const maxDistance =
    speedMetersPerSecond *
    (FIXED_STEP_MS / 1_000) *
    terrainMovementFactor(world, group.position, order.destination);
  const remaining = distance2d(group.position, order.destination);
  const arrivalTolerance = order.kind === "patrol" ? 2 : order.radius;
  if (remaining <= arrivalTolerance) {
    if (order.kind === "patrol") {
      const center = order.patrolCenter ?? order.destination;
      const angle = randomFromWorld(world) * Math.PI * 2;
      const radius = randomFromWorld(world) * order.radius;
      group.order = {
        ...order,
        destination: [
          center[0] + Math.cos(angle) * radius,
          center[1],
          center[2] + Math.sin(angle) * radius,
        ],
      };
      group.status = "patrolling";
    } else {
      group.status = mounted ? "mounted" : "idle";
    }
    return;
  }

  group.position = moveTowards(group.position, order.destination, maxDistance);
  if (mounted) mounted.position = [...group.position];
  updateAdvancingDispersion(world, group);
  group.status = mounted ? "mounted" : order.kind === "patrol" ? "patrolling" : "moving";
};

const updateCombat = (world: SimWorldState): void => {
  const groups = Object.values(world.groups).filter((group) => group.agents.length > 0);
  for (let a = 0; a < groups.length; a += 1) {
    const first = groups[a];
    if (!first || world.groups[first.id] !== first) continue;
    for (let b = a + 1; b < groups.length; b += 1) {
      const second = groups[b];
      if (world.groups[first.id] !== first) break;
      if (!second || world.groups[second.id] !== second || first.faction === second.faction)
        continue;
      const firstDetects = detectsForCombat(first, second);
      const secondDetects = detectsForCombat(second, first);
      if (!firstDetects && !secondDetects) continue;
      const range = distance2d(first.position, second.position);
      const key = [first.id, second.id].sort().join(":");
      const exchange = (world.engagements[key] ??= {
        key,
        groupA: first.id,
        groupB: second.id,
        accumulatedMs: 0,
        contactReported: false,
      });
      if (!exchange.contactReported) {
        const reporter = firstDetects ? first : second;
        const target = firstDetects ? second : first;
        exchange.contactReported = true;
        exchange.reportingGroupId = reporter.id;
        exchange.targetGroupId = target.id;
        event(world, "contact", "urgent", {
          group_id: reporter.id,
          position: target.position,
          details: { target_group_id: target.id, range },
        });
      }
      if (range > 80) continue;
      first.status = "engaged";
      second.status = "engaged";
      exchange.accumulatedMs += FIXED_STEP_MS;
      if (exchange.accumulatedMs >= 120_000) {
        exchange.accumulatedMs -= 120_000;
        const firstWeight = second.agents.length / (first.agents.length + second.agents.length);
        const victim = randomFromWorld(world) < firstWeight ? first : second;
        applyCasualty(world, victim.id);
      }
    }
  }
};

const updateObjectives = (world: SimWorldState): void => {
  for (const objective of Object.values(world.objectives)) {
    const occupyingGroups = Object.values(world.groups)
      .filter(
        (group) =>
          group.agents.length > 0 &&
          group.status !== "initializing" &&
          distance2d(group.position, objective.position) <= OBJECTIVE_CAPTURE_RADIUS_METERS,
      )
      .sort((left, right) => left.id.localeCompare(right.id));
    const factions = [...new Set(occupyingGroups.map((group) => group.faction))].sort();
    if (factions.length > 1) {
      world.objectives[objective.id] = { ...objective, status: "contested" };
      continue;
    }
    const faction = factions[0];
    if (faction === undefined) {
      if (objective.ownerFaction !== undefined) {
        world.objectives[objective.id] = {
          ...objective,
          status: "friendly",
          capture_progress: 1,
        };
      } else if (objective.capture_progress > 0) {
        const capture_progress = Math.max(
          0,
          objective.capture_progress - FIXED_STEP_MS / OBJECTIVE_CAPTURE_DURATION_MS,
        );
        const { capturingFaction: _capturingFaction, ...rest } = objective;
        world.objectives[objective.id] = {
          ...rest,
          status: capture_progress === 0 ? "neutral" : "contested",
          capture_progress,
        };
      }
      continue;
    }
    if (objective.ownerFaction === faction) {
      const { capturingFaction: _capturingFaction, ...rest } = objective;
      world.objectives[objective.id] = { ...rest, status: "friendly", capture_progress: 1 };
      continue;
    }
    const capture_progress = Math.min(
      1,
      (objective.capturingFaction === faction ? objective.capture_progress : 0) +
        FIXED_STEP_MS / OBJECTIVE_CAPTURE_DURATION_MS,
    );
    if (capture_progress < 1) {
      world.objectives[objective.id] = {
        ...objective,
        status: "contested",
        capture_progress,
        capturingFaction: faction,
      };
      continue;
    }
    const previousOwner = objective.ownerFaction;
    const { capturingFaction: _capturingFaction, ...rest } = objective;
    world.objectives[objective.id] = {
      ...rest,
      ownerFaction: faction,
      status: "friendly",
      capture_progress: 1,
    };
    if (previousOwner !== undefined && previousOwner !== faction) {
      event(world, "objective_lost", "urgent", {
        objective_id: objective.id,
        position: objective.position,
        details: { faction: previousOwner },
      });
    }
    event(world, "objective_captured", "urgent", {
      group_id: occupyingGroups[0]?.id,
      objective_id: objective.id,
      position: objective.position,
      details: { faction },
    });
  }
};

export const stepWorld = (world: SimWorldState): SimWorldState => {
  world.tick += 1;
  world.timeMs += FIXED_STEP_MS;
  for (const group of Object.values(world.groups)) updateMaterialization(world, group);
  for (const group of Object.values(world.groups)) updateVehicleTransition(world, group);
  for (const group of Object.values(world.groups)) updateMovement(world, group);
  updateObjectives(world);
  updateCombat(world);
  return world;
};

export const stepWorldMany = (world: SimWorldState, steps: number): SimWorldState => {
  if (!Number.isInteger(steps) || steps < 0)
    throw new Error("steps must be a non-negative integer");
  for (let index = 0; index < steps; index += 1) stepWorld(world);
  return world;
};

export const drainEvents = (world: SimWorldState): GameEvent[] => {
  const events = world.events;
  world.events = [];
  return events;
};

export const snapshotWorld = (world: SimWorldState): SimWorldState => structuredClone(world);

export const restoreWorld = (snapshot: unknown): SimWorldState => decodeSimWorldState(snapshot);

export const upsertObjective = (world: SimWorldState, objective: SimObjective): void => {
  world.objectives[objective.id] = structuredClone(objective);
};

const objectiveStatus = (
  status: string | undefined,
  fallback: ObjectiveState["status"],
): ObjectiveState["status"] => {
  switch (status) {
    case undefined:
      return fallback;
    case "friendly":
    case "enemy":
    case "neutral":
    case "contested":
      return status;
    default:
      throw new Error(`Unsupported objective status ${status}`);
  }
};

export const executeCommand = (
  world: SimWorldState,
  command: Command,
  spawnedFaction = "AI",
): void => {
  switch (command.type) {
    case "spawn_group": {
      const target = command.params.target_objective
        ? world.objectives[command.params.target_objective]
        : undefined;
      if (command.params.target_objective && !target) {
        throw new Error(`Unknown objective ${command.params.target_objective}`);
      }
      const group = spawnGroup(world, {
        faction: command.params.faction ?? spawnedFaction,
        template: command.params.template,
        position: command.params.position,
      });
      if (command.params.behavior !== undefined) group.behavior = command.params.behavior;
      if (target !== undefined) group.targetObjectiveId = target.id;
      break;
    }
    case "despawn_group":
      removeGroup(world, command.params.group_id);
      break;
    case "move_group":
      issueWaypoint(world, command.params.group_id, "forced_move", command.params.destination);
      if (command.params.behavior !== undefined) {
        const group = world.groups[command.params.group_id];
        if (group) group.behavior = command.params.behavior;
      }
      break;
    case "attack_group":
      issueWaypoint(world, command.params.group_id, "attack", command.params.destination);
      break;
    case "defend_group":
      issueWaypoint(
        world,
        command.params.group_id,
        "defend",
        command.params.position,
        command.params.radius ?? 15,
      );
      break;
    case "patrol_group":
      issueWaypoint(
        world,
        command.params.group_id,
        "patrol",
        command.params.position,
        command.params.radius,
      );
      break;
    case "sweep_group":
      issueWaypoint(world, command.params.group_id, "sweep", command.params.destination);
      break;
    case "set_objective": {
      const params = command.params;
      const existing = world.objectives[params.objective_id];
      switch (params.action) {
        case "create":
          if (existing) throw new Error(`Objective ${params.objective_id} already exists`);
          if (!params.position) throw new Error("Objective position is required for create");
          upsertObjective(world, {
            id: params.objective_id,
            name: params.objective_id,
            position: params.position,
            status: objectiveStatus(params.status, "neutral"),
            capture_progress: 0,
            ...(params.status === "friendly" ? { ownerFaction: spawnedFaction } : {}),
          });
          break;
        case "update":
          if (!existing) throw new Error(`Unknown objective ${params.objective_id}`);
          if (!params.position && params.status === undefined) {
            throw new Error("Objective update requires position or status");
          }
          const updated: SimObjective = {
            ...existing,
            ...(params.position === undefined ? {} : { position: params.position }),
            status: objectiveStatus(params.status, existing.status),
            ...(params.status === "friendly" ? { ownerFaction: spawnedFaction } : {}),
          };
          if (params.status === "neutral" || params.status === "enemy") {
            const {
              capturingFaction: _capturingFaction,
              ownerFaction: _ownerFaction,
              ...rest
            } = updated;
            upsertObjective(world, rest);
          } else {
            upsertObjective(world, updated);
          }
          break;
        case "remove":
          if (!existing) throw new Error(`Unknown objective ${params.objective_id}`);
          delete world.objectives[params.objective_id];
          for (const group of Object.values(world.groups)) {
            if (group.targetObjectiveId === params.objective_id) {
              delete group.targetObjectiveId;
            }
          }
          break;
        case "assign": {
          if (!existing) throw new Error(`Unknown objective ${params.objective_id}`);
          if (!params.assignee_group_id) {
            throw new Error("Objective assignee is required for assign");
          }
          const assignee = world.groups[params.assignee_group_id];
          if (!assignee) {
            throw new Error(`Unknown group ${params.assignee_group_id}`);
          }
          assignee.targetObjectiveId = existing.id;
          break;
        }
      }
      break;
    }
  }
};
