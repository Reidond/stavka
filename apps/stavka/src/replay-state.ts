import type { GameSnapshot, SessionExport, StateDelta, TickRequest } from "@stavka/protocol";

export type ReplayFrameSource = "archive" | "request" | "reconstructed";

export interface ReplayFrame {
  readonly tickId: number;
  readonly timestamp: number;
  readonly kind: TickRequest["type"];
  readonly snapshot: GameSnapshot;
  readonly source: ReplayFrameSource;
  readonly events: TickRequest["events"];
  readonly sergeantReports: TickRequest["sergeant_reports"];
  readonly commandResults: TickRequest["command_results"];
}

export class ReplayStateError extends Error {
  override readonly name = "ReplayStateError";
}

const fail = (message: string): never => {
  throw new ReplayStateError(message);
};

const cloneMission = (mission: GameSnapshot["mission"]): GameSnapshot["mission"] => ({
  ...mission,
  player_count: { ...mission.player_count },
});

const cloneObjective = (
  objective: GameSnapshot["objectives"][number],
): GameSnapshot["objectives"][number] => ({
  ...objective,
  position: [objective.position[0], objective.position[1], objective.position[2]],
});

const cloneGroup = (
  group: GameSnapshot["friendly_groups"][number],
): GameSnapshot["friendly_groups"][number] => ({
  ...group,
  position: [group.position[0], group.position[1], group.position[2]],
  strength: { ...group.strength },
});

const cloneEnemy = (
  enemy: GameSnapshot["known_enemies"][number],
): GameSnapshot["known_enemies"][number] => ({
  ...enemy,
  last_known_position: [
    enemy.last_known_position[0],
    enemy.last_known_position[1],
    enemy.last_known_position[2],
  ],
});

const cloneSnapshot = (snapshot: GameSnapshot): GameSnapshot => ({
  mission: cloneMission(snapshot.mission),
  objectives: snapshot.objectives.map(cloneObjective),
  friendly_groups: snapshot.friendly_groups.map(cloneGroup),
  known_enemies: snapshot.known_enemies.map(cloneEnemy),
  resources: { ...snapshot.resources },
});

const upsertById = <T extends { readonly id: string }>(
  current: readonly T[],
  updates: readonly T[],
): T[] => {
  const indexed = new Map(current.map((item) => [item.id, item]));
  for (const update of updates) indexed.set(update.id, update);
  return [...indexed.values()];
};

/** Mirrors the Commander's established delta order without mutating any prior frame. */
const applyDelta = (snapshot: GameSnapshot, changes: StateDelta): GameSnapshot => {
  let groups = upsertById(snapshot.friendly_groups, changes.groups_upserted.map(cloneGroup));
  const destroyedGroups = new Set(changes.groups_destroyed);
  const movement = new Map(changes.groups_moved.map((item) => [item.id, item.position]));
  groups = groups
    .filter((group) => !destroyedGroups.has(group.id))
    .map((group) => {
      const position = movement.get(group.id);
      return position === undefined
        ? group
        : { ...group, position: [position[0], position[1], position[2]] };
    });

  const removedObjectives = new Set(changes.objectives_removed ?? []);
  const objectives = upsertById(
    snapshot.objectives.filter((objective) => !removedObjectives.has(objective.id)),
    changes.objectives_upserted.map(cloneObjective),
  );

  const expiredEnemies = new Set(changes.known_enemies_expired);
  const knownEnemies = upsertById(
    snapshot.known_enemies.filter((enemy) => !expiredEnemies.has(enemy.id)),
    changes.known_enemies_upserted.map(cloneEnemy),
  );

  return {
    mission: changes.mission === undefined ? snapshot.mission : cloneMission(changes.mission),
    objectives,
    friendly_groups: groups,
    known_enemies: knownEnemies,
    resources: changes.resources === undefined ? snapshot.resources : { ...changes.resources },
  };
};

const deepEqual = (left: unknown, right: unknown): boolean => {
  if (Object.is(left, right)) return true;
  if (typeof left !== "object" || left === null || typeof right !== "object" || right === null) {
    return false;
  }
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
    return left.every((value, index) => deepEqual(value, right[index]));
  }

  const leftRecord = left as Record<string, unknown>;
  const rightRecord = right as Record<string, unknown>;
  const leftKeys = Object.keys(leftRecord);
  const rightKeys = Object.keys(rightRecord);
  if (leftKeys.length !== rightKeys.length) return false;
  return leftKeys.every(
    (key) => Object.hasOwn(rightRecord, key) && deepEqual(leftRecord[key], rightRecord[key]),
  );
};

/**
 * Builds replayable state frames entirely from an already decoded local SessionExport.
 * No transport, fetch, storage, or global state is consulted.
 */
export const reconstructReplayFrames = (replay: SessionExport): readonly ReplayFrame[] => {
  const { ticks, snapshots: archivedSnapshots } = replay.archive;

  const archivedByTick = new Map<number, (typeof archivedSnapshots)[number]>();
  let previousArchivedTickId: number | undefined;
  for (const snapshot of archivedSnapshots) {
    if (previousArchivedTickId !== undefined && snapshot.tickId <= previousArchivedTickId) {
      fail(
        `Archive snapshot tick IDs must be strictly increasing; received ${snapshot.tickId} after ${previousArchivedTickId}`,
      );
    }
    if (archivedByTick.has(snapshot.tickId)) {
      fail(`Archive snapshot tick ${snapshot.tickId} is duplicated`);
    }
    archivedByTick.set(snapshot.tickId, snapshot);
    previousArchivedTickId = snapshot.tickId;
  }

  const frames: ReplayFrame[] = [];
  const reconstructedTickIds = new Set<number>();
  let previousTickId: number | undefined;
  let previousTimestamp: number | undefined;
  let previousSnapshot: GameSnapshot | undefined;

  for (let index = 0; index < ticks.length; index += 1) {
    const tick = ticks[index];
    if (tick === undefined) continue;
    const request = tick.request;

    if (
      tick.tickId !== request.tick_id ||
      tick.timestamp !== request.timestamp ||
      tick.kind !== request.type
    ) {
      fail(`Archived tick ${tick.tickId} does not match its request envelope`);
    }
    if (
      request.session_id !== replay.session.session_id ||
      request.faction !== replay.session.faction
    ) {
      fail(`Tick ${tick.tickId} does not match replay session and faction`);
    }
    if (previousTickId !== undefined && tick.tickId <= previousTickId) {
      fail(`Tick IDs must be strictly increasing; received ${tick.tickId} after ${previousTickId}`);
    }
    if (previousTimestamp !== undefined && tick.timestamp < previousTimestamp) {
      fail(
        `Tick timestamps must be monotonic; received ${tick.timestamp} after ${previousTimestamp}`,
      );
    }
    if (index === 0 && request.type !== "full") {
      fail(`Replay must begin with a full snapshot; tick ${tick.tickId} is delta`);
    }

    let derived: GameSnapshot;
    if (request.type === "full") {
      derived = cloneSnapshot(request.snapshot);
    } else {
      const baselineTickId = previousTickId;
      const baselineSnapshot = previousSnapshot;
      if (baselineTickId === undefined) {
        throw new ReplayStateError(`Delta tick ${tick.tickId} has no prior tick`);
      }
      if (baselineSnapshot === undefined) {
        throw new ReplayStateError(`Delta tick ${tick.tickId} has no full snapshot baseline`);
      }
      if (request.since_tick !== baselineTickId) {
        fail(
          `Delta tick ${tick.tickId} since_tick ${request.since_tick} does not match prior tick ${baselineTickId}`,
        );
      }
      derived = applyDelta(baselineSnapshot, request.changes);
      if (request.snapshot !== undefined && !deepEqual(request.snapshot, derived)) {
        fail(`Delta tick ${tick.tickId} request snapshot does not match reconstructed state`);
      }
    }

    if (derived.mission.epoch !== replay.session.mission_epoch) {
      fail(
        `Snapshot mission epoch ${derived.mission.epoch} at tick ${tick.tickId} does not match replay epoch ${replay.session.mission_epoch}`,
      );
    }
    if (replay.session.map_name !== undefined && derived.mission.map !== replay.session.map_name) {
      fail(
        `Snapshot mission map ${derived.mission.map} at tick ${tick.tickId} does not match replay map ${replay.session.map_name}`,
      );
    }

    const archived = archivedByTick.get(tick.tickId);
    if (archived !== undefined) {
      if (archived.timestamp !== tick.timestamp) {
        fail(`Archive snapshot timestamp for tick ${tick.tickId} does not match the tick`);
      }
      if (!deepEqual(archived.snapshot, derived)) {
        fail(`Archive snapshot for tick ${tick.tickId} does not match reconstructed state`);
      }
    }

    const source: ReplayFrameSource =
      archived !== undefined
        ? "archive"
        : request.type === "full" || request.snapshot !== undefined
          ? "request"
          : "reconstructed";
    const snapshot = archived === undefined ? derived : cloneSnapshot(archived.snapshot);
    frames.push({
      tickId: tick.tickId,
      timestamp: tick.timestamp,
      kind: tick.kind,
      snapshot,
      source,
      events: [...request.events],
      sergeantReports: [...request.sergeant_reports],
      commandResults: [...request.command_results],
    });
    reconstructedTickIds.add(tick.tickId);
    previousTickId = tick.tickId;
    previousTimestamp = tick.timestamp;
    previousSnapshot = snapshot;
  }

  for (const tickId of archivedByTick.keys()) {
    if (!reconstructedTickIds.has(tickId)) {
      fail(`Archive snapshot tick ${tickId} has no corresponding archived tick`);
    }
  }

  return frames;
};
