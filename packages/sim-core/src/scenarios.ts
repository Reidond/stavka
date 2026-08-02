import type { Vector3 } from "@stavka/protocol";

import { createWorld, issueWaypoint, spawnGroup, spawnVehicle, stepWorldMany } from "./world";
import type { SimWorldState } from "./types";

export interface ScenarioDefinition {
  readonly id: string;
  readonly version: number;
  readonly name: string;
  readonly description: string;
  readonly setup: (seed: number) => SimWorldState;
}

const readyGroup = (
  world: SimWorldState,
  id: string,
  faction: string,
  position: Vector3,
  strength: number,
): void => {
  spawnGroup(world, { id, faction, template: "infantry_squad", position, strength });
};

export const scenarios: Record<string, ScenarioDefinition> = {
  movement: {
    id: "movement",
    version: 1,
    name: "Forced Move Drill",
    description: "A single squad crosses 250 metres under a ForcedMove order.",
    setup: (seed) => {
      const world = createWorld({ seed });
      readyGroup(world, "blue_1", "BLUFOR", [0, 0, 0], 6);
      issueWaypoint(world, "blue_1", "forced_move", [250, 0, 0]);
      return world;
    },
  },
  engagement: {
    id: "engagement",
    version: 1,
    name: "Six versus Four",
    description: "The Test 11 attritional combat baseline at 150 metres.",
    setup: (seed) => {
      const world = createWorld({ seed });
      readyGroup(world, "blue_1", "BLUFOR", [0, 0, 0], 6);
      readyGroup(world, "red_1", "OPFOR", [150, 0, 0], 4);
      issueWaypoint(world, "blue_1", "attack", [150, 0, 0]);
      issueWaypoint(world, "red_1", "attack", [0, 0, 0]);
      return world;
    },
  },
  mechanized: {
    id: "mechanized",
    version: 1,
    name: "Mechanized Lifecycle",
    description: "A squad, UAZ469, and a 500 metre destination.",
    setup: (seed) => {
      const world = createWorld({ seed });
      readyGroup(world, "red_1", "OPFOR", [0, 0, 0], 5);
      spawnVehicle(world, {
        id: "uaz_1",
        template: "UAZ469",
        position: [5, 0, 0],
        capacity: 5,
      });
      return world;
    },
  },
};

export const createScenario = (id: string, seed: number): SimWorldState => {
  const scenario = scenarios[id] ?? scenarios.movement;
  if (!scenario) throw new Error("No scenarios configured");
  const world = scenario.setup(seed);
  stepWorldMany(world, 10);
  return world;
};
