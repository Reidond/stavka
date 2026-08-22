import { Data, Effect } from "effect";
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
  readonly startedAt?: string;
  readonly completedAt?: string;
}

export interface StudyResult extends SeedResult {
  readonly studyId: string;
  /** Immutable studies never allow a second attempt for the same slot. */
  readonly attempt: 1;
  readonly recordedAt: string;
}

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
  getStudy(studyId: string): Effect.Effect<StudyManifest, StudyNotFound>;
  updateManifest(manifest: StudyManifest): Effect.Effect<void>;
  recordResult(
    result: StudyResult,
  ): Effect.Effect<void, StudyConflict | StudyStateInvalid | StudyNotFound>;
  listResults(studyId: string): Effect.Effect<ReadonlyArray<StudyResult>, StudyNotFound>;
}

export const fullStudySeeds: ReadonlyArray<number> = Array.from(
  { length: minimumRunsPerFamily },
  (_, index) => index + 1,
);

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

const smokeSeeds: ReadonlyArray<number> = [1];
const smokeFamilies: ReadonlyArray<ScenarioFamily> = ["balanced"];

export const createStudyInputToManifest = (input: CreateStudyInput): StudyManifest => ({
  id: input.id,
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
  readonly probe: () => Effect.Effect<{ readonly model: string }, ProviderFailure>;
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

const runRuleSlots = (store: StudyStore, study: StudyManifest) =>
  Effect.gen(function* () {
    const results: StudyResult[] = [];
    for (const family of study.families) {
      for (const seed of study.seeds) {
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
    // Evidence gate: no candidate execution without a real model response.
    const probed = yield* provider.probe();
    const requestedModel = probed.model || study.modelId;
    const controller = yield* provider.controllerFor(requestedModel, "blue");

    yield* markRunning(store, studyId);
    const results: StudyResult[] = [];
    for (const family of study.families) {
      for (const seed of study.seeds) {
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
  readonly results: ReadonlyArray<StudyResult>;
  readonly digest: string;
}

const digestHex = async (value: unknown): Promise<string> => {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(JSON.stringify(value)),
  );
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
};

/**
 * Assemble the single evaluation object for a study. JSON exports and PDF
 * reports must both derive from this object.
 */
export const assembleEvidence = (
  store: StudyStore,
  studyId: string,
): Effect.Effect<StudyEvidenceObject, StudyNotFound> =>
  Effect.gen(function* () {
    const manifest = yield* store.getStudy(studyId);
    const results = yield* store.listResults(studyId);
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
      results,
      digest: yield* Effect.promise(() => digestHex({ manifest, results })),
    };
  });
