import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { runCalibration } from "../src/calibration";
import { calibrationSeeds, fullStudySeeds } from "../src/study";

describe("offline benchmark calibration", () => {
  it("keeps calibration and held-out seeds disjoint", () => {
    expect(fullStudySeeds).toHaveLength(10);
    expect(new Set(fullStudySeeds).size).toBe(fullStudySeeds.length);
    expect(fullStudySeeds.every((seed) => seed > 20)).toBe(true);
    expect(fullStudySeeds.every((seed) => !calibrationSeeds.includes(seed))).toBe(true);
  });

  it("is deterministic, finite, non-degenerate, and lets rule beat random", async () => {
    const result = await Effect.runPromise(runCalibration());
    expect(result).toMatchObject({
      seedsPerFamily: 100,
      holdoutDisjoint: true,
      byteIdenticalReplay: true,
      ruleBeatsRandom: true,
      outcomesNonDegenerate: true,
      familiesDistinguishable: true,
      finiteScores: true,
      ok: true,
    });
  });
});
