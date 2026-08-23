import { describe, expect, it } from "vitest";
import {
  analyzePairedResults,
  currentEvidenceSchemaVersion,
  evaluateHypothesis,
  scenarioFamilies,
  summarize,
  type StudyEvidenceObject,
  type StudyResult,
} from "@stavka/warbench-core";
import { renderStudyEvidencePdf } from "../src/pdf-report";

const results: StudyResult[] = scenarioFamilies
  .flatMap((family) =>
    Array.from({ length: 10 }, (_, index) => {
      const base = {
        schemaVersion: currentEvidenceSchemaVersion,
        studyId: "warbench-study-v2",
        attempt: 1 as const,
        recordedAt: "2026-08-23T01:00:00.000Z",
        seed: 1_000 + index,
        family,
        opponentScore: -100,
        invalidDecisions: 0,
        requestFailures: 0,
        decisionCount: 8,
        failureMessages: [],
      };
      return [
        {
          ...base,
          controller: "rule" as const,
          score: 100,
          won: false,
          decisionLatenciesMs: [],
        },
        {
          ...base,
          controller: "codex" as const,
          score: 120,
          won: true,
          decisionLatenciesMs: [500],
          model: "gpt-5.1-codex-mini",
        },
      ];
    }),
  )
  .flat();

const baseline = summarize(
  "rule",
  results.filter((result) => result.controller === "rule"),
);
const candidate = summarize(
  "codex",
  results.filter((result) => result.controller === "codex"),
);
const hypothesis = evaluateHypothesis(baseline, candidate);
const evidence: StudyEvidenceObject = {
  manifest: {
    id: "warbench-study-v2",
    mode: "full",
    status: "completed",
    protocolVersion: "2",
    evidenceSchemaVersion: currentEvidenceSchemaVersion,
    gitSha: "abcdef1234567890",
    piVersion: "0.84.2",
    modelId: "gpt-5.1-codex-mini",
    promptHash: "f".repeat(64),
    seeds: Array.from({ length: 10 }, (_, index) => 1_000 + index),
    families: scenarioFamilies,
    decisionEveryTicks: 5,
    createdAt: "2026-08-23T00:00:00.000Z",
    startedAt: "2026-08-23T00:30:00.000Z",
    completedAt: "2026-08-23T02:00:00.000Z",
    completionDigest: "a".repeat(64),
  },
  baseline,
  candidate,
  hypothesis: {
    status: hypothesis.status,
    gates: hypothesis.gates,
    sampleReady: hypothesis.sampleReady,
    evidenceReady: hypothesis.evidenceReady,
  },
  paired: analyzePairedResults(results),
  results,
  digest: "a".repeat(64),
};

describe("study evidence PDF", () => {
  it("renders authoritative immutable metadata and paired analysis byte-stably", () => {
    const first = renderStudyEvidencePdf(evidence);
    const second = renderStudyEvidencePdf(evidence);
    const decoded = new TextDecoder().decode(first);
    expect(decoded.slice(0, 8)).toBe("%PDF-1.4");
    expect(decoded).toContain("Study ID: warbench-study-v2");
    expect(decoded).toContain("Exact model ID: gpt-5.1-codex-mini");
    expect(decoded).toContain("Completed: 2026-08-23T02:00:00.000Z");
    expect(decoded).toContain("Paired analysis");
    expect(first).toEqual(second);
    expect(first.byteLength).toBeGreaterThan(1_000);
  });
});
