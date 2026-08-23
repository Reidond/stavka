import { beforeEach, describe, expect, it, vi } from "vitest";

import type { StudyManifest, StudyResult } from "../src/durable-objects/warbench-study-store";

const storage = new Map<string, unknown>();

vi.mock("cloudflare:workers", () => ({
  DurableObject: class {
    readonly ctx: {
      readonly storage: {
        get: <T>(key: string) => Promise<T | undefined>;
        put: (key: string, value: unknown) => Promise<void>;
        delete: (key: string) => Promise<boolean>;
        list: (options: { prefix: string }) => Promise<Map<string, unknown>>;
      };
    };

    constructor(_context: unknown, _env: unknown) {
      this.ctx = {
        storage: {
          get: async <T>(key: string) => storage.get(key) as T | undefined,
          put: async (key: string, value: unknown) => {
            storage.set(key, value);
          },
          delete: async (key: string) => storage.delete(key),
          list: async ({ prefix }: { prefix: string }) =>
            new Map([...storage].filter(([key]) => key.startsWith(prefix))),
        },
      };
    }
  },
}));

const manifest: StudyManifest = {
  id: "study-v1",
  status: "running",
  protocolVersion: "1",
  evidenceSchemaVersion: 2,
  gitSha: "2be74c7098f750a0b1b946b77c80c89e2891c0b6",
  providerVersion: "stavka-codex/1",
  modelId: "gpt-5.1-codex-mini",
  promptHash: "abc123",
  seeds: [1, 2],
  families: ["balanced", "north-pressure", "south-pressure"],
  decisionEveryTicks: 5,
  createdAt: "2026-08-21T00:00:00.000Z",
};

const resultFor = (
  overrides: Partial<StudyResult> & {
    readonly arm?: "rule" | "codex";
    readonly seed?: number;
    readonly family?: StudyResult["family"];
  },
): StudyResult => {
  const { arm, ...rest } = overrides;
  return {
    studyId: "study-v1",
    attempt: 1,
    recordedAt: "2026-08-21T01:00:00.000Z",
    schemaVersion: 2 as const,
    seed: 1,
    family: "balanced" as const,
    controller: arm ?? ("codex" as const),
    score: 100,
    opponentScore: -100,
    won: true,
    invalidDecisions: 0,
    requestFailures: 0,
    decisionCount: 8,
    decisionLatenciesMs: [],
    failureMessages: [],
    ...rest,
  } as StudyResult;
};

type Store = import("../src/durable-objects/warbench-study-store").WarbenchStudyStore;

const newStore = async (): Promise<Store> => {
  const { WarbenchStudyStore } = await import("../src/durable-objects/warbench-study-store");
  return new WarbenchStudyStore(undefined as never, {}) as Store;
};

describe("warbench immutable study store", () => {
  beforeEach(() => {
    storage.clear();
  });

  it("creates a study once and rejects duplicate ids with 409 semantics", async () => {
    const store = await newStore();
    await store.createStudy(manifest);
    await expect(store.createStudy(manifest)).rejects.toMatchObject({ status: 409 });
    expect(await store.getStudy("study-v1")).toMatchObject({ id: "study-v1" });
  });

  it("records each slot once; duplicates fail instead of overwriting", async () => {
    const store = await newStore();
    await store.createStudy(manifest);
    await store.recordResult(resultFor({}));
    await expect(store.recordResult(resultFor({ score: 999 }))).rejects.toMatchObject({
      status: 409,
    });
    // The original evidence is intact — no silent overwrite.
    expect((await store.listResults("study-v1"))[0]?.score).toBe(100);
    // A second attempt number is refused outright.
    await expect(
      store.recordResult({ ...resultFor({}), attempt: 2 as never }),
    ).rejects.toMatchObject({ status: 400 });
  });

  it("keeps rule and codex arms in separate slots", async () => {
    const store = await newStore();
    await store.createStudy(manifest);
    await store.recordResult(resultFor({ arm: "rule", score: 10 }));
    await store.recordResult(resultFor({ arm: "codex", score: 120 }));
    expect(await store.listResults("study-v1")).toHaveLength(2);
  });

  it("refuses results after completion and never rewrites completed studies", async () => {
    const store = await newStore();
    await store.createStudy(manifest);
    await store.recordResult(resultFor({}));
    const digest = await store.completeStudy("study-v1");
    expect(digest).toMatch(/^[0-9a-f]{64}$/u);

    await expect(store.recordResult(resultFor({ seed: 2 }))).rejects.toMatchObject({
      status: 409,
    });
    await expect(store.invalidateStudy("study-v1")).rejects.toMatchObject({ status: 409 });

    // Completing twice does not mint a second digest.
    await expect(store.completeStudy("study-v1")).rejects.toMatchObject({ status: 409 });
  });

  it("invalidates running studies for audit but bars them from completion", async () => {
    const store = await newStore();
    await store.createStudy(manifest);
    await store.invalidateStudy("study-v1");
    await expect(store.recordResult(resultFor({}))).rejects.toMatchObject({ status: 409 });
    await expect(store.completeStudy("study-v1")).rejects.toMatchObject({ status: 400 });
  });

  it("derives reports only from completed studies and freezes their bytes", async () => {
    const store = await newStore();
    await store.createStudy(manifest);
    await expect(store.putReport("study-v1", "pdf", new Uint8Array([1]))).rejects.toMatchObject({
      status: 400,
    });

    await store.recordResult(resultFor({}));
    await store.completeStudy("study-v1");
    await store.putReport("study-v1", "json", new TextEncoder().encode("{}"));
    await store.putReport("study-v1", "json", new TextEncoder().encode("{}"));
    await expect(
      store.putReport("study-v1", "json", new TextEncoder().encode("{different}")),
    ).rejects.toMatchObject({ status: 409 });

    const stored = await store.getReport("study-v1", "json");
    expect(new TextDecoder().decode(stored)).toBe("{}");
  });

  it("returns evidence with a stable digest over manifest and results", async () => {
    const store = await newStore();
    await store.createStudy(manifest);
    await store.recordResult(resultFor({}));
    const first = await store.evidence("study-v1");
    const second = await store.evidence("study-v1");
    expect(first.digest).toBe(second.digest);
    expect(first.results).toHaveLength(1);

    await store.recordResult(resultFor({ arm: "rule" }));
    const third = await store.evidence("study-v1");
    expect(third.digest).not.toBe(first.digest);
  });
});
