import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Effect } from "effect";
import { afterEach, describe, expect, it } from "vitest";

import {
  assembleEvidence,
  createStudyInputToManifest,
  currentEvidenceSchemaVersion,
  runRuleArm,
  verifyCompletedEvidence,
  type StudyResult,
} from "@stavka/warbench-core";

import { FileStudyStore } from "../src/store";

const dataDirs: string[] = [];

const newDataDir = async (): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), "warbench-cli-"));
  const dir = join(root, "private-data");
  dataDirs.push(root);
  return dir;
};

afterEach(async () => {
  await Promise.all(dataDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

const manifestFor = (id: string) =>
  createStudyInputToManifest({
    id,
    mode: "smoke",
    protocolVersion: "2",
    gitSha: "testsha",
    providerVersion: "stavka-codex/1",
    modelId: "gpt-5.1-codex-mini",
    promptHash: "hash",
  });

const candidateFrom = (rule: StudyResult): StudyResult => ({
  ...rule,
  controller: "codex",
  model: "gpt-5.1-codex-mini",
  decisionLatenciesMs: [12],
});

const permissionBits = async (path: string): Promise<number> => (await stat(path)).mode & 0o777;

describe("file-backed immutable study store", () => {
  it("persists studies privately and refuses duplicate ids", async () => {
    const dataDir = await newDataDir();
    const store = new FileStudyStore(dataDir);
    await Effect.runPromise(store.createStudy(manifestFor("smoke-a")));
    await expect(
      Effect.runPromise(store.createStudy(manifestFor("smoke-a"))),
    ).rejects.toMatchObject({ _tag: "StudyConflict" });
    expect((await Effect.runPromise(store.getStudy("smoke-a"))).modelId).toBe("gpt-5.1-codex-mini");
    expect(await permissionBits(dataDir)).toBe(0o700);
    expect(await permissionBits(join(dataDir, "studies", "smoke-a", "manifest.json"))).toBe(0o600);
  });

  it("resumes immutable arms and refuses incomplete completion", async () => {
    const store = new FileStudyStore(await newDataDir());
    await Effect.runPromise(store.createStudy(manifestFor("smoke-b")));
    const rules = await Effect.runPromise(runRuleArm(store, "smoke-b"));
    expect(rules).toHaveLength(3);
    await expect(Effect.runPromise(runRuleArm(store, "smoke-b"))).resolves.toEqual([]);
    await expect(
      Effect.runPromise(store.recordResult(rules[0] as StudyResult)),
    ).rejects.toMatchObject({ _tag: "StudyConflict" });
    await expect(Effect.runPromise(store.completeStudy("smoke-b"))).rejects.toMatchObject({
      _tag: "StudyStateInvalid",
    });
  });

  it("freezes a complete canonical digest and detects later tampering", async () => {
    const dataDir = await newDataDir();
    const store = new FileStudyStore(dataDir);
    await Effect.runPromise(store.createStudy(manifestFor("smoke-c")));
    const rules = await Effect.runPromise(runRuleArm(store, "smoke-c"));
    for (const rule of rules) await Effect.runPromise(store.recordResult(candidateFrom(rule)));

    const digest = await Effect.runPromise(store.completeStudy("smoke-c"));
    expect(digest).toMatch(/^[0-9a-f]{64}$/u);
    expect((await readFile(join(dataDir, "studies", "smoke-c", "digest.txt"), "utf8")).trim()).toBe(
      digest,
    );
    await expect(Effect.runPromise(store.completeStudy("smoke-c"))).resolves.toBe(digest);
    await expect(
      Effect.runPromise(verifyCompletedEvidence(store, "smoke-c")),
    ).resolves.toMatchObject({
      digest,
    });

    const resultPath = join(dataDir, "studies", "smoke-c", "results", "codex-balanced-1.json");
    const changed = JSON.parse(await readFile(resultPath, "utf8")) as StudyResult;
    await writeFile(
      resultPath,
      `${JSON.stringify({ ...changed, score: changed.score + 1 }, null, 2)}\n`,
    );
    await expect(Effect.runPromise(assembleEvidence(store, "smoke-c"))).rejects.toMatchObject({
      _tag: "EvidenceIntegrityError",
    });
  });

  it("invalidates without deleting recorded evidence", async () => {
    const store = new FileStudyStore(await newDataDir());
    await Effect.runPromise(store.createStudy(manifestFor("smoke-d")));
    const rules = await Effect.runPromise(runRuleArm(store, "smoke-d"));
    await Effect.runPromise(store.invalidateStudy("smoke-d"));
    expect((await Effect.runPromise(store.getStudy("smoke-d"))).status).toBe("invalidated");
    expect(await Effect.runPromise(store.listResults("smoke-d"))).toHaveLength(rules.length);
    await expect(Effect.runPromise(runRuleArm(store, "smoke-d"))).rejects.toMatchObject({
      _tag: "StudyStateInvalid",
    });
  });

  it("rejects persisted evidence with the wrong schema or model", async () => {
    const store = new FileStudyStore(await newDataDir());
    await Effect.runPromise(store.createStudy(manifestFor("smoke-e")));
    const [rule] = await Effect.runPromise(runRuleArm(store, "smoke-e"));
    expect(rule?.schemaVersion).toBe(currentEvidenceSchemaVersion);
    await expect(
      Effect.runPromise(
        store.recordResult({
          ...(rule as StudyResult),
          controller: "codex",
          model: "wrong-model",
        }),
      ),
    ).rejects.toMatchObject({ _tag: "StudyStateInvalid" });
  });
});
