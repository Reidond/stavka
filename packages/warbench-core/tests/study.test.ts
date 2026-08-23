import { describe, expect, it } from "vitest";
import { Effect } from "effect";

import {
  assembleEvidence,
  controllerFromCompleter,
  createStudyInputToManifest,
  fullStudySeeds,
  runCandidateArm,
  runRuleArm,
  type CandidateProvider,
  type StudyManifest,
  type StudyResult,
  type StudyStore,
} from "../src/study";
import { ProviderFailure, StudyConflict, StudyNotFound, StudyStateInvalid } from "../src/study";
import { scenarioFamilies } from "../src/benchmark";

class MemoryStore implements StudyStore {
  readonly studies = new Map<string, StudyManifest>();
  readonly results = new Map<string, StudyResult>();

  createStudy(manifest: StudyManifest): Effect.Effect<void, StudyConflict> {
    if (this.studies.has(manifest.id)) {
      return Effect.fail(new StudyConflict({ message: `study ${manifest.id} exists` }));
    }
    this.studies.set(manifest.id, manifest);
    return Effect.succeed(undefined);
  }

  getStudy(studyId: string): Effect.Effect<StudyManifest, StudyNotFound> {
    const study = this.studies.get(studyId);
    return study
      ? Effect.succeed(study)
      : Effect.fail(new StudyNotFound({ message: `unknown study ${studyId}` }));
  }

  updateManifest(manifest: StudyManifest): Effect.Effect<void> {
    this.studies.set(manifest.id, manifest);
    return Effect.succeed(undefined);
  }

  recordResult(
    result: StudyResult,
  ): Effect.Effect<void, StudyConflict | StudyStateInvalid | StudyNotFound> {
    const study = this.studies.get(result.studyId);
    if (!study) {
      return Effect.fail(new StudyNotFound({ message: `unknown study ${result.studyId}` }));
    }
    if (study.status === "completed" || study.status === "invalidated") {
      return Effect.fail(new StudyConflict({ message: `study ${result.studyId} is terminal` }));
    }
    const key = `${result.studyId}:${result.controller}:${result.family}:${result.seed}`;
    if (this.results.has(key)) {
      return Effect.fail(new StudyConflict({ message: `slot ${key} already filled` }));
    }
    this.results.set(key, result);
    return Effect.succeed(undefined);
  }

  listResults(studyId: string): Effect.Effect<ReadonlyArray<StudyResult>, StudyNotFound> {
    return Effect.succeed(
      [...this.results.values()].filter((result) => result.studyId === studyId),
    );
  }
}

const manifestFor = (id: string, mode: "smoke" | "full"): StudyManifest =>
  createStudyInputToManifest({
    id,
    mode,
    protocolVersion: "1",
    gitSha: "testsha",
    providerVersion: "stavka-codex/1",
    modelId: "gpt-5.1-codex-mini",
    promptHash: "hash",
  });

const holdOrders = JSON.stringify({
  orders: ["b0", "b1", "b2", "b3", "b4", "b5"].map((unitId) => ({ unitId, type: "hold" })),
});

const liveProbeProvider = (): CandidateProvider => ({
  probe: () => Effect.succeed({ model: "gpt-5.1-codex-mini" }),
  controllerFor: () =>
    Effect.succeed(
      controllerFromCompleter(
        "codex-test",
        () =>
          Effect.succeed({
            text: holdOrders,
            model: "gpt-5.1-codex-mini",
            latencyMs: 12,
          }),
        "blue",
      ),
    ),
});

const blockedProbeProvider = (): CandidateProvider => ({
  probe: () =>
    Effect.fail(
      new ProviderFailure({
        message: "ChatGPT blocked this Cloudflare Worker request with HTTP 403",
      }),
    ),
  // The gate must prevent the controller from ever being constructed.
  controllerFor: () => Effect.die("controller must not be constructed before probe"),
});

describe("immutable study orchestration", () => {
  it("smoke studies execute one calibration seed in every family and mark running", async () => {
    const store = new MemoryStore();
    await Effect.runPromise(store.createStudy(manifestFor("smoke-1", "smoke")));

    const results = await Effect.runPromise(runRuleArm(store, "smoke-1"));
    expect(results).toHaveLength(scenarioFamilies.length);
    expect(results[0]).toMatchObject({
      studyId: "smoke-1",
      attempt: 1,
      controller: "rule",
      family: "balanced",
      seed: 1,
      won: expect.any(Boolean),
    });
    expect((await Effect.runPromise(store.getStudy("smoke-1"))).status).toBe("running");
    expect((await Effect.runPromise(store.getStudy("smoke-1"))).startedAt).toBeDefined();
  });

  it("resumes arms by skipping already recorded immutable slots", async () => {
    const store = new MemoryStore();
    await Effect.runPromise(store.createStudy(manifestFor("smoke-1", "smoke")));
    await Effect.runPromise(runRuleArm(store, "smoke-1"));
    await expect(Effect.runPromise(runRuleArm(store, "smoke-1"))).resolves.toEqual([]);
  });

  it("refuses candidate execution while the provider probe has no real response", async () => {
    const store = new MemoryStore();
    await Effect.runPromise(store.createStudy(manifestFor("study-v1", "full")));
    await expect(
      Effect.runPromise(runCandidateArm(store, "study-v1", blockedProbeProvider())),
    ).rejects.toMatchObject({ _tag: "ProviderFailure" });
    expect(await Effect.runPromise(store.listResults("study-v1"))).toHaveLength(0);
    expect((await Effect.runPromise(store.getStudy("study-v1"))).status).toBe("draft");
  });

  it("runs the full candidate grid exactly once after a successful probe", async () => {
    const store = new MemoryStore();
    await Effect.runPromise(store.createStudy(manifestFor("study-v1", "full")));
    const results = await Effect.runPromise(
      runCandidateArm(store, "study-v1", liveProbeProvider()),
    );
    expect(results).toHaveLength(scenarioFamilies.length * fullStudySeeds.length);
    expect(results.every((result) => result.model === "gpt-5.1-codex-mini")).toBe(true);

    await expect(
      Effect.runPromise(runCandidateArm(store, "study-v1", liveProbeProvider())),
    ).resolves.toEqual([]);
  });

  it("aborts a resolved-model mismatch before writing any candidate slot", async () => {
    const store = new MemoryStore();
    await Effect.runPromise(store.createStudy(manifestFor("study-v1", "full")));
    const mismatched: CandidateProvider = {
      probe: () => Effect.succeed({ model: "different-model" }),
      controllerFor: () => Effect.die("controller must not be constructed after mismatch"),
    };
    await expect(
      Effect.runPromise(runCandidateArm(store, "study-v1", mismatched)),
    ).rejects.toMatchObject({ _tag: "ProviderFailure" });
    expect(await Effect.runPromise(store.listResults("study-v1"))).toEqual([]);
  });
});

describe("evidence assembly honesty", () => {
  it("reports INCONCLUSIVE below the minimum sample even with strong scores", async () => {
    const store = new MemoryStore();
    await Effect.runPromise(store.createStudy(manifestFor("study-v1", "full")));
    const seed = fullStudySeeds[0] ?? 1;
    await Effect.runPromise(store.recordResult(ruleResult("study-v1", seed)));
    await Effect.runPromise(store.recordResult(codexResult("study-v1", seed, "balanced", 500)));

    const evidence = await Effect.runPromise(assembleEvidence(store, "study-v1"));
    expect(evidence.hypothesis.sampleReady).toBe(false);
    expect(evidence.hypothesis.evidenceReady).toBe(false);
    expect(evidence.hypothesis.status).toBe("INCONCLUSIVE");
  });

  it("derives PASS only from a complete valid-evidence grid and keeps the digest stable", async () => {
    const store = new MemoryStore();
    await Effect.runPromise(store.createStudy(manifestFor("study-v1", "full")));
    for (const seed of fullStudySeeds) {
      for (const family of scenarioFamilies) {
        yieldSlot(store, ruleResult("study-v1", seed, family));
        yieldSlot(store, codexResult("study-v1", seed, family, 200));
      }
    }
    const evidence = await Effect.runPromise(assembleEvidence(store, "study-v1"));
    expect(evidence.results).toHaveLength(scenarioFamilies.length * fullStudySeeds.length * 2);
    expect(evidence.hypothesis.status).toBe("PASS");
    expect(evidence.paired).toMatchObject({
      pairs: scenarioFamilies.length * fullStudySeeds.length,
      meanScoreDelta: 100,
      medianScoreDelta: 100,
      improved: scenarioFamilies.length * fullStudySeeds.length,
      tied: 0,
      regressed: 0,
      confidence95: { lower: 100, upper: 100 },
    });
    expect(evidence.digest).toMatch(/^[0-9a-f]{64}$/u);

    const again = await Effect.runPromise(assembleEvidence(store, "study-v1"));
    expect(again.digest).toBe(evidence.digest);
  });
});

// Helpers -------------------------------------------------------------------

const yieldSlot = (store: MemoryStore, result: StudyResult): void => {
  const outcome = Effect.runSync(store.recordResult(result));
  void outcome;
};

const ruleResult = (
  studyId: string,
  seed: number,
  family: StudyResult["family"] = "balanced",
): StudyResult => ({
  schemaVersion: 3,
  studyId,
  attempt: 1,
  recordedAt: "2026-08-21T00:00:00.000Z",
  seed,
  family,
  controller: "rule",
  score: 100,
  opponentScore: -100,
  won: false,
  invalidDecisions: 0,
  requestFailures: 0,
  decisionCount: 8,
  decisionLatenciesMs: [],
  failureMessages: [],
});

const codexResult = (
  studyId: string,
  seed: number,
  family: StudyResult["family"] = "balanced",
  scoreValue = 200,
): StudyResult => ({
  ...ruleResult(studyId, seed, family),
  controller: "codex",
  score: scoreValue,
  opponentScore: -100,
  won: scoreValue > 100,
  decisionLatenciesMs: [10],
  model: "gpt-5.1-codex-mini",
});
