import type {
  FriendlyGroupState,
  GameSnapshot,
  KnownEnemyState,
  StateDelta,
} from "@stavka/protocol";
import type { SimGroup, SimWorldState } from "@stavka/sim-core";

const behaviorOf = (group: SimGroup): string => group.behavior ?? group.order?.kind ?? "none";

const distance = (left: SimGroup["position"], right: SimGroup["position"]): number =>
  Math.hypot(left[0] - right[0], left[1] - right[1], left[2] - right[2]);

const projectFriendly = (group: SimGroup): FriendlyGroupState => ({
  id: group.id,
  faction: group.faction,
  template: group.template,
  position: [...group.position],
  strength: { current: group.agents.length, max: group.maxStrength },
  behavior: behaviorOf(group),
  status: group.status,
  ...(group.mountedVehicleId ? { mounted_vehicle_id: group.mountedVehicleId } : {}),
});

const projectEnemy = (group: SimGroup, reporter: SimGroup): KnownEnemyState => ({
  id: group.id,
  reported_by: reporter.id,
  type: group.mountedVehicleId ? "vehicle" : "infantry",
  estimated_count: group.agents.length,
  last_known_position: [...group.position],
  confidence: "confirmed",
  age_seconds: 0,
});

const projectObjective = (
  objective: SimWorldState["objectives"][string],
  faction: string,
): GameSnapshot["objectives"][number] => ({
  id: objective.id,
  name: objective.name,
  position: [...objective.position],
  status:
    objective.status === "contested" || objective.ownerFaction === undefined
      ? objective.status
      : objective.ownerFaction === faction
        ? "friendly"
        : "enemy",
  capture_progress: objective.capture_progress,
});

const confidenceAt = (ageSeconds: number): KnownEnemyState["confidence"] => {
  if (ageSeconds <= 15) return "confirmed";
  if (ageSeconds <= 45) return "probable";
  if (ageSeconds <= 120) return "possible";
  return "stale";
};

export const decayKnownEnemies = (
  previous: readonly KnownEnemyState[],
  visible: readonly KnownEnemyState[],
  elapsedSeconds: number,
  expirySeconds = 180,
): KnownEnemyState[] => {
  const visibleIds = new Set(visible.map((enemy) => enemy.id));
  const aged = previous
    .filter((enemy) => !visibleIds.has(enemy.id))
    .map((enemy) => {
      const age_seconds = Math.max(0, enemy.age_seconds + elapsedSeconds);
      return { ...enemy, age_seconds, confidence: confidenceAt(age_seconds) };
    })
    .filter((enemy) => enemy.age_seconds <= expirySeconds);
  return [
    ...visible.map((enemy) => ({ ...enemy, age_seconds: 0, confidence: "confirmed" as const })),
    ...aged,
  ].sort((left, right) => left.id.localeCompare(right.id));
};

export const projectWorld = (
  world: SimWorldState,
  faction: string,
  options: {
    readonly sessionId: string;
    readonly missionId?: string;
    readonly missionName?: string;
    readonly missionEpoch?: number;
    readonly mapName?: string;
    readonly maxActiveUnits?: number;
    readonly detectionRangeMeters?: number;
  },
): GameSnapshot => {
  const nowSeconds = world.timeMs / 1_000;
  const friendlyGroups = Object.values(world.groups).filter(
    (group) => group.faction === faction && group.agents.length > 0,
  );
  const detectionRange = options.detectionRangeMeters ?? 300;
  return {
    mission: {
      id: options.missionId ?? options.sessionId,
      epoch: options.missionEpoch ?? 1,
      name: options.missionName ?? `Poligon ${options.sessionId}`,
      map: options.mapName ?? "Poligon Procedural",
      time_elapsed_seconds: nowSeconds,
      player_count: { friendly: 0, enemy: 0 },
    },
    objectives: Object.values(world.objectives).map((objective) =>
      projectObjective(objective, faction),
    ),
    friendly_groups: friendlyGroups.map(projectFriendly),
    known_enemies: Object.values(world.groups)
      .filter((group) => group.faction !== faction && group.agents.length > 0)
      .flatMap((group) => {
        const directedReporters = Object.values(world.engagements)
          .filter(
            (exchange) =>
              exchange.contactReported &&
              exchange.targetGroupId === group.id &&
              exchange.reportingGroupId !== undefined,
          )
          .flatMap((exchange) => {
            const reporter = exchange.reportingGroupId
              ? world.groups[exchange.reportingGroupId]
              : undefined;
            return reporter?.faction === faction && reporter.agents.length > 0 ? [reporter] : [];
          });
        const reporters = [...friendlyGroups, ...directedReporters]
          .filter(
            (reporter, index, items) =>
              items.findIndex((candidate) => candidate.id === reporter.id) === index,
          )
          .map((friendly) => ({ friendly, distance: distance(friendly.position, group.position) }))
          .filter(
            (candidate) =>
              candidate.distance <= detectionRange ||
              directedReporters.some((reporter) => reporter.id === candidate.friendly.id),
          )
          .sort(
            (left, right) =>
              left.distance - right.distance || left.friendly.id.localeCompare(right.friendly.id),
          );
        const reporter = reporters[0]?.friendly;
        return reporter ? [projectEnemy(group, reporter)] : [];
      }),
    resources: {
      manpower: 150,
      vehicle_pool: Object.keys(world.vehicles).length,
      reinforcement_cooldown_seconds: 0,
      max_active_units: options.maxActiveUnits ?? 50,
    },
  };
};

const stableEqual = (left: unknown, right: unknown): boolean =>
  JSON.stringify(left) === JSON.stringify(right);

const indexById = <T extends { readonly id: string }>(items: readonly T[]): Map<string, T> =>
  new Map(items.map((item) => [item.id, item]));

export const diffSnapshots = (
  before: GameSnapshot,
  after: GameSnapshot,
  movementThresholdMeters = 50,
): StateDelta => {
  if (!Number.isFinite(movementThresholdMeters) || movementThresholdMeters < 0) {
    throw new Error("movement threshold must be a non-negative finite number");
  }
  const beforeGroups = indexById(before.friendly_groups);
  const afterGroups = indexById(after.friendly_groups);
  const groups_upserted: FriendlyGroupState[] = [];
  const groups_moved: { id: string; position: FriendlyGroupState["position"] }[] = [];

  for (const group of after.friendly_groups) {
    const previous = beforeGroups.get(group.id);
    if (!previous) {
      groups_upserted.push(group);
      continue;
    }
    const { position: previousPosition, ...previousRest } = previous;
    const { position, ...rest } = group;
    if (!stableEqual(previousRest, rest)) groups_upserted.push(group);
    else if (
      Math.hypot(position[0] - previousPosition[0], position[2] - previousPosition[2]) >
      movementThresholdMeters
    )
      groups_moved.push({ id: group.id, position });
  }

  const beforeObjectives = indexById(before.objectives);
  const afterObjectives = indexById(after.objectives);
  const beforeEnemies = indexById(before.known_enemies);
  const afterEnemies = indexById(after.known_enemies);
  const objectivesRemoved = before.objectives
    .filter((objective) => !afterObjectives.has(objective.id))
    .map((objective) => objective.id);

  return {
    ...(!stableEqual(before.mission, after.mission) ? { mission: after.mission } : {}),
    groups_upserted,
    groups_moved,
    groups_destroyed: before.friendly_groups
      .filter((group) => !afterGroups.has(group.id))
      .map((group) => group.id),
    objectives_upserted: after.objectives.filter(
      (objective) => !stableEqual(beforeObjectives.get(objective.id), objective),
    ),
    ...(objectivesRemoved.length > 0 ? { objectives_removed: objectivesRemoved } : {}),
    known_enemies_upserted: after.known_enemies.filter(
      (enemy) => !stableEqual(beforeEnemies.get(enemy.id), enemy),
    ),
    known_enemies_expired: before.known_enemies
      .filter((enemy) => !afterEnemies.has(enemy.id))
      .map((enemy) => enemy.id),
    ...(!stableEqual(before.resources, after.resources) ? { resources: after.resources } : {}),
  };
};
