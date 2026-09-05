import { Effect } from "effect";
import { describe, expect, it, vi } from "vitest";

import type { Env } from "../src/config";
import {
  R2SessionExportRepository,
  type R2BucketLike,
  type R2ObjectBodyLike,
  type R2ObjectMetadataLike,
} from "../src/logging/r2-session-export-repository";

const logPayload = (sequence: number): string =>
  JSON.stringify({
    id: `dec_${String(sequence).padStart(6, "0")}`,
    timestamp: new Date(sequence * 1_000).toISOString(),
    agent: "commander",
    trigger: "scheduled_tick",
    input: { stateSnapshot: null, events: [], prompt: "" },
    output: { rawResponse: "", parsedCommands: [], summary: `Decision ${sequence}` },
    commandsIssued: [],
    model: "mock:commander",
    latencyMs: 0,
    tokenUsage: { input: 0, output: 0 },
    costUsd: 0,
  });

vi.mock("agents", () => ({
  getAgentByName: async (namespace: { getByName: (name: string) => unknown }, name: string) =>
    namespace.getByName(name),
  Agent: class {
    state: unknown;
    env: unknown;

    setState(state: unknown): void {
      this.state = state;
    }

    sql<T>(strings: TemplateStringsArray, ...values: unknown[]): T[] {
      const query = strings.join("?");
      if (query.includes("WITH watermark(high_water_rowid)") && query.includes("decision_logs")) {
        return [{ high_water_rowid: 501, total: 501 }] as T[];
      }
      if (query.includes("WITH watermark(high_water_rowid)")) {
        return [{ high_water_rowid: 0, total: 0 }] as T[];
      }
      if (query.includes("SELECT id, timestamp, payload FROM decision_logs")) {
        const limit = values.at(-1) as number;
        const cursorId = values.length > 2 ? (values.at(-2) as string) : undefined;
        const start = cursorId === undefined ? 1 : Number(cursorId.slice(-6)) + 1;
        return Array.from({ length: Math.min(limit, Math.max(0, 502 - start)) }, (_, index) => {
          const sequence = start + index;
          return {
            id: `dec_${String(sequence).padStart(6, "0")}`,
            timestamp: new Date(sequence * 1_000).toISOString(),
            payload: logPayload(sequence),
          };
        }) as T[];
      }
      return [];
    }
  },
}));

const { OrchestratorAgent } = await import("../src/durable/orchestrator");

interface StoredObject {
  readonly body: string;
  readonly metadata: R2ObjectMetadataLike;
}

class FakeR2Bucket implements R2BucketLike {
  readonly objects = new Map<string, StoredObject>();

  async put(
    key: string,
    value: string,
    options?: {
      readonly httpMetadata?: { readonly contentType?: string };
      readonly customMetadata?: Record<string, string>;
    },
  ): Promise<R2ObjectMetadataLike> {
    const metadata: R2ObjectMetadataLike = {
      key,
      size: new TextEncoder().encode(value).byteLength,
      etag: `etag:${key}`,
      uploaded: new Date("2026-08-02T12:00:00.000Z"),
      ...(options?.customMetadata === undefined ? {} : { customMetadata: options.customMetadata }),
    };
    this.objects.set(key, { body: value, metadata });
    return metadata;
  }

  async get(key: string): Promise<R2ObjectBodyLike | null> {
    const stored = this.objects.get(key);
    return stored === undefined ? null : { ...stored.metadata, text: async () => stored.body };
  }

  async list(): Promise<{ readonly objects: readonly R2ObjectMetadataLike[] }> {
    return { objects: [...this.objects.values()].map(({ metadata }) => metadata) };
  }
}

describe("Commander long-session export", () => {
  it("pages every SQLite decision into R2 instead of applying the inline 500-row cap", async () => {
    type TestAgent = InstanceType<typeof OrchestratorAgent> & {
      state: InstanceType<typeof OrchestratorAgent>["initialState"];
      env: Env;
    };
    const Constructor = OrchestratorAgent as unknown as new () => TestAgent;
    const agent = new Constructor();
    const bucket = new FakeR2Bucket();
    agent.state = {
      ...structuredClone(agent.initialState),
      connected: true,
      sessionId: "long-session",
      faction: "OPFOR",
      missionEpoch: 4,
    };
    agent.env = {
      ORCHESTRATOR: {} as Env["ORCHESTRATOR"],
      TERRAIN_CACHE: {} as Env["TERRAIN_CACHE"],
      SESSION_EXPORTS: bucket as unknown as R2Bucket,
      API_KEY: "machine",
      STAVKA_AI_PROVIDER: "mock",
    };

    const metadata = await agent.persistSessionExport("full-history");
    const restored = await Effect.runPromise(
      new R2SessionExportRepository(bucket).read(metadata.key),
    );

    expect(metadata).toMatchObject({ storage: "chunked", chunkCount: 21 });
    expect(restored.data.logs).toHaveLength(501);
    expect(restored.data.logs[0]?.id).toBe("dec_000001");
    expect(restored.data.logs.at(-1)?.id).toBe("dec_000501");
    expect(restored.data).toMatchObject({
      export_version: 1,
      session: {
        session_id: "long-session",
        faction: "OPFOR",
        mission_epoch: 4,
      },
    });
  });
});
