import { describe, expect, it } from "vitest";
import { evaluateHypothesis, scenarioFamilies, summarize, type SeedResult } from "./benchmark";
import { renderHypothesisPdf } from "./pdf-report";

const baselineRows: SeedResult[] = scenarioFamilies.flatMap((family) =>
  Array.from({ length: 10 }, (_, index) => ({
    seed: index + 1,
    family,
    controller: "rule" as const,
    score: 100,
    opponentScore: -100,
    won: false,
    invalidDecisions: 0,
    decisionCount: 8,
    decisionLatenciesMs: [],
  })),
);

describe("pdf report", () => {
  it("produces a valid PDF header from the mechanical hypothesis result", () => {
    const hypothesis = evaluateHypothesis(summarize("rule", baselineRows));
    const pdf = renderHypothesisPdf(hypothesis);
    expect(new TextDecoder().decode(pdf.slice(0, 8))).toBe("%PDF-1.4");
    expect(pdf.byteLength).toBeGreaterThan(500);
  });
});
