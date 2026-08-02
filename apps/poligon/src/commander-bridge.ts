import type { MapBriefing } from "@stavka/protocol";
import { executeCommand, type SimGroup, type SimWorldState } from "@stavka/sim-core";
import { createMapBriefing, type TickOutcome } from "@stavka/sim-link";

interface CommanderSessionLink {
  readonly connect: () => Promise<unknown>;
  readonly uploadMap: (briefing: MapBriefing) => Promise<void>;
}

interface CommanderTickLink {
  readonly tick: (world: SimWorldState) => Promise<TickOutcome>;
  readonly tickIfDue: (world: SimWorldState) => Promise<TickOutcome | undefined>;
}

/** Establishes the session before sending its deterministic, one-time terrain briefing. */
export const connectAndBriefCommander = async (
  link: CommanderSessionLink,
  world: SimWorldState,
  mapName = "Poligon Procedural",
): Promise<void> => {
  await link.connect();
  await link.uploadMap(createMapBriefing(world, mapName));
};

/** Manual controls force a decision tick; the scheduled loop respects the commander's hint. */
export const runCommanderTick = (
  link: CommanderTickLink,
  world: SimWorldState,
  force: boolean,
): Promise<TickOutcome | undefined> => (force ? link.tick(world) : link.tickIfDue(world));

const nextAvailableGroupId = (world: SimWorldState): string => {
  let id = `grp_${String(world.nextGroupId).padStart(3, "0")}`;
  while (world.groups[id]) {
    world.nextGroupId += 1;
    id = `grp_${String(world.nextGroupId).padStart(3, "0")}`;
  }
  world.nextGroupId += 1;
  return id;
};

const copyGroup = (group: SimGroup, id = group.id): SimGroup => ({
  ...structuredClone(group),
  id,
  agents: group.agents.map((agent) => ({
    ...structuredClone(agent),
    id: agent.id.startsWith(`${group.id}:`) ? `${id}${agent.id.slice(group.id.length)}` : agent.id,
  })),
});

/**
 * Applies only a commander's own-faction group changes to the shared world.
 * A link ticks an isolated clone, so a malformed enemy-group order is discarded here.
 */
export const mergeFactionCommandEffects = (
  world: SimWorldState,
  commandWorld: SimWorldState,
  faction: string,
  outcome: TickOutcome,
): void => {
  const originalFactionIds = Object.values(world.groups)
    .filter((group) => group.faction === faction)
    .map((group) => group.id);
  for (const id of originalFactionIds) {
    if (!commandWorld.groups[id]) delete world.groups[id];
  }

  for (const group of Object.values(commandWorld.groups)) {
    if (group.faction !== faction) continue;
    const existing = world.groups[group.id];
    if (!existing || existing.faction === faction) {
      world.groups[group.id] = copyGroup(group);
      continue;
    }
    const replacementId = nextAvailableGroupId(world);
    world.groups[replacementId] = copyGroup(group, replacementId);
  }
  world.nextGroupId = Math.max(world.nextGroupId, commandWorld.nextGroupId);

  const accepted = new Set(
    outcome.commandResults
      .filter((result) => result.status === "accepted")
      .map((result) => result.command_id),
  );
  for (const command of outcome.response.commands) {
    if (command.type === "set_objective" && accepted.has(command.command_id)) {
      executeCommand(world, command, faction);
    }
  }
};
