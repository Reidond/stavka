import { describe, expect, it } from "vitest";
import { Effect } from "effect";
import { ruleController } from "../src/controllers";
import { makeScenario, runMatch } from "../src/sim";

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
});
