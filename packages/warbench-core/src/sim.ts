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
  // Select duplicate orders by their canonical encoding rather than input
  // order. Valid controllers never duplicate a unit, but this makes the pure
  // simulator invariant to decision and order-array permutations as well.
  const orders = new Map<string, Decision["orders"][number]>();
  for (const order of decisions.flatMap((decision) => decision.orders)) {
    const current = orders.get(order.unitId);
    if (!current || JSON.stringify(order) < JSON.stringify(current))
      orders.set(order.unitId, order);
  }

  // Phase 1: every movement resolves from the tick-start snapshot.
  const movedUnits = state.units
    .map((unit) => {
      const copy = { ...unit, position: { ...unit.position } };
      const order = orders.get(unit.id);
      if (unit.hp > 0 && order?.type === "move") {
        copy.position = stepToward(unit.position, order.target);
      }
      return copy;
    })
    .sort((left, right) => left.id.localeCompare(right.id));
  const postMovementById = new Map(movedUnits.map((unit) => [unit.id, unit]));

  // Phase 2: evaluate all attacks from one post-movement snapshot and aggregate
  // damage. No attacker can remove another attacker's turn by appearing first.
  const damageByTarget = new Map<string, number>();
  for (const unit of movedUnits) {
    if (unit.hp <= 0) continue;
    const order = orders.get(unit.id);
    if (order?.type !== "attack") continue;
    const target = postMovementById.get(order.targetId);
    if (
      target &&
      target.hp > 0 &&
      target.side !== unit.side &&
      distance(unit.position, target.position) <= 22
    ) {
      damageByTarget.set(target.id, (damageByTarget.get(target.id) ?? 0) + unit.attack);
    }
  }

  // Phase 3: apply the aggregate simultaneously.
  const units = movedUnits.map((unit) => ({
    ...unit,
    hp: Math.max(0, unit.hp - (damageByTarget.get(unit.id) ?? 0)),
  }));

  // Phase 4: objectives observe the final living-unit set for this tick.
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
