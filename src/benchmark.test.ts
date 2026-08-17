import { describe, expect, it } from "vitest";
import {
  currentEvidenceSchemaVersion,
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
  requestFailures = 0,
  legacy = false,
): SeedResult[] =>
  scenarioFamilies.flatMap((family) =>
    Array.from({ length: minimumRunsPerFamily }, (_, index) => ({
      ...(legacy ? {} : { schemaVersion: currentEvidenceSchemaVersion }),
      seed: index + 1,
      family,
      controller,
      score,
      opponentScore: -score,
      won,
      invalidDecisions,
      requestFailures,
      decisionCount: 8,
      decisionLatenciesMs: controller === "codex" && requestFailures < 8 ? [latencyMs] : [],
      failureMessages: requestFailures > 0 ? ["request: test provider failure"] : [],
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
    expect(result.evidenceReady).toBe(true);
    expect(result.status).toBe("PASS");
    expect(Object.values(result.gates).every(Boolean)).toBe(true);
  });

  it("fails a sufficiently sampled model with excessive invalid decisions", () => {
    const baseline = summarize("rule", rows("rule", 100, false));
    const candidate = summarize("codex", rows("codex", 120, true, 1, 1000));
    const result = evaluateHypothesis(baseline, candidate);
    expect(result.sampleReady).toBe(true);
    expect(result.evidenceReady).toBe(true);
    expect(result.gates.invalidDecisionRate).toBe(false);
    expect(result.status).toBe("FAIL");
  });

  it("keeps a fully sampled provider outage inconclusive", () => {
    const baseline = summarize("rule", rows("rule", 100, false));
    const candidate = summarize("codex", rows("codex", 0, false, 0, 0, 8));
    const result = evaluateHypothesis(baseline, candidate);
    expect(result.sampleReady).toBe(true);
    expect(result.evidenceReady).toBe(false);
    expect(result.gates.requestReliability).toBe(false);
    expect(candidate.modelResponseCount).toBe(0);
    expect(candidate.requestFailureRate).toBe(1);
    expect(result.status).toBe("INCONCLUSIVE");
  });

  it("does not mix legacy rows with the current evidence protocol", () => {
    const baseline = summarize("rule", rows("rule", 100, false));
    const candidate = summarize("codex", rows("codex", 120, true, 0, 1000, 0, true));
    const result = evaluateHypothesis(baseline, candidate);
    expect(candidate.legacyRuns).toBe(candidate.runs);
    expect(result.sampleReady).toBe(true);
    expect(result.evidenceReady).toBe(false);
    expect(result.status).toBe("INCONCLUSIVE");
  });
});
