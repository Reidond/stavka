import { Effect } from "effect";
import type { Decision } from "./domain";
import { randomController, ruleController } from "./controllers";
import {
  defaultDecisionEveryTicks,
  scenarioFamilies,
  scenarioFor,
  type ScenarioFamily,
} from "./benchmark";
import { score, step } from "./sim";
import { calibrationSeeds, fullStudySeeds } from "./study";

export interface CalibrationFamilyResult {
  readonly runs: number;
  readonly meanScoreDelta: number;
  readonly ruleWinRate: number;
  readonly ties: number;
  readonly distinctScoreDeltas: number;
}

export interface CalibrationResult {
  readonly seedsPerFamily: number;
  readonly holdoutDisjoint: boolean;
  readonly byteIdenticalReplay: boolean;
  readonly ruleBeatsRandom: boolean;
  readonly outcomesNonDegenerate: boolean;
  readonly familiesDistinguishable: boolean;
  readonly finiteScores: boolean;
  readonly families: Readonly<Record<ScenarioFamily, CalibrationFamilyResult>>;
  readonly ok: boolean;
}

interface CalibrationRow {
  readonly family: ScenarioFamily;
  readonly seed: number;
  readonly ruleScore: number;
  readonly randomScore: number;
}

const mean = (values: readonly number[]): number =>
  values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;

const runCalibrationRow = (seed: number, family: ScenarioFamily) =>
  Effect.gen(function* () {
    let state = scenarioFor(seed, family);
    const blue = ruleController("blue");
    const red = randomController("red");
    let blueDecision: Decision = { orders: [] };
    let redDecision: Decision = { orders: [] };
    for (let tick = 0; tick < 40; tick += 1) {
      if (tick % defaultDecisionEveryTicks === 0) {
        [blueDecision, redDecision] = yield* Effect.all([blue(state), red(state)], {
          concurrency: "unbounded",
        });
      }
      state = step(state, [blueDecision, redDecision]);
    }
    return {
      family,
      seed,
      ruleScore: score(state, "blue"),
      randomScore: score(state, "red"),
    } satisfies CalibrationRow;
  });

const runRows = (): Effect.Effect<ReadonlyArray<CalibrationRow>, Error> =>
  Effect.forEach(
    scenarioFamilies.flatMap((family) => calibrationSeeds.map((seed) => ({ family, seed }))),
    ({ family, seed }) => runCalibrationRow(seed, family),
    { concurrency: 1 },
  );

export const runCalibration = (): Effect.Effect<CalibrationResult, Error> =>
  Effect.gen(function* () {
    const first = yield* runRows();
    const second = yield* runRows();
    const families = Object.fromEntries(
      scenarioFamilies.map((family) => {
        const rows = first.filter((row) => row.family === family);
        const deltas = rows.map((row) => row.ruleScore - row.randomScore);
        return [
          family,
          {
            runs: rows.length,
            meanScoreDelta: mean(deltas),
            ruleWinRate:
              rows.filter((row) => row.ruleScore > row.randomScore).length /
              Math.max(1, rows.length),
            ties: rows.filter((row) => row.ruleScore === row.randomScore).length,
            distinctScoreDeltas: new Set(deltas).size,
          },
        ];
      }),
    ) as Record<ScenarioFamily, CalibrationFamilyResult>;
    const allDeltas = first.map((row) => row.ruleScore - row.randomScore);
    const familyMeans = scenarioFamilies.map((family) => families[family].meanScoreDelta);
    const holdoutDisjoint = fullStudySeeds.every((seed) => !calibrationSeeds.includes(seed));
    const byteIdenticalReplay = JSON.stringify(first) === JSON.stringify(second);
    const ruleBeatsRandom = scenarioFamilies.every(
      (family) => families[family].meanScoreDelta > 0 && families[family].ruleWinRate >= 0.6,
    );
    const outcomesNonDegenerate =
      allDeltas.some((delta) => delta !== 0) && new Set(allDeltas).size > 1;
    const familiesDistinguishable = new Set(familyMeans.map((value) => value.toFixed(6))).size > 1;
    const finiteScores = first.every(
      (row) => Number.isFinite(row.ruleScore) && Number.isFinite(row.randomScore),
    );
    return {
      seedsPerFamily: calibrationSeeds.length,
      holdoutDisjoint,
      byteIdenticalReplay,
      ruleBeatsRandom,
      outcomesNonDegenerate,
      familiesDistinguishable,
      finiteScores,
      families,
      ok:
        holdoutDisjoint &&
        byteIdenticalReplay &&
        ruleBeatsRandom &&
        outcomesNonDegenerate &&
        familiesDistinguishable &&
        finiteScores,
    };
  });
