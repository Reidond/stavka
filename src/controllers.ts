import { Effect } from "effect";
import type { Observation, Order, Side } from "./domain";
import type { Controller } from "./sim";

const distance = (a: { x: number; y: number }, b: { x: number; y: number }) => Math.hypot(a.x - b.x, a.y - b.y);

export const ruleController = (side: Side): Controller => (observation: Observation) =>
  Effect.succeed({
    orders: observation.units
      .filter((unit) => unit.side === side && unit.hp > 0)
      .map((unit): Order => {
        const enemies = observation.units
          .filter((candidate) => candidate.side !== side && candidate.hp > 0)
          .sort((left, right) => distance(unit.position, left.position) - distance(unit.position, right.position));
        const enemy = enemies[0];
        if (enemy && distance(unit.position, enemy.position) <= 22) {
          return { unitId: unit.id, type: "attack", targetId: enemy.id };
        }
        const objectives = observation.objectives
          .filter((objective) => objective.owner !== side)
          .sort((left, right) => distance(unit.position, left.position) - distance(unit.position, right.position));
        const objective = objectives[0] ?? observation.objectives[0];
        return objective
          ? { unitId: unit.id, type: "move", target: objective.position }
          : { unitId: unit.id, type: "hold" };
      }),
  });

export const randomController = (side: Side): Controller => (observation: Observation) =>
  Effect.succeed({
    orders: observation.units
      .filter((unit) => unit.side === side && unit.hp > 0)
      .map((unit): Order => {
        const index = (observation.tick + Number(unit.id.slice(1))) % Math.max(1, observation.objectives.length);
        const objective = observation.objectives[index];
        return objective
          ? { unitId: unit.id, type: "move", target: objective.position }
          : { unitId: unit.id, type: "hold" };
      }),
  });
