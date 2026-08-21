import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { Effect } from "effect";

import {
  assembleEvidence,
  createStudyInputToManifest,
  runRuleArm,
  StudyConflict,
} from "@stavka/warbench-core";

import { FileStudyStore } from "../src/store";

const dataDirs: string[] = [];

const newDataDir = async (): Promise<string> => {
  const dir = await mkdtemp(join(tmpdir(), "warbench-cli-"));
  dataDirs.push(dir);
  return dir;
};

afterEach(async () => {
  await Promise.all(dataDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

const manifestFor = (id: string) =>
  createStudyInputToManifest({
    id,
    mode: "smoke",
    protocolVersion: "1",
    gitSha: "testsha",
    piVersion: "0.84.2",
    modelId: "gpt-5.1-codex-mini",
    promptHash: "hash",
  });

describe("file-backed immutable study store", () => {
  it("persists studies and refuses duplicate ids", async () => {
    const store = new FileStudyStore(await newDataDir());
    await Effect.runPromise(store.createStudy(manifestFor("smoke-a")));
    await expect(
      Effect.runPromise(store.createStudy(manifestFor("smoke-a"))),
    ).rejects.toMatchObject({ _tag: "StudyConflict" });
    expect((await Effect.runPromise(store.getStudy("smoke-a"))).modelId).toBe("gpt-5.1-codex-mini");
  });

  it("runs a rule-only smoke study end to end and freezes the completed study", async () => {
    const dataDir = await newDataDir();
    const store = new FileStudyStore(dataDir);
    await Effect.runPromise(store.createStudy(manifestFor("smoke-b")));

    const results = await Effect.runPromise(runRuleArm(store, "smoke-b"));
    expect(results).toHaveLength(1);

    // A rerun hits the immutability wall instead of overwriting evidence.
    await expect(Effect.runPromise(runRuleArm(store, "smoke-b"))).rejects.toMatchObject({
      _tag: "StudyConflict",
    });

    const digest = await Effect.runPromise(store.completeStudy("smoke-b"));
    expect(digest).toMatch(/^[0-9a-f]{64}$/u);
    expect(await readFile(join(dataDir, "studies", "smoke-b", "digest.txt"), "utf8")).toContain(
      digest.slice(1, 20),
    );

    await expect(Effect.runPromise(store.completeStudy("smoke-b"))).rejects.toMatchObject({
      _tag: "StudyConflict",
    });
    await expect(
      Effect.runPromise(
        store.recordResult({
          ...results[0],
          seed: 999,
        } as never),
      ),
    ).rejects.toMatchObject({ _tag: "StudyConflict" });
  });

  it("assembles honest evidence with a stable digest from disk", async () => {
    const store = new FileStudyStore(await newDataDir());
    await Effect.runPromise(store.createStudy(manifestFor("smoke-c")));
    await Effect.runPromise(runRuleArm(store, "smoke-c"));

    const first = await Effect.runPromise(assembleEvidence(store, "smoke-c"));
    const second = await Effect.runPromise(assembleEvidence(store, "smoke-c"));

    expect(first.hypothesis.status).toBe("INCONCLUSIVE");
    expect(first.digest).toBe(second.digest);
    expect(first.baseline.runs).toBe(1);
    void StudyConflict;
  });
});
