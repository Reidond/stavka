import { Data, Effect, Schema } from "effect";
import {
  currentEvidenceSchemaVersion,
  defaultDecisionEveryTicks,
  evaluateHypothesis,
  minimumRunsPerFamily,
  runCandidateSeed,
  runRuleSeed,
  scenarioFamilies,
  summarize,
  type BenchmarkSummary,
  type HypothesisResult,
  type ScenarioFamily,
  type SeedResult,
} from "./benchmark";
import {
  jsonEvaluationController,
  type EvaluationController,
  type JsonCompleter,
} from "./controller";
import type { Side } from "./domain";

/**
 * Immutable study orchestration shared by every Warbench surface (CLI today,
 * server stores tomorrow). Persistence is a port: implementations enforce the
 * append-only rules — one attempt per slot, results rejected after terminal
 * states, completed studies never cleared.
 */

export type StudyStatus = "draft" | "running" | "completed" | "invalidated";
export type StudyArm = "rule" | "codex";

export interface StudyManifest {
  readonly id: string;
  readonly mode: "smoke" | "full";
  readonly status: StudyStatus;
  readonly protocolVersion: string;
  readonly evidenceSchemaVersion: number;
  readonly gitSha: string;
  readonly piVersion: string;
  readonly modelId: string;
  readonly promptHash: string;
  readonly seeds: readonly number[];
  readonly families: readonly ScenarioFamily[];
  readonly decisionEveryTicks: number;
  readonly createdAt: string;
  readonly startedAt?: string | undefined;
  readonly completedAt?: string | undefined;
  readonly invalidatedAt?: string | undefined;
  /** SHA-256 of the canonical completed manifest (without this field) and results. */
  readonly completionDigest?: string | undefined;
}

export interface StudyResult extends SeedResult {
  readonly studyId: string;
  /** Immutable studies never allow a second attempt for the same slot. */
  readonly attempt: 1;
  readonly recordedAt: string;
}

export const StudyManifestSchema = Schema.Struct({
  id: Schema.String,
  mode: Schema.Literals(["smoke", "full"]),
  status: Schema.Literals(["draft", "running", "completed", "invalidated"]),
  protocolVersion: Schema.String,
  evidenceSchemaVersion: Schema.Number,
  gitSha: Schema.String,
  piVersion: Schema.String,
  modelId: Schema.String,
  promptHash: Schema.String,
  seeds: Schema.Array(Schema.Number),
  families: Schema.Array(Schema.Literals(["balanced", "north-pressure", "south-pressure"])),
  decisionEveryTicks: Schema.Number,
  createdAt: Schema.String,
  startedAt: Schema.optional(Schema.String),
  completedAt: Schema.optional(Schema.String),
  invalidatedAt: Schema.optional(Schema.String),
  completionDigest: Schema.optional(Schema.String),
});

export const StudyResultSchema = Schema.Struct({
  schemaVersion: Schema.optional(Schema.Literal(currentEvidenceSchemaVersion)),
  studyId: Schema.String,
  attempt: Schema.Literal(1),
  recordedAt: Schema.String,
  seed: Schema.Number,
  family: Schema.Literals(["balanced", "north-pressure", "south-pressure"]),
  controller: Schema.Literals(["rule", "codex"]),
  score: Schema.Number,
  opponentScore: Schema.Number,
  won: Schema.Boolean,
  invalidDecisions: Schema.Number,
  requestFailures: Schema.optional(Schema.Number),
  decisionCount: Schema.Number,
  decisionLatenciesMs: Schema.Array(Schema.Number),
  failureMessages: Schema.optional(Schema.Array(Schema.String)),
  model: Schema.optional(Schema.String),
});

export class StudyConflict extends Data.TaggedError("StudyConflict")<{
  readonly message: string;
}> {}

export class StudyStateInvalid extends Data.TaggedError("StudyStateInvalid")<{
  readonly message: string;
}> {}

export class StudyNotFound extends Data.TaggedError("StudyNotFound")<{
  readonly message: string;
}> {}

export class ProviderFailure extends Data.TaggedError("ProviderFailure")<{
  readonly message: string;
  /** Sanitized transport diagnostics; never tokens, account ids, or bodies. */
  readonly diagnostic?: {
    readonly status?: number;
    readonly contentType?: string;
    readonly cfRay?: string;
    readonly cfMitigated?: string;
    readonly requestId?: string;
    readonly category?: string;
  };
}> {}

/** Append-only study persistence port. */
export interface StudyStore {
  createStudy(manifest: StudyManifest): Effect.Effect<void, StudyConflict>;
  getStudy(studyId: string): Effect.Effect<StudyManifest, StudyNotFound | StudyStateInvalid>;
  updateManifest(manifest: StudyManifest): Effect.Effect<void, StudyNotFound | StudyStateInvalid>;
  recordResult(
    result: StudyResult,
  ): Effect.Effect<void, StudyConflict | StudyStateInvalid | StudyNotFound>;
  listResults(
    studyId: string,
  ): Effect.Effect<ReadonlyArray<StudyResult>, StudyNotFound | StudyStateInvalid>;
}

export const holdoutSeedLabel = "warbench-study-v2-holdout";

const fnv1a = (value: string): number => {
  let hash = 0x81_1c_9d_c5;
  for (const character of value) {
    hash ^= character.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 0x01_00_01_93);
  }
  return hash >>> 0;
};

/** Pure, cross-runtime deterministic seed derivation for a frozen protocol label. */
export const deriveStudySeeds = (label: string, count: number): ReadonlyArray<number> => {
  const seeds: number[] = [];
  let state = fnv1a(label);
  while (seeds.length < count) {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    const seed = state & 0x7f_ff_ff_ff || 1;
    if (seed > 20 && !seeds.includes(seed)) seeds.push(seed);
  }
  return seeds;
};

export const fullStudySeeds = deriveStudySeeds(holdoutSeedLabel, minimumRunsPerFamily);

export interface CreateStudyInput {
  readonly id: string;
  readonly mode: "smoke" | "full";
  readonly protocolVersion: string;
  readonly gitSha: string;
  readonly piVersion: string;
  readonly modelId: string;
  readonly promptHash: string;
  readonly seeds?: readonly number[];
  readonly families?: readonly ScenarioFamily[];
  readonly decisionEveryTicks?: number;
  readonly now?: () => Date;
}

export const calibrationSeeds: ReadonlyArray<number> = Array.from(
  { length: 100 },
  (_, index) => index + 1,
);
const smokeSeeds: ReadonlyArray<number> = [calibrationSeeds[0] ?? 1];
const smokeFamilies: ReadonlyArray<ScenarioFamily> = [...scenarioFamilies];

export const createStudyInputToManifest = (input: CreateStudyInput): StudyManifest => ({
  id: input.id,
  mode: input.mode,
  status: "draft",
  protocolVersion: input.protocolVersion,
  evidenceSchemaVersion: currentEvidenceSchemaVersion,
  gitSha: input.gitSha,
  piVersion: input.piVersion,
  modelId: input.modelId,
  promptHash: input.promptHash,
  seeds: input.mode === "smoke" ? smokeSeeds : (input.seeds ?? fullStudySeeds),
  families: input.mode === "smoke" ? smokeFamilies : (input.families ?? [...scenarioFamilies]),
  decisionEveryTicks: input.decisionEveryTicks ?? defaultDecisionEveryTicks,
  createdAt: (input.now ?? (() => new Date()))().toISOString(),
});

/**
 * The provider seam used by the candidate arm. `probe` must observe one
 * genuine model response for the pinned request shape before any candidate
 * study may execute.
 */
export interface CandidateProvider {
  readonly probe: (
    requestedModel: string,
  ) => Effect.Effect<{ readonly model: string }, ProviderFailure>;
  readonly controllerFor: (
    requestedModel: string,
    side: Side,
  ) => Effect.Effect<EvaluationController, ProviderFailure>;
}

/** Build an EvaluationController from any JSON completer (provider adapters). */
export const controllerFromCompleter = (
  id: string,
  completer: JsonCompleter,
  side: Side,
): EvaluationController => jsonEvaluationController(id, completer, side);

const requireRunnableStudy = (
  store: StudyStore,
  studyId: string,
): Effect.Effect<StudyManifest, StudyConflict | StudyStateInvalid | StudyNotFound> =>
  Effect.gen(function* () {
    const study = yield* store.getStudy(studyId);
    if (study.status === "completed") {
      return yield* Effect.fail(
        new StudyConflict({ message: `study ${studyId} is already completed` }),
      );
    }
    if (study.status === "invalidated") {
      return yield* Effect.fail(
        new StudyStateInvalid({ message: `study ${studyId} was invalidated` }),
      );
    }
    return study;
  });

const markRunning = (store: StudyStore, studyId: string) =>
  Effect.gen(function* () {
    const study = yield* requireRunnableStudy(store, studyId);
    if (!study.startedAt) {
      yield* store.updateManifest({
        ...study,
        status: "running",
        startedAt: new Date().toISOString(),
      });
    }
  });

export const studySlotKey = (
  controller: StudyResult["controller"],
  family: ScenarioFamily,
  seed: number,
): string => `${controller}/${family}/${seed}`;

const expectedSlotKeys = (manifest: StudyManifest, arm?: StudyArm): ReadonlyArray<string> => {
  const controllers: ReadonlyArray<StudyResult["controller"]> =
    arm === "rule" ? ["rule"] : arm === "codex" ? ["codex"] : ["rule", "codex"];
  return controllers.flatMap((controller) =>
    manifest.families.flatMap((family) =>
      manifest.seeds.map((seed) => studySlotKey(controller, family, seed)),
    ),
  );
};

export const sortStudyResults = (results: readonly StudyResult[]): ReadonlyArray<StudyResult> =>
  [...results].sort(
    (left, right) =>
      left.controller.localeCompare(right.controller) ||
      left.family.localeCompare(right.family) ||
      left.seed - right.seed,
  );

export interface StudyProgress {
  readonly studyId: string;
  readonly state: StudyStatus;
  readonly expectedRuleSlots: number;
  readonly recordedRuleSlots: number;
  readonly expectedCandidateSlots: number;
  readonly recordedCandidateSlots: number;
  readonly missingSlots: ReadonlyArray<string>;
  readonly unexpectedSlots: ReadonlyArray<string>;
}

export const studyProgress = (
  manifest: StudyManifest,
  results: readonly StudyResult[],
): StudyProgress => {
  const expected = new Set(expectedSlotKeys(manifest));
  const recorded = new Set(
    results.map((result) => studySlotKey(result.controller, result.family, result.seed)),
  );
  return {
    studyId: manifest.id,
    state: manifest.status,
    expectedRuleSlots: expectedSlotKeys(manifest, "rule").length,
    recordedRuleSlots: results.filter((result) => result.controller === "rule").length,
    expectedCandidateSlots: expectedSlotKeys(manifest, "codex").length,
    recordedCandidateSlots: results.filter((result) => result.controller === "codex").length,
    missingSlots: [...expected].filter((key) => !recorded.has(key)).sort(),
    unexpectedSlots: [...recorded].filter((key) => !expected.has(key)).sort(),
  };
};

export const getStudyProgress = (
  store: StudyStore,
  studyId: string,
): Effect.Effect<StudyProgress, StudyNotFound | StudyStateInvalid> =>
  Effect.gen(function* () {
    const manifest = yield* store.getStudy(studyId);
    const results = yield* store.listResults(studyId);
    return studyProgress(manifest, results);
  });

/** Validate the frozen grid without interpreting its tactical outcome. */
export const validateStudyResults = (
  manifest: StudyManifest,
  results: readonly StudyResult[],
  requireComplete: boolean,
): StudyStateInvalid | undefined => {
  const expected = new Set(expectedSlotKeys(manifest));
  const seen = new Set<string>();
  for (const result of results) {
    const key = studySlotKey(result.controller, result.family, result.seed);
    if (seen.has(key)) {
      return new StudyStateInvalid({ message: `duplicate persisted slot ${key}` });
    }
    seen.add(key);
    if (!expected.has(key)) {
      return new StudyStateInvalid({ message: `unexpected persisted slot ${key}` });
    }
    if (result.studyId !== manifest.id || result.attempt !== 1) {
      return new StudyStateInvalid({ message: `slot ${key} does not match its frozen study` });
    }
    if (result.schemaVersion !== manifest.evidenceSchemaVersion) {
      return new StudyStateInvalid({
        message: `slot ${key} uses evidence schema ${String(result.schemaVersion)}`,
      });
    }
    if (result.controller === "codex" && result.model !== manifest.modelId) {
      return new StudyStateInvalid({
        message: `slot ${key} resolved model ${result.model ?? "unknown"}, expected ${manifest.modelId}`,
      });
    }
    const finiteValues = [result.score, result.opponentScore, ...result.decisionLatenciesMs];
    if (finiteValues.some((value) => !Number.isFinite(value))) {
      return new StudyStateInvalid({ message: `slot ${key} contains a non-finite metric` });
    }
  }
  if (requireComplete) {
    const missing = [...expected].filter((key) => !seen.has(key));
    if (missing.length > 0) {
      return new StudyStateInvalid({
        message: `study is incomplete: ${missing.length} missing slots (${missing.slice(0, 5).join(", ")})`,
      });
    }
  }
  return undefined;
};

const runRuleSlots = (store: StudyStore, study: StudyManifest) =>
  Effect.gen(function* () {
    const existing = yield* store.listResults(study.id);
    const invalid = validateStudyResults(study, existing, false);
    if (invalid) return yield* Effect.fail(invalid);
    const recorded = new Set(
      existing.map((result) => studySlotKey(result.controller, result.family, result.seed)),
    );
    const results: StudyResult[] = [];
    for (const family of study.families) {
      for (const seed of study.seeds) {
        if (recorded.has(studySlotKey("rule", family, seed))) continue;
        // The rule arm is deterministic and cannot fail; collapse the phantom
        // controller error channel into a defect.
        const seedResult = yield* runRuleSeed(seed, family, 40, study.decisionEveryTicks).pipe(
          Effect.orDie,
        );
        const result: StudyResult = {
          ...seedResult,
          studyId: study.id,
          attempt: 1,
          recordedAt: new Date().toISOString(),
        };
        yield* store.recordResult(result);
        results.push(result);
      }
    }
    return results;
  });

/** Rule arm over the manifest grid; also used for rule-only smoke studies. */
export const runRuleArm = (
  store: StudyStore,
  studyId: string,
): Effect.Effect<ReadonlyArray<StudyResult>, StudyConflict | StudyStateInvalid | StudyNotFound> =>
  Effect.gen(function* () {
    const study = yield* requireRunnableStudy(store, studyId);
    yield* markRunning(store, studyId);
    const fresh = (yield* store.getStudy(studyId)) ?? study;
    return yield* runRuleSlots(store, fresh);
  });

/** Candidate arm; refuses to start until the provider probe observes a live model response. */
export const runCandidateArm = (
  store: StudyStore,
  studyId: string,
  provider: CandidateProvider,
): Effect.Effect<
  ReadonlyArray<StudyResult>,
  StudyConflict | StudyStateInvalid | StudyNotFound | ProviderFailure
> =>
  Effect.gen(function* () {
    const study = yield* requireRunnableStudy(store, studyId);
    const existing = yield* store.listResults(studyId);
    const invalid = validateStudyResults(study, existing, false);
    if (invalid) return yield* Effect.fail(invalid);
    const missing = expectedSlotKeys(study, "codex").filter(
      (key) =>
        !existing.some(
          (result) => studySlotKey(result.controller, result.family, result.seed) === key,
        ),
    );
    if (missing.length === 0) return [];
    // Evidence gate: no candidate execution without a real model response.
    const probed = yield* provider.probe(study.modelId);
    if (probed.model !== study.modelId) {
      return yield* Effect.fail(
        new ProviderFailure({
          message: `Codex probe resolved ${probed.model}, expected frozen model ${study.modelId}`,
        }),
      );
    }
    const controller = yield* provider.controllerFor(study.modelId, "blue");

    yield* markRunning(store, studyId);
    const recorded = new Set(
      existing.map((result) => studySlotKey(result.controller, result.family, result.seed)),
    );
    const results: StudyResult[] = [];
    for (const family of study.families) {
      for (const seed of study.seeds) {
        if (recorded.has(studySlotKey("codex", family, seed))) continue;
        const attempted = yield* Effect.result(
          runCandidateSeed(seed, family, controller, 40, study.decisionEveryTicks),
        );
        if (attempted._tag === "Failure") {
          return yield* Effect.fail(new ProviderFailure({ message: attempted.failure.message }));
        }
        const result: StudyResult = {
          ...attempted.success,
          studyId,
          attempt: 1,
          recordedAt: new Date().toISOString(),
        };
        if (result.model !== study.modelId) {
          return yield* Effect.fail(
            new ProviderFailure({
              message: `Candidate slot resolved ${result.model ?? "unknown"}, expected ${study.modelId}`,
            }),
          );
        }
        yield* store.recordResult(result);
        results.push(result);
      }
    }
    return results;
  });

export interface StudyEvidenceObject {
  readonly manifest: StudyManifest;
  readonly baseline: BenchmarkSummary;
  readonly candidate?: BenchmarkSummary;
  readonly hypothesis: Pick<HypothesisResult, "status" | "gates" | "sampleReady" | "evidenceReady">;
  readonly paired: PairedAnalysis;
  readonly results: ReadonlyArray<StudyResult>;
  readonly digest: string;
}

export interface PairedFamilyAnalysis {
  readonly pairs: number;
  readonly meanScoreDelta: number;
  readonly medianScoreDelta: number;
  readonly improved: number;
  readonly tied: number;
  readonly regressed: number;
}

export interface PairedAnalysis extends PairedFamilyAnalysis {
  readonly bootstrapSeed: number;
  readonly confidence95: {
    readonly lower: number;
    readonly upper: number;
  };
  readonly families: Readonly<Record<ScenarioFamily, PairedFamilyAnalysis>>;
}

export class EvidenceIntegrityError extends Data.TaggedError("EvidenceIntegrityError")<{
  readonly message: string;
}> {}

const canonicalize = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, entry]) => entry !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, canonicalize(entry)]),
    );
  }
  return value;
};

export const canonicalJson = (value: unknown): string => JSON.stringify(canonicalize(value));

const digestHex = async (value: unknown): Promise<string> => {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(canonicalJson(value)),
  );
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
};

export const computeStudyDigest = (
  manifest: StudyManifest,
  results: readonly StudyResult[],
): Promise<string> => {
  const { completionDigest: _completionDigest, ...frozenManifest } = manifest;
  return digestHex({ manifest: frozenManifest, results: sortStudyResults(results) });
};

const mean = (values: readonly number[]): number =>
  values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;

const median = (values: readonly number[]): number => {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2
    : (sorted[middle] ?? 0);
};

const summarizeDeltas = (deltas: readonly number[]): PairedFamilyAnalysis => ({
  pairs: deltas.length,
  meanScoreDelta: mean(deltas),
  medianScoreDelta: median(deltas),
  improved: deltas.filter((delta) => delta > 0).length,
  tied: deltas.filter((delta) => delta === 0).length,
  regressed: deltas.filter((delta) => delta < 0).length,
});

const pairedBootstrapSeed = fnv1a("warbench-study-v2-paired-bootstrap");

const bootstrapConfidence95 = (deltas: readonly number[]): { lower: number; upper: number } => {
  if (deltas.length === 0) return { lower: 0, upper: 0 };
  let state = pairedBootstrapSeed;
  const random = (): number => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    return state / 2 ** 32;
  };
  const means: number[] = [];
  for (let iteration = 0; iteration < 10_000; iteration += 1) {
    let total = 0;
    for (let sample = 0; sample < deltas.length; sample += 1) {
      total += deltas[Math.floor(random() * deltas.length)] ?? 0;
    }
    means.push(total / deltas.length);
  }
  means.sort((left, right) => left - right);
  return {
    lower: means[Math.floor(means.length * 0.025)] ?? 0,
    upper: means[Math.min(means.length - 1, Math.ceil(means.length * 0.975) - 1)] ?? 0,
  };
};

export const analyzePairedResults = (results: readonly StudyResult[]): PairedAnalysis => {
  const bySlot = new Map<string, Partial<Record<StudyResult["controller"], StudyResult>>>();
  for (const result of results) {
    const key = `${result.family}/${result.seed}`;
    const pair = bySlot.get(key) ?? {};
    pair[result.controller] = result;
    bySlot.set(key, pair);
  }
  const pairs = [...bySlot.values()].flatMap((pair) =>
    pair.rule && pair.codex
      ? [{ family: pair.rule.family, delta: pair.codex.score - pair.rule.score }]
      : [],
  );
  const deltas = pairs.map((pair) => pair.delta);
  return {
    ...summarizeDeltas(deltas),
    bootstrapSeed: pairedBootstrapSeed,
    confidence95: bootstrapConfidence95(deltas),
    families: Object.fromEntries(
      scenarioFamilies.map((family) => [
        family,
        summarizeDeltas(pairs.filter((pair) => pair.family === family).map((pair) => pair.delta)),
      ]),
    ) as Record<ScenarioFamily, PairedFamilyAnalysis>,
  };
};

/**
 * Assemble the single evaluation object for a study. JSON exports and PDF
 * reports must both derive from this object.
 */
export const assembleEvidence = (
  store: StudyStore,
  studyId: string,
): Effect.Effect<StudyEvidenceObject, StudyNotFound | StudyStateInvalid | EvidenceIntegrityError> =>
  Effect.gen(function* () {
    const manifest = yield* store.getStudy(studyId);
    const results = sortStudyResults(yield* store.listResults(studyId));
    const invalid = validateStudyResults(manifest, results, manifest.status === "completed");
    if (invalid) return yield* Effect.fail(invalid);
    const digest = yield* Effect.promise(() => computeStudyDigest(manifest, results));
    if (manifest.status === "completed") {
      if (!manifest.completionDigest) {
        return yield* Effect.fail(
          new EvidenceIntegrityError({
            message: `completed study ${studyId} has no frozen digest`,
          }),
        );
      }
      if (manifest.completionDigest !== digest) {
        return yield* Effect.fail(
          new EvidenceIntegrityError({ message: `completed evidence for ${studyId} was modified` }),
        );
      }
    }
    const baselineResults = results.filter((result) => result.controller === "rule");
    const candidateResults = results.filter((result) => result.controller === "codex");
    const baseline = summarize("rule", baselineResults);
    const candidate =
      candidateResults.length > 0 ? summarize("codex", candidateResults) : undefined;
    const hypothesis = evaluateHypothesis(baseline, candidate);
    return {
      manifest,
      baseline,
      ...(candidate ? { candidate } : {}),
      hypothesis: {
        status: hypothesis.status,
        gates: hypothesis.gates,
        sampleReady: hypothesis.sampleReady,
        evidenceReady: hypothesis.evidenceReady,
      },
      paired: analyzePairedResults(results),
      results,
      digest,
    };
  });

export const verifyCompletedEvidence = (
  store: StudyStore,
  studyId: string,
): Effect.Effect<StudyEvidenceObject, StudyNotFound | StudyStateInvalid | EvidenceIntegrityError> =>
  Effect.gen(function* () {
    const evidence = yield* assembleEvidence(store, studyId);
    if (evidence.manifest.status !== "completed") {
      return yield* Effect.fail(
        new StudyStateInvalid({ message: `study ${studyId} is not completed` }),
      );
    }
    return evidence;
  });
