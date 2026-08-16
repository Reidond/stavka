import { describe, expect, it } from "vitest";
import {
  evaluateHypothesis,
  minimumRunsPerFamily,
  scenarioFamilies,
  summarize,
  type SeedResult,
} from "./benchmark";

const rows = (
  controller: "rule" | "codex",
  score: number,
  won: boolean,
  invalidDecisions = 0,
  latencyMs = 0,
): SeedResult[] =>
  scenarioFamilies.flatMap((family) =>
    Array.from({ length: minimumRunsPerFamily }, (_, index) => ({
      seed: index + 1,
      family,
      controller,
      score,
      opponentScore: -score,
      won,
      invalidDecisions,
      decisionCount: 8,
      decisionLatenciesMs: controller === "codex" ? [latencyMs] : [],
    })),
  );

describe("hypothesis evaluation", () => {
  it("remains inconclusive below the minimum sample", () => {
    const baseline = summarize("rule", rows("rule", 100, false).slice(0, 3));
    const candidate = summarize("codex", rows("codex", 120, true, 0, 1000).slice(0, 3));
    expect(evaluateHypothesis(baseline, candidate).status).toBe("INCONCLUSIVE");
  });

  it("passes only when every gate is satisfied", () => {
    const baseline = summarize("rule", rows("rule", 100, false));
    const candidate = summarize("codex", rows("codex", 120, true, 0, 1000));
    const result = evaluateHypothesis(baseline, candidate);
    expect(result.sampleReady).toBe(true);
    expect(result.status).toBe("PASS");
    expect(Object.values(result.gates).every(Boolean)).toBe(true);
  });

  it("fails a sufficiently sampled candidate with excessive invalid decisions", () => {
    const baseline = summarize("rule", rows("rule", 100, false));
    const candidate = summarize("codex", rows("codex", 120, true, 1, 1000));
    const result = evaluateHypothesis(baseline, candidate);
    expect(result.sampleReady).toBe(true);
    expect(result.gates.invalidDecisionRate).toBe(false);
    expect(result.status).toBe("FAIL");
  });
});
