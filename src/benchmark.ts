import { Effect } from "effect";
import type { CodexCredentials } from "./codex-auth";
import { CodexControllerError, decideWithCodex } from "./codex-controller";
import { ruleController } from "./controllers";
import type { Decision, Observation } from "./domain";
import { makeScenario, score, step } from "./sim";

export const scenarioFamilies = ["balanced", "north-pressure", "south-pressure"] as const;
export type ScenarioFamily = (typeof scenarioFamilies)[number];
export const minimumRunsPerFamily = 10;
export const defaultDecisionEveryTicks = 5;

export interface SeedResult {
  readonly seed: number;
  readonly family: ScenarioFamily;
  readonly controller: "rule" | "codex";
  readonly score: number;
  readonly opponentScore: number;
  readonly won: boolean;
  readonly invalidDecisions: number;
  readonly decisionCount: number;
  readonly decisionLatenciesMs: readonly number[];
  readonly model?: string;
}

export interface BenchmarkSummary {
  readonly controller: "rule" | "codex";
  readonly runs: number;
  readonly meanScore: number;
  readonly winRate: number;
  readonly invalidDecisionRate: number;
  readonly p95DecisionLatencyMs: number;
  readonly families: Readonly<
    Record<ScenarioFamily, { meanScore: number; winRate: number; runs: number }>
  >;
}

export interface HypothesisResult {
  readonly status: "PASS" | "FAIL" | "INCONCLUSIVE";
  readonly baseline: BenchmarkSummary;
  readonly candidate?: BenchmarkSummary;
  readonly sampleReady: boolean;
  readonly gates: {
    readonly meanScoreImprovement: boolean;
    readonly winRateImprovement: boolean;
    readonly invalidDecisionRate: boolean;
    readonly latency: boolean;
    readonly familyRegression: boolean;
  };
}

const applyFamily = (observation: Observation, family: ScenarioFamily): Observation => {
  if (family === "balanced") return observation;
  const pressureY = family === "north-pressure" ? 25 : 75;
  return {
    ...observation,
    units: observation.units.map((unit) =>
      unit.side === "red"
        ? {
            ...unit,
            position: {
              x: Math.max(58, unit.position.x - 12),
              y: unit.position.y + (pressureY - unit.position.y) * 0.35,
            },
          }
        : unit,
    ),
  };
};

export const scenarioFor = (seed: number, family: ScenarioFamily): Observation =>
  applyFamily(makeScenario(seed), family);

const percentile95 = (values: readonly number[]): number => {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)] ?? 0;
};

const mean = (values: readonly number[]): number =>
  values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;

export const summarize = (
  controller: "rule" | "codex",
  results: readonly SeedResult[],
): BenchmarkSummary => {
  const latencies = results.flatMap((result) => result.decisionLatenciesMs);
  const decisions = results.reduce((sum, result) => sum + result.decisionCount, 0);
  const invalid = results.reduce((sum, result) => sum + result.invalidDecisions, 0);
  const families = Object.fromEntries(
    scenarioFamilies.map((family) => {
      const familyResults = results.filter((result) => result.family === family);
      return [
        family,
        {
          meanScore: mean(familyResults.map((result) => result.score)),
          winRate:
            familyResults.length === 0
              ? 0
              : familyResults.filter((result) => result.won).length / familyResults.length,
          runs: familyResults.length,
        },
      ];
    }),
  ) as Record<ScenarioFamily, { meanScore: number; winRate: number; runs: number }>;

  return {
    controller,
    runs: results.length,
    meanScore: mean(results.map((result) => result.score)),
    winRate:
      results.length === 0 ? 0 : results.filter((result) => result.won).length / results.length,
    invalidDecisionRate: decisions === 0 ? 0 : invalid / decisions,
    p95DecisionLatencyMs: percentile95(latencies),
    families,
  };
};

export const evaluateHypothesis = (
  baseline: BenchmarkSummary,
  candidate?: BenchmarkSummary,
): HypothesisResult => {
  const sampleReady =
    candidate !== undefined &&
    scenarioFamilies.every(
      (family) =>
        baseline.families[family].runs >= minimumRunsPerFamily &&
        candidate.families[family].runs >= minimumRunsPerFamily,
    );

  if (!candidate) {
    return {
      status: "INCONCLUSIVE",
      baseline,
      sampleReady,
      gates: {
        meanScoreImprovement: false,
        winRateImprovement: false,
        invalidDecisionRate: false,
        latency: false,
        familyRegression: false,
      },
    };
  }

  const scoreDenominator = Math.max(1, Math.abs(baseline.meanScore));
  const meanScoreImprovement =
    (candidate.meanScore - baseline.meanScore) / scoreDenominator >= 0.05;
  const winRateImprovement = candidate.winRate - baseline.winRate >= 0.05;
  const invalidDecisionRate = candidate.invalidDecisionRate <= 0.02;
  const latency = candidate.p95DecisionLatencyMs <= 5_000;
  const familyRegression = scenarioFamilies.every((family) => {
    const baselineFamily = baseline.families[family];
    const candidateFamily = candidate.families[family];
    const denominator = Math.max(1, Math.abs(baselineFamily.meanScore));
    return (candidateFamily.meanScore - baselineFamily.meanScore) / denominator >= -0.1;
  });
  const gates = {
    meanScoreImprovement,
    winRateImprovement,
    invalidDecisionRate,
    latency,
    familyRegression,
  };
  return {
    status: sampleReady ? (Object.values(gates).every(Boolean) ? "PASS" : "FAIL") : "INCONCLUSIVE",
    baseline,
    candidate,
    sampleReady,
    gates,
  };
};

export const runRuleSeed = (
  seed: number,
  family: ScenarioFamily,
  ticks = 40,
  decisionEveryTicks = defaultDecisionEveryTicks,
) =>
  Effect.gen(function* () {
    let state = scenarioFor(seed, family);
    const blue = ruleController("blue");
    const red = ruleController("red");
    let blueDecision: Decision = { orders: [] };
    let redDecision: Decision = { orders: [] };
    let decisionCount = 0;
    for (let tick = 0; tick < ticks; tick += 1) {
      if (tick % decisionEveryTicks === 0) {
        decisionCount += 1;
        [blueDecision, redDecision] = yield* Effect.all([blue(state), red(state)], {
          concurrency: "unbounded",
        });
      }
      state = step(state, [blueDecision, redDecision]);
    }
    const blueScore = score(state, "blue");
    const redScore = score(state, "red");
    return {
      seed,
      family,
      controller: "rule" as const,
      score: blueScore,
      opponentScore: redScore,
      won: blueScore > redScore,
      invalidDecisions: 0,
      decisionCount,
      decisionLatenciesMs: [],
    } satisfies SeedResult;
  });

export const runCodexSeed = (
  seed: number,
  family: ScenarioFamily,
  credentials: CodexCredentials,
  requestedModel?: string,
  ticks = 40,
  decisionEveryTicks = defaultDecisionEveryTicks,
) =>
  Effect.gen(function* () {
    let state = scenarioFor(seed, family);
    const red = ruleController("red");
    let blueDecision: Decision = { orders: [] };
    let redDecision: Decision = { orders: [] };
    let invalidDecisions = 0;
    let decisionCount = 0;
    const decisionLatenciesMs: number[] = [];
    let resolvedModel: string | undefined;

    for (let tick = 0; tick < ticks; tick += 1) {
      if (tick % decisionEveryTicks === 0) {
        decisionCount += 1;
        const started = performance.now();
        const candidate = yield* Effect.result(
          decideWithCodex(state, "blue", credentials, requestedModel),
        );
        if (candidate._tag === "Success") {
          blueDecision = candidate.success.decision;
          decisionLatenciesMs.push(candidate.success.latencyMs);
          resolvedModel = candidate.success.model;
        } else {
          invalidDecisions += 1;
          decisionLatenciesMs.push(performance.now() - started);
          blueDecision = { orders: [] };
          const failure = candidate.failure;
          if (failure instanceof CodexControllerError && failure.reason === "model") {
            return yield* Effect.fail(failure);
          }
        }
        redDecision = yield* red(state);
      }
      state = step(state, [blueDecision, redDecision]);
    }

    const blueScore = score(state, "blue");
    const redScore = score(state, "red");
    return {
      seed,
      family,
      controller: "codex" as const,
      score: blueScore,
      opponentScore: redScore,
      won: blueScore > redScore,
      invalidDecisions,
      decisionCount,
      decisionLatenciesMs,
      ...(resolvedModel ? { model: resolvedModel } : {}),
    } satisfies SeedResult;
  });