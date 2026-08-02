import type { Command, GameSnapshot, SergeantReport } from "@stavka/protocol";

import type { CommanderSessionState } from "../state/types";

const commandId = (tick: number, suffix: string): string => `cmd_${tick}_${suffix}`;

type Position = readonly [number, number, number];

const cellPosition = (
  state: CommanderSessionState,
  grid: readonly [number, number],
  elevation = 0,
): Position => {
  const resolution = state.mapBriefing?.grid_resolution_meters ?? 1;
  return [
    (grid[0] + 0.5) * resolution,
    elevation,
    (grid[1] + 0.5) * resolution,
  ];
};

const traversablePosition = (
  state: CommanderSessionState,
  desired: Position,
  preferredFeatures: readonly ("high_ground" | "chokepoint" | "settlement")[] = [],
): Position | undefined => {
  const briefing = state.mapBriefing;
  if (briefing === undefined) return desired;
  const resolution = briefing.grid_resolution_meters;
  const grid = [
    Math.floor(desired[0] / resolution),
    Math.floor(desired[2] / resolution),
  ] as const;
  const desiredCell = briefing.terrain_grid.find((cell) =>
    cell.grid[0] === grid[0] && cell.grid[1] === grid[1]);
  if (briefing.terrain_grid.length === 0 ||
    (desiredCell !== undefined && desiredCell.traversable && desiredCell.type !== "water")) {
    return desired;
  }
  const featureCells = briefing.key_features
    .filter((feature) => preferredFeatures.includes(feature.type))
    .map((feature) => ({
      feature,
      cell: briefing.terrain_grid.find((cell) =>
        cell.grid[0] === feature.grid[0] && cell.grid[1] === feature.grid[1]),
    }))
    .filter(({ cell }) => cell?.traversable && cell.type !== "water")
    .map(({ feature }) => cellPosition(state, feature.grid, feature.elevation ?? desired[1]));
  const candidates = featureCells.length > 0
    ? featureCells
    : briefing.terrain_grid
        .filter((cell) => cell.traversable && cell.type !== "water")
        .map((cell) => cellPosition(state, cell.grid, cell.elevation));
  return [...candidates].sort((left, right) => {
    const leftDistance = (left[0] - desired[0]) ** 2 + (left[2] - desired[2]) ** 2;
    const rightDistance = (right[0] - desired[0]) ** 2 + (right[2] - desired[2]) ** 2;
    return leftDistance - rightDistance;
  })[0];
};

const spawnPoint = (
  state: CommanderSessionState,
  snapshot: GameSnapshot,
): Position | undefined => traversablePosition(
  state,
  snapshot.objectives.find((item) => item.status === "friendly")?.position ?? [0, 0, 0],
  ["settlement", "high_ground"],
);

export interface RulePlan {
  readonly summary: string;
  readonly commands: readonly Command[];
  readonly manpowerSpent: number;
  readonly vehiclesReserved: number;
}

export const planRuleCommander = (
  state: CommanderSessionState,
  trigger: string,
): RulePlan => {
  const snapshot = state.snapshot;
  if (!snapshot) {
    return {
      summary: "Awaiting a full snapshot.",
      commands: [],
      manpowerSpent: 0,
      vehiclesReserved: 0,
    };
  }
  const commands: Command[] = [];
  const active = snapshot.friendly_groups.length;
  const targetGroups = Math.min(
    state.budget.maxActiveUnits,
    Math.max(2, Math.round(2 + state.difficulty.effective * 6)),
  );
  if (
    active < targetGroups &&
    state.budget.manpower >= 6 &&
    snapshot.mission.time_elapsed_seconds >= state.budget.reinforcementReadyAt
  ) {
    const position = spawnPoint(state, snapshot);
    if (position !== undefined) {
      commands.push({
        command_id: commandId(state.lastTickId, "reinforce"),
        priority: active === 0 ? "high" : "normal",
        type: "spawn_group",
        params: {
          template: "infantry_squad",
          position,
          behavior: "defend",
        },
      });
    }
  }

  const idle = snapshot.friendly_groups.find((group) =>
    group.status === "idle" || group.status === "defending");
  const contact = snapshot.known_enemies[0];
  const enemyObjective = snapshot.objectives.find((item) => item.status === "enemy");
  const destination = contact?.last_known_position ?? enemyObjective?.position;
  const traversableDestination = destination === undefined
    ? undefined
    : traversablePosition(state, destination, ["chokepoint", "high_ground"]);
  if (idle && traversableDestination !== undefined) {
    commands.push({
      command_id: commandId(state.lastTickId, `attack_${idle.id}`),
      priority: trigger.startsWith("event:") ? "urgent" : "normal",
      type: "attack_group",
      params: {
        group_id: idle.id,
        destination: traversableDestination,
      },
    });
  }
  return {
    summary:
      commands.length === 0
        ? "Hold current orders and preserve the reserve."
        : `Issued ${commands.length} bounded order(s) under ${state.doctrine} doctrine.`,
    commands,
    manpowerSpent: commands.some((command) => command.type === "spawn_group") ? 6 : 0,
    vehiclesReserved: commands.some((command) =>
      command.type === "spawn_group" &&
      /vehicle|mechanized|motorized|armor|tank|apc|ifv/i.test(command.params.template))
      ? 1
      : 0,
  };
};

export const planSergeantRules = (
  report: SergeantReport,
  snapshot: GameSnapshot | undefined,
): Command[] => {
  const payload = report.payload;
  const contact = payload.contacts[0];
  if (contact && (payload.report_type === "contact" || payload.status === "engaged")) {
    const radians = (contact.bearing * Math.PI) / 180;
    const destination = [
      payload.position[0] + Math.sin(radians) * contact.distance,
      payload.position[1],
      payload.position[2] + Math.cos(radians) * contact.distance,
    ] as const;
    return [{
      command_id: `sgt_${payload.group_id}_${Math.floor(report.timestamp)}_contact`,
      priority: "urgent",
      type: "attack_group",
      params: { group_id: payload.group_id, destination },
    }];
  }
  if (payload.report_type === "casualty" || payload.morale === "shaken") {
    const objective = snapshot?.objectives.find((item) => item.status === "friendly");
    return [{
      command_id: `sgt_${payload.group_id}_${Math.floor(report.timestamp)}_defend`,
      priority: "high",
      type: "defend_group",
      params: {
        group_id: payload.group_id,
        position: objective?.position ?? payload.position,
        radius: 25,
      },
    }];
  }
  return [];
};
