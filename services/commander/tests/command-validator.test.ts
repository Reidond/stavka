import type { Command } from "@stavka/protocol";
import { Schema } from "effect";
import { describe, expect, it } from "vitest";

import { materializeCommandProposals, validateCommands } from "../src/brain/command-validator";
import { AiDecision } from "../src/brain/llm-client";
import { initialCommanderState } from "../src/state/types";

const state = () => ({
  ...initialCommanderState(),
  snapshot: {
    mission: {
      id: "mission",
      epoch: 1,
      name: "Test",
      map: "Everon",
      time_elapsed_seconds: 120,
      player_count: { friendly: 1, enemy: 1 },
    },
    objectives: [
      {
        id: "hill",
        name: "Hill",
        position: [500, 0, 500] as const,
        status: "enemy" as const,
        capture_progress: 0,
      },
    ],
    friendly_groups: [
      {
        id: "owned",
        faction: "OPFOR",
        template: "infantry",
        position: [100, 0, 100] as const,
        strength: { current: 8, max: 8 },
        status: "idle" as const,
        behavior: "hold",
      },
    ],
    known_enemies: [],
    resources: {
      manpower: 6,
      vehicle_pool: 0,
      reinforcement_cooldown_seconds: 0,
      max_active_units: 2,
    },
  },
  mapBriefing: {
    map_name: "Everon",
    grid_size: 100,
    grid_width: 100,
    grid_height: 100,
    grid_resolution_meters: 10,
    source: "arma_extracted" as const,
    classification_version: 1,
    content_hash: "stavka-map-v1-command-validator",
    terrain_grid: [],
    key_features: [],
  },
  budget: {
    manpower: 6,
    vehiclePool: 0,
    reinforcementReadyAt: 0,
    maxActiveUnits: 2,
    lastUpdatedAt: 120,
  },
});

describe("LLM command semantic validation", () => {
  it("projects accepted objective changes in batch order", () => {
    const commands: Command[] = [
      {
        command_id: "create",
        type: "set_objective",
        params: { action: "create", objective_id: "new", position: [200, 0, 200] },
      },
      {
        command_id: "assign",
        type: "set_objective",
        params: { action: "assign", objective_id: "new", assignee_group_id: "owned" },
      },
      {
        command_id: "duplicate",
        type: "set_objective",
        params: { action: "create", objective_id: "new", position: [200, 0, 200] },
      },
      {
        command_id: "spawn",
        type: "spawn_group",
        params: { template: "infantry", position: [100, 0, 100], target_objective: "new" },
      },
      {
        command_id: "remove",
        type: "set_objective",
        params: { action: "remove", objective_id: "new" },
      },
      {
        command_id: "missing",
        type: "set_objective",
        params: { action: "assign", objective_id: "new", assignee_group_id: "owned" },
      },
      {
        command_id: "invalid-create",
        type: "set_objective",
        params: { action: "create", objective_id: "invalid", position: [2000, 0, 2000] },
      },
      {
        command_id: "invalid-assign",
        type: "set_objective",
        params: { action: "assign", objective_id: "invalid", assignee_group_id: "owned" },
      },
    ];
    const result = validateCommands(commands, state());
    expect(result.commands.map((command) => command.command_id)).toEqual([
      "create",
      "assign",
      "spawn",
      "remove",
    ]);
    expect(result.rejected.map((command) => command.commandId)).toEqual([
      "duplicate",
      "missing",
      "invalid-create",
      "invalid-assign",
    ]);
  });
  it("rejects foreign groups, out-of-map positions, and unavailable vehicle spawns", () => {
    const commands: Command[] = [
      {
        command_id: "foreign",
        type: "move_group",
        params: { group_id: "enemy", destination: [200, 0, 200] },
      },
      {
        command_id: "outside",
        type: "attack_group",
        params: { group_id: "owned", destination: [2_000, 0, 2_000] },
      },
      {
        command_id: "vehicle",
        type: "spawn_group",
        params: { template: "mechanized_ifv", position: [200, 0, 200] },
      },
    ];

    const result = validateCommands(commands, state());

    expect(result.commands).toEqual([]);
    expect(result.rejected.map((item) => item.reason)).toEqual([
      "group is not an existing owned group",
      "position is outside the playable map",
      "insufficient vehicle pool",
    ]);
  });

  it("accepts only resource-bounded commands for existing entities", () => {
    const commands: Command[] = [
      {
        command_id: "move",
        type: "move_group",
        params: { group_id: "owned", destination: [200, 0, 200] },
      },
      {
        command_id: "spawn",
        type: "spawn_group",
        params: { template: "infantry_squad", position: [100, 0, 100], target_objective: "hill" },
      },
      {
        command_id: "spawn-again",
        type: "spawn_group",
        params: { template: "infantry_squad", position: [100, 0, 100] },
      },
    ];

    const result = validateCommands(commands, state());

    expect(result.commands.map((command) => command.command_id)).toEqual(["move", "spawn"]);
    expect(result.manpowerSpent).toBe(6);
    expect(result.rejected[0]?.reason).toBe("active group cap exceeded");
  });

  it("rejects commands targeting water or explicitly non-traversable cells", () => {
    const terrainState = {
      ...state(),
      mapBriefing: {
        ...state().mapBriefing,
        grid_size: 2,
        grid_width: 2,
        grid_height: 2,
        grid_resolution_meters: 10,
        terrain_grid: [
          {
            grid: [0, 0] as const,
            type: "water" as const,
            cover: "none" as const,
            elevation: 0,
            traversable: true,
          },
          {
            grid: [0, 1] as const,
            type: "field" as const,
            cover: "light" as const,
            elevation: 0,
            traversable: false,
          },
          {
            grid: [1, 0] as const,
            type: "road" as const,
            cover: "none" as const,
            elevation: 0,
            traversable: true,
          },
        ],
      },
    };
    const commands: Command[] = [
      {
        command_id: "water",
        type: "move_group",
        params: { group_id: "owned", destination: [5, 0, 5] },
      },
      {
        command_id: "blocked",
        type: "move_group",
        params: { group_id: "owned", destination: [5, 0, 15] },
      },
      {
        command_id: "road",
        type: "move_group",
        params: { group_id: "owned", destination: [15, 0, 5] },
      },
      {
        command_id: "unclassified",
        type: "move_group",
        params: { group_id: "owned", destination: [15, 0, 15] },
      },
    ];

    const result = validateCommands(commands, terrainState);

    expect(result.commands.map((command) => command.command_id)).toEqual(["road"]);
    expect(result.rejected).toEqual([
      { commandId: "water", reason: "position is outside the playable map" },
      { commandId: "blocked", reason: "position is outside the playable map" },
      { commandId: "unclassified", reason: "position is outside the playable map" },
    ]);
  });

  it("keeps command ids server-owned and monotonic across decisions in one tick", () => {
    const proposal = {
      type: "move_group" as const,
      params: { group_id: "owned", destination: [200, 0, 200] as const },
    };
    const first = materializeCommandProposals([proposal], 1);
    const second = materializeCommandProposals([proposal], 2);

    expect(first[0]?.command_id).toBe("cmd_00000001");
    expect(second[0]?.command_id).toBe("cmd_00000002");
    expect(() =>
      Schema.decodeUnknownSync(AiDecision, {
        onExcessProperty: "error",
      })({
        summary: "Do not trust this id",
        commands: [{ ...proposal, command_id: "model-controlled" }],
      }),
    ).toThrow();
    expect(
      Schema.decodeUnknownSync(AiDecision)({
        summary: "Server allocates ids",
        commands: [proposal],
      }).commands[0],
    ).not.toHaveProperty("command_id");
  });
});
