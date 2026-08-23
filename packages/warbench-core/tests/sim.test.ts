import { describe, expect, it } from "vitest";
import { Effect } from "effect";
import { ruleController } from "../src/controllers";
import { makeScenario, runMatch, step } from "../src/sim";

describe("warbench deterministic controls", () => {
  it("generates identical scenarios for the same seed", () => {
    expect(makeScenario(42)).toEqual(makeScenario(42));
  });

  it("replays rule-vs-rule identically", async () => {
    const run = () =>
      Effect.runPromise(runMatch(makeScenario(7), ruleController("blue"), ruleController("red")));
    expect(await run()).toEqual(await run());
  });

  it("keeps a symmetric rule-vs-rule baseline bounded", async () => {
    const result = await Effect.runPromise(
      runMatch(makeScenario(21), ruleController("blue"), ruleController("red")),
    );
    expect(Number.isFinite(result.blueScore)).toBe(true);
    expect(Number.isFinite(result.redScore)).toBe(true);
  });

  it("resolves combat simultaneously and is invariant to unit/decision/order permutations", () => {
    const state = {
      tick: 4,
      units: [
        { id: "b0", side: "blue" as const, hp: 20, attack: 25, position: { x: 45, y: 50 } },
        { id: "r0", side: "red" as const, hp: 20, attack: 25, position: { x: 55, y: 50 } },
        { id: "b1", side: "blue" as const, hp: 100, attack: 10, position: { x: 10, y: 10 } },
        { id: "r1", side: "red" as const, hp: 100, attack: 10, position: { x: 90, y: 90 } },
      ],
      objectives: [
        { id: "north", position: { x: 50, y: 25 }, owner: "neutral" as const },
        { id: "south", position: { x: 50, y: 75 }, owner: "neutral" as const },
      ],
    };
    const blue = {
      orders: [
        { unitId: "b0", type: "attack" as const, targetId: "r0" },
        { unitId: "b1", type: "move" as const, target: { x: 50, y: 25 } },
      ],
    };
    const red = {
      orders: [
        { unitId: "r0", type: "attack" as const, targetId: "b0" },
        { unitId: "r1", type: "move" as const, target: { x: 50, y: 75 } },
      ],
    };

    const expected = step(state, [blue, red]);
    expect(expected.units.find((unit) => unit.id === "b0")?.hp).toBe(0);
    expect(expected.units.find((unit) => unit.id === "r0")?.hp).toBe(0);
    expect(step({ ...state, units: [...state.units].reverse() }, [blue, red])).toEqual(expected);
    expect(step(state, [red, blue])).toEqual(expected);
    expect(
      step(state, [{ orders: [...blue.orders].reverse() }, { orders: [...red.orders].reverse() }]),
    ).toEqual(expected);
  });
});
