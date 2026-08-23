import { Effect } from "effect";
import type { Observation, Order, Side } from "./domain";
import type { Controller } from "./sim";

const distance = (a: { x: number; y: number }, b: { x: number; y: number }) =>
  Math.hypot(a.x - b.x, a.y - b.y);

const deterministicChoice = (value: string): number => {
  let hash = 0x81_1c_9d_c5;
  for (const character of value) {
    hash ^= character.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 0x01_00_01_93);
  }
  return hash >>> 0;
};

export const ruleController =
  (side: Side): Controller =>
  (observation: Observation) =>
    Effect.succeed({
      orders: observation.units
        .filter((unit) => unit.side === side && unit.hp > 0)
        .map((unit): Order => {
          const enemies = observation.units
            .filter((candidate) => candidate.side !== side && candidate.hp > 0)
            .sort(
              (left, right) =>
                distance(unit.position, left.position) - distance(unit.position, right.position),
            );
          const enemy = enemies[0];
          if (enemy && distance(unit.position, enemy.position) <= 22) {
            return { unitId: unit.id, type: "attack", targetId: enemy.id };
          }
          const objectives = observation.objectives
            .filter((objective) => objective.owner !== side)
            .sort(
              (left, right) =>
                distance(unit.position, left.position) - distance(unit.position, right.position),
            );
          const objective = objectives[0] ?? observation.objectives[0];
          return objective
            ? { unitId: unit.id, type: "move", target: objective.position }
            : { unitId: unit.id, type: "hold" };
        }),
    });

export const randomController =
  (side: Side): Controller =>
  (observation: Observation) =>
    Effect.succeed({
      orders: observation.units
        .filter((unit) => unit.side === side && unit.hp > 0)
        .map((unit): Order => {
          // Deterministic pseudo-random control: enough legal variation to be
          // reproducible calibration evidence without becoming a competent
          // tactical policy.
          const choice = deterministicChoice(
            `${observation.tick}:${unit.id}:${unit.attack}:${unit.position.x}:${unit.position.y}`,
          );
          const enemies = observation.units
            .filter(
              (candidate) =>
                candidate.side !== side &&
                candidate.hp > 0 &&
                distance(unit.position, candidate.position) <= 22,
            )
            .sort((left, right) => left.id.localeCompare(right.id));
          const enemy = enemies[choice % Math.max(1, enemies.length)];
          if (enemy && choice % 4 !== 0) {
            return { unitId: unit.id, type: "attack", targetId: enemy.id };
          }
          if (choice % 7 === 0) return { unitId: unit.id, type: "hold" };
          const index = choice % Math.max(1, observation.objectives.length);
          const objective = observation.objectives[index];
          return objective
            ? { unitId: unit.id, type: "move", target: objective.position }
            : { unitId: unit.id, type: "hold" };
        }),
    });
