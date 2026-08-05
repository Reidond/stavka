import type { Command, Vector3 } from "@stavka/protocol";

import type { CommanderSessionState } from "../state/types";
import type { AiCommandProposal } from "./llm-client";

export interface RejectedCommand {
  readonly commandId: string;
  readonly reason: string;
}

export interface ValidatedCommands {
  readonly commands: readonly Command[];
  readonly rejected: readonly RejectedCommand[];
  readonly manpowerSpent: number;
  readonly vehiclesReserved: number;
}

const commandId = (prefix: string, sequence: number): string =>
  `${prefix}${String(sequence).padStart(8, "0")}`;

export const materializeCommandProposals = (
  proposals: readonly AiCommandProposal[],
  startSequence: number,
  prefix = "cmd_",
): Command[] =>
  proposals.map(
    (proposal, index): Command => ({
      ...proposal,
      command_id: commandId(prefix, startSequence + index),
    }),
  );

export const reassignCommandIds = (
  commands: readonly Command[],
  startSequence: number,
  prefix = "cmd_",
): Command[] =>
  commands.map(
    (command, index): Command => ({
      ...command,
      command_id: commandId(prefix, startSequence + index),
    }),
  );

const positionFor = (command: Command): Vector3 | undefined => {
  switch (command.type) {
    case "spawn_group":
      return command.params.position;
    case "move_group":
    case "attack_group":
    case "sweep_group":
      return command.params.destination;
    case "defend_group":
    case "patrol_group":
      return command.params.position;
    case "set_objective":
      return command.params.action === "create" || command.params.action === "update"
        ? command.params.position
        : undefined;
    case "despawn_group":
      return undefined;
  }
};

const withinMap = (position: Vector3, state: CommanderSessionState): boolean => {
  if (!position.every(Number.isFinite)) return false;
  const briefing = state.mapBriefing;
  const width =
    briefing === undefined
      ? 100_000
      : (briefing.grid_width ?? briefing.grid_size) * briefing.grid_resolution_meters;
  const height =
    briefing === undefined
      ? 100_000
      : (briefing.grid_height ?? briefing.grid_size) * briefing.grid_resolution_meters;
  if (
    position[0] < 0 ||
    position[0] > width ||
    position[2] < 0 ||
    position[2] > height ||
    position[1] < -2_000 ||
    position[1] > 20_000
  )
    return false;
  if (briefing === undefined) return true;
  const gridX = Math.floor(position[0] / briefing.grid_resolution_meters);
  const gridY = Math.floor(position[2] / briefing.grid_resolution_meters);
  const cell = briefing.terrain_grid.find(
    (candidate) => candidate.grid[0] === gridX && candidate.grid[1] === gridY,
  );
  // A populated terrain briefing is an allow-list. Missing cells can be
  // omitted water/sentinel terrain, so accepting them would let an LLM route
  // through unclassified ground. Legacy empty briefings retain map-only
  // validation until terrain data is available.
  return (
    briefing.terrain_grid.length === 0 ||
    (cell !== undefined && cell.traversable && cell.type !== "water")
  );
};

const vehicleTemplate = (template: string): boolean =>
  /vehicle|mechanized|motorized|armor|tank|apc|ifv/i.test(template);

export const validateCommands = (
  requested: readonly Command[],
  state: CommanderSessionState,
  limit = 8,
): ValidatedCommands => {
  const groups = new Set(state.snapshot?.friendly_groups.map((group) => group.id) ?? []);
  const objectives = new Set(state.snapshot?.objectives.map((objective) => objective.id) ?? []);
  const seen = new Set<string>();
  const commands: Command[] = [];
  const rejected: RejectedCommand[] = [];
  let manpowerSpent = 0;
  let vehiclesReserved = 0;
  let activeGroups = groups.size;
  const missionTime = state.snapshot?.mission.time_elapsed_seconds ?? 0;

  const reject = (command: Command, reason: string): void => {
    rejected.push({ commandId: command.command_id, reason });
  };

  for (const command of requested) {
    if (commands.length >= limit) {
      reject(command, "command limit exceeded");
      continue;
    }
    if (seen.has(command.command_id)) {
      reject(command, "duplicate command id");
      continue;
    }
    seen.add(command.command_id);
    const position = positionFor(command);
    if (position !== undefined && !withinMap(position, state)) {
      reject(command, "position is outside the playable map");
      continue;
    }

    if (command.type === "spawn_group") {
      const needsVehicle = vehicleTemplate(command.params.template);
      if (missionTime < state.budget.reinforcementReadyAt) {
        reject(command, "reinforcement cooldown is active");
        continue;
      }
      if (activeGroups + 1 > state.budget.maxActiveUnits) {
        reject(command, "active group cap exceeded");
        continue;
      }
      if (manpowerSpent + 6 > state.budget.manpower) {
        reject(command, "insufficient manpower");
        continue;
      }
      if (needsVehicle && vehiclesReserved + 1 > state.budget.vehiclePool) {
        reject(command, "insufficient vehicle pool");
        continue;
      }
      if (
        command.params.target_objective !== undefined &&
        !objectives.has(command.params.target_objective)
      ) {
        reject(command, "target objective does not exist");
        continue;
      }
      activeGroups += 1;
      manpowerSpent += 6;
      if (needsVehicle) vehiclesReserved += 1;
      commands.push(command);
      continue;
    }

    if (command.type === "set_objective") {
      if (command.params.action === "create") {
        if (objectives.has(command.params.objective_id) || command.params.position === undefined) {
          reject(command, "new objective requires a unique id and valid position");
          continue;
        }
      } else if (!objectives.has(command.params.objective_id)) {
        reject(command, "objective does not exist");
        continue;
      }
      if (command.params.action === "assign" && !groups.has(command.params.assignee_group_id)) {
        reject(command, "objective assignee is not an owned group");
        continue;
      }
      commands.push(command);
      continue;
    }

    if (!groups.has(command.params.group_id)) {
      reject(command, "group is not an existing owned group");
      continue;
    }
    commands.push(command);
  }

  return { commands, rejected, manpowerSpent, vehiclesReserved };
};
