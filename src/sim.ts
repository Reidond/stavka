import { Effect } from "effect";
import type { Decision, Observation, Side, Unit, Vec2 } from "./domain";

const distance = (a: Vec2, b: Vec2) => Math.hypot(a.x - b.x, a.y - b.y);
const enemySide = (side: Side): Side => (side === "blue" ? "red" : "blue");

const seeded = (seed: number) => {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    return state / 2 ** 32;
  };
};

export const makeScenario = (seed: number): Observation => {
  const random = seeded(seed);
  const units: Unit[] = [];
  for (let index = 0; index < 6; index += 1) {
    units.push(
      {
        id: `b${index}`,
        side: "blue",
        hp: 100,
        attack: 18 + Math.floor(random() * 8),
        position: { x: 8 + random() * 8, y: 10 + index * 12 },
      },
      {
        id: `r${index}`,
        side: "red",
        hp: 100,
        attack: 18 + Math.floor(random() * 8),
        position: { x: 84 - random() * 8, y: 10 + index * 12 },
      },
    );
  }
  return {
    tick: 0,
    units,
    objectives: [
      { id: "north", position: { x: 50, y: 25 }, owner: "neutral" },
      { id: "south", position: { x: 50, y: 75 }, owner: "neutral" },
    ],
  };
};

const stepToward = (from: Vec2, to: Vec2, speed = 7): Vec2 => {
  const d = distance(from, to);
  if (d === 0 || d <= speed) return { ...to };
  return {
    x: from.x + ((to.x - from.x) * speed) / d,
    y: from.y + ((to.y - from.y) * speed) / d,
  };
};

export const step = (state: Observation, decisions: readonly Decision[]): Observation => {
  const orders = new Map(
    decisions.flatMap((decision) => decision.orders).map((order) => [order.unitId, order]),
  );
  const units = state.units.map((unit) => ({ ...unit, position: { ...unit.position } }));
  const byId = new Map(units.map((unit) => [unit.id, unit]));

  for (const unit of units) {
    if (unit.hp <= 0) continue;
    const order = orders.get(unit.id);
    if (!order) continue;
    if (order.type === "move") unit.position = stepToward(unit.position, order.target);
    if (order.type === "attack") {
      const target = byId.get(order.targetId);
      if (
        target &&
        target.hp > 0 &&
        target.side !== unit.side &&
        distance(unit.position, target.position) <= 22
      ) {
        target.hp = Math.max(0, target.hp - unit.attack);
      }
    }
  }

  const objectives = state.objectives.map((objective) => {
    const nearby = units.filter(
      (unit) => unit.hp > 0 && distance(unit.position, objective.position) <= 12,
    );
    const blue = nearby.filter((unit) => unit.side === "blue").length;
    const red = nearby.filter((unit) => unit.side === "red").length;
    return {
      ...objective,
      owner: blue > red ? ("blue" as const) : red > blue ? ("red" as const) : objective.owner,
    };
  });

  return { tick: state.tick + 1, units, objectives };
};

export const score = (state: Observation, side: Side): number => {
  const hp = state.units
    .filter((unit) => unit.side === side)
    .reduce((sum, unit) => sum + unit.hp, 0);
  const enemyHp = state.units
    .filter((unit) => unit.side === enemySide(side))
    .reduce((sum, unit) => sum + unit.hp, 0);
  const objectives = state.objectives.filter((objective) => objective.owner === side).length;
  return hp - enemyHp + objectives * 150;
};

export type Controller = (observation: Observation) => Effect.Effect<Decision, Error>;

export const runMatch = (initial: Observation, blue: Controller, red: Controller, ticks = 40) =>
  Effect.gen(function* () {
    let state = structuredClone(initial);
    for (let tick = 0; tick < ticks; tick += 1) {
      const decisions = yield* Effect.all([blue(state), red(state)], { concurrency: "unbounded" });
      state = step(state, decisions);
    }
    return { state, blueScore: score(state, "blue"), redScore: score(state, "red") };
  });
