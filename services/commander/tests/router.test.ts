import { computeMapBriefingContentHash, type SessionExport } from "@stavka/protocol";
import { Effect } from "effect";
import { beforeEach, describe, expect, it, vi } from "vitest";

import test12Fixture from "../../../packages/protocol/fixtures/test-12-round-trip.json";

import type { Env } from "../src/config";
import {
  R2SessionExportRepository,
  type R2BucketLike,
  type R2ObjectBodyLike,
  type R2ObjectMetadataLike,
} from "../src/logging/r2-session-export-repository";

const mocks = vi.hoisted(() => ({
  agentRoute: vi.fn<(request: Request, env: unknown) => Promise<Response | null>>(),
}));

vi.mock("agents", () => ({
  getAgentByName: async (namespace: { getByName: (name: string) => unknown }, name: string) =>
    namespace.getByName(name),
  Agent: class {},
  routeAgentRequest: mocks.agentRoute,
}));

const { handleRequest } = await import("../src/api/router");

const makeEnv = (overrides: Partial<Env> = {}): Env => ({
  ORCHESTRATOR: {} as Env["ORCHESTRATOR"],
  TERRAIN_CACHE: {} as Env["TERRAIN_CACHE"],
  API_KEY: "machine-secret",
  ENVIRONMENT: "local",
  DEV_ACCESS_EMAIL: "operator@example.test",
  ...overrides,
});

const makeExport = (): SessionExport => ({
  export_version: 1,
  session: {
    protocol_version: 1,
    session_id: "route-session",
    faction: "OPFOR",
    mission_epoch: 3,
    doctrine: "balanced",
    mode: "rule",
    exported_at: "2026-08-02T12:00:00.000Z",
  },
  logs: [],
  archive: { ticks: [], events: [], snapshots: [] },
  cost_aggregates: [],
});

interface StoredObject {
  readonly body: string;
  readonly metadata: R2ObjectMetadataLike;
}

class FakeR2Bucket implements R2BucketLike {
  readonly #objects = new Map<string, StoredObject>();

  async put(
    key: string,
    value: string,
    options?: {
      readonly httpMetadata?: { readonly contentType?: string };
      readonly customMetadata?: Record<string, string>;
      readonly onlyIf?: { readonly etagDoesNotMatch?: string };
    },
  ): Promise<R2ObjectMetadataLike | null> {
    if (options?.onlyIf?.etagDoesNotMatch === "*" && this.#objects.has(key)) return null;
    const metadata: R2ObjectMetadataLike = {
      key,
      size: new TextEncoder().encode(value).byteLength,
      etag: `etag:${key}`,
      uploaded: new Date("2026-08-02T12:00:00.000Z"),
      ...(options?.customMetadata === undefined
        ? {}
        : { customMetadata: { ...options.customMetadata } }),
    };
    this.#objects.set(key, { body: value, metadata });
    return metadata;
  }

  async get(key: string): Promise<R2ObjectBodyLike | null> {
    const stored = this.#objects.get(key);
    return stored === undefined ? null : { ...stored.metadata, text: async () => stored.body };
  }

  async list(options?: {
    readonly prefix?: string;
    readonly limit?: number;
    readonly cursor?: string;
    readonly include?: ("customMetadata" | "httpMetadata")[];
  }): Promise<{
    readonly objects: readonly R2ObjectMetadataLike[];
    readonly truncated?: boolean;
    readonly cursor?: string;
  }> {
    const all = [...this.#objects.values()]
      .map(({ metadata }) => metadata)
      .filter(({ key }) => key.startsWith(options?.prefix ?? ""))
      .sort((left, right) => left.key.localeCompare(right.key));
    const start = options?.cursor === undefined ? 0 : Number(options.cursor);
    const objects = all.slice(start, start + (options?.limit ?? all.length));
    const next = start + objects.length;
    return next < all.length
      ? { objects, truncated: true, cursor: String(next) }
      : { objects, truncated: false };
  }
}

describe("Commander HTTP routing", () => {
  it.each([null, makeExport()])(
    "returns a missing-session 404 or the canonical export",
    async (exported) => {
      const exportSession = vi.fn().mockResolvedValue(exported);
      const getByName = vi.fn(() => ({ exportSession }));
      const response = await handleRequest(
        new Request("http://127.0.0.1/admin/export?session_id=route-session&faction=OPFOR&epoch=3"),
        makeEnv({ ORCHESTRATOR: { getByName } as unknown as Env["ORCHESTRATOR"] }),
      );
      expect(getByName).toHaveBeenCalledWith(JSON.stringify(["route-session", 3, "OPFOR"]));
      expect(response.status).toBe(exported === null ? 404 : 200);
      if (exported === null)
        expect(await response.json()).toMatchObject({ error: { code: "NOT_FOUND" } });
      else expect(await response.json()).toEqual(exported);
    },
  );
  beforeEach(() => mocks.agentRoute.mockReset().mockResolvedValue(null));

  it("serves the public health contract through HttpApi", async () => {
    const response = await handleRequest(new Request("https://commander.test/healthz"), makeEnv());

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      service: "stavka-commander",
      protocol_version: 1,
      ai: {
        commander: "stavka/commander",
        sergeant: "stavka/sergeant",
      },
    });
  });

  it("publishes the contract-generated OpenAPI document", async () => {
    const response = await handleRequest(
      new Request("https://commander.test/openapi.json"),
      makeEnv(),
    );

    expect(response.status).toBe(200);
    const document = (await response.json()) as { readonly paths: Record<string, unknown> };
    expect(document.paths).toHaveProperty("/api/connect");
    expect(document.paths).toHaveProperty("/admin/export");
    expect(document.paths).toHaveProperty("/admin/exports");
    expect(document.paths).toHaveProperty("/admin/exports/object");
  });

  it("authenticates machine routes before decoding their payload", async () => {
    const unauthorized = await handleRequest(
      new Request("https://commander.test/api/tick", { method: "POST" }),
      makeEnv(),
    );

    expect(unauthorized.status).toBe(401);
    await expect(unauthorized.json()).resolves.toMatchObject({
      error: { code: "UNAUTHORIZED" },
    });

    const misconfigured = await handleRequest(
      new Request("https://commander.test/api/tick", {
        method: "POST",
        headers: { authorization: "Bearer machine-secret" },
      }),
      makeEnv({ API_KEY: "" }),
    );

    expect(misconfigured.status).toBe(503);
    await expect(misconfigured.json()).resolves.toMatchObject({
      error: { code: "MISCONFIGURED" },
    });
  });

  it("accepts the Test-12 tick contract but rejects an unexpected wire field", async () => {
    const handleTick = vi.fn().mockResolvedValue(test12Fixture.response);
    const env = makeEnv({
      ORCHESTRATOR: {
        getByName: vi.fn(() => ({ handleTick })),
      } as unknown as Env["ORCHESTRATOR"],
    });
    const request = (payload: unknown) =>
      new Request("https://commander.test/api/tick", {
        method: "POST",
        headers: {
          authorization: "Bearer machine-secret",
          "content-type": "application/json",
          "x-stavka-mission-epoch": "1",
        },
        body: JSON.stringify(payload),
      });

    const accepted = await handleRequest(request(test12Fixture.request), env);
    expect(accepted.status).toBe(200);
    expect(handleTick).toHaveBeenCalledWith(test12Fixture.request);

    const rejected = await handleRequest(
      request({
        ...test12Fixture.request,
        unexpected: true,
      }),
      env,
    );
    expect(rejected.status).toBe(400);
    expect(handleTick).toHaveBeenCalledTimes(1);
  });

  it("uses the strict live map contract and provenance-bearing terrain cache keys", async () => {
    const values = new Map<string, string>();
    const terrainCache = {
      put: vi.fn(async (key: string, value: string) => {
        values.set(key, value);
      }),
      get: vi.fn(async (key: string) => values.get(key) ?? null),
    };
    const setMapBriefing = vi.fn();
    const sessionIndexKey = `session:${JSON.stringify(["map-session", 3, "OPFOR"])}`;
    values.set(
      sessionIndexKey,
      JSON.stringify({
        missionId: "map-mission",
        faction: "OPFOR",
        epoch: 3,
        mapName: "Everon",
      }),
    );
    const env = makeEnv({
      TERRAIN_CACHE: terrainCache as unknown as Env["TERRAIN_CACHE"],
      ORCHESTRATOR: {
        getByName: vi.fn(() => ({ setMapBriefing })),
      } as unknown as Env["ORCHESTRATOR"],
    });
    const briefingInput = {
      map_name: "Everon",
      grid_size: 2,
      grid_width: 2,
      grid_height: 2,
      grid_resolution_meters: 10,
      source: "arma_extracted" as const,
      classification_version: 2,
      terrain_grid: [
        {
          grid: [0, 0] as const,
          type: "field" as const,
          cover: "light" as const,
          elevation: 0,
          traversable: true,
        },
      ],
      key_features: [],
    };
    const briefing = {
      ...briefingInput,
      content_hash: computeMapBriefingContentHash(briefingInput),
    };
    const terrainKey = `map:Everon:arma_extracted:v2:${briefing.content_hash}`;
    const request = (payload: unknown) =>
      new Request("https://commander.test/api/map", {
        method: "POST",
        headers: {
          authorization: "Bearer machine-secret",
          "content-type": "application/json",
        },
        body: JSON.stringify(payload),
      });

    const beforeConnect = await handleRequest(
      request({
        protocol_version: 1,
        session_id: "unconnected-session",
        mission_id: "map-mission",
        mission_epoch: 3,
        faction: "OPFOR",
        briefing,
      }),
      env,
    );
    expect(beforeConnect.status).toBe(409);
    await expect(beforeConnect.json()).resolves.toMatchObject({
      error: { code: "MAP_SESSION_NOT_CONNECTED" },
    });
    expect(terrainCache.put).not.toHaveBeenCalled();
    expect(setMapBriefing).not.toHaveBeenCalled();

    const accepted = await handleRequest(
      request({
        protocol_version: 1,
        session_id: "map-session",
        mission_id: "map-mission",
        mission_epoch: 3,
        faction: "OPFOR",
        briefing,
      }),
      env,
    );
    expect(accepted.status).toBe(200);
    await expect(accepted.json()).resolves.toMatchObject({
      accepted: true,
      key: terrainKey,
    });
    expect(terrainCache.put.mock.calls.map(([key]) => key)).toEqual([
      terrainKey,
      "map:Everon:latest",
    ]);
    expect(JSON.parse(values.get("map:Everon:latest") ?? "{}")).toMatchObject({
      key: terrainKey,
      source: "arma_extracted",
      classificationVersion: 2,
      contentHash: briefing.content_hash,
    });
    expect(setMapBriefing).toHaveBeenCalledWith(briefing);

    const stale = await handleRequest(
      request({
        protocol_version: 1,
        session_id: "map-session",
        mission_id: "map-mission",
        mission_epoch: 2,
        faction: "OPFOR",
        briefing,
      }),
      env,
    );
    expect(stale.status).toBe(409);
    await expect(stale.json()).resolves.toMatchObject({
      error: { code: "MAP_SESSION_NOT_CONNECTED" },
    });
    expect(terrainCache.put).toHaveBeenCalledTimes(2);
    expect(setMapBriefing).toHaveBeenCalledTimes(1);

    const mismatchedMission = await handleRequest(
      request({
        protocol_version: 1,
        session_id: "map-session",
        mission_id: "other-mission",
        mission_epoch: 3,
        faction: "OPFOR",
        briefing,
      }),
      env,
    );
    expect(mismatchedMission.status).toBe(409);
    await expect(mismatchedMission.json()).resolves.toMatchObject({
      error: { code: "MAP_SESSION_MISMATCH" },
    });

    const maldenInput = { ...briefingInput, map_name: "Malden" as const };
    const mismatchedMap = await handleRequest(
      request({
        protocol_version: 1,
        session_id: "map-session",
        mission_id: "map-mission",
        mission_epoch: 3,
        faction: "OPFOR",
        briefing: {
          ...maldenInput,
          content_hash: computeMapBriefingContentHash(maldenInput),
        },
      }),
      env,
    );
    expect(mismatchedMap.status).toBe(409);
    await expect(mismatchedMap.json()).resolves.toMatchObject({
      error: { code: "MAP_SESSION_MISMATCH" },
    });
    expect(terrainCache.put).toHaveBeenCalledTimes(2);
    expect(setMapBriefing).toHaveBeenCalledTimes(1);

    const rejected = await handleRequest(
      request({
        protocol_version: 1,
        session_id: "map-session",
        mission_id: "map-mission",
        mission_epoch: 3,
        faction: "OPFOR",
        briefing,
        unexpected: true,
      }),
      env,
    );
    expect(rejected.status).toBe(400);
    expect(terrainCache.put).toHaveBeenCalledTimes(2);
  });

  it("isolates OPFOR and BLUFOR Durable Objects and map indexes for the same session identity", async () => {
    const values = new Map<string, string>();
    const terrainCache = {
      put: vi.fn(async (key: string, value: string) => {
        values.set(key, value);
      }),
      get: vi.fn(async (key: string) => values.get(key) ?? null),
    };
    const stubs = new Map<
      string,
      {
        connectSession: ReturnType<typeof vi.fn>;
        setMapBriefing: ReturnType<typeof vi.fn>;
      }
    >();
    const getByName = vi.fn((name: string) => {
      const existing = stubs.get(name);
      if (existing !== undefined) return existing;
      const created = {
        connectSession: vi.fn().mockResolvedValue({
          protocol_version: 1,
          accepted: true,
          request_full_snapshot: true,
          tick_rate_hint: 2_000,
        }),
        setMapBriefing: vi.fn(),
      };
      stubs.set(name, created);
      return created;
    });
    const env = makeEnv({
      TERRAIN_CACHE: terrainCache as unknown as Env["TERRAIN_CACHE"],
      ORCHESTRATOR: { getByName } as unknown as Env["ORCHESTRATOR"],
    });
    const briefingInput = {
      map_name: "Everon",
      grid_size: 1,
      grid_width: 1,
      grid_height: 1,
      grid_resolution_meters: 10,
      source: "arma_extracted" as const,
      classification_version: 1,
      terrain_grid: [
        {
          grid: [0, 0] as const,
          type: "field" as const,
          cover: "light" as const,
          elevation: 0,
          traversable: true,
        },
      ],
      key_features: [],
    };
    const briefing = {
      ...briefingInput,
      content_hash: computeMapBriefingContentHash(briefingInput),
    };
    const connect = (faction: "OPFOR" | "BLUFOR") =>
      handleRequest(
        new Request("https://commander.test/api/connect", {
          method: "POST",
          headers: {
            authorization: "Bearer machine-secret",
            "content-type": "application/json",
          },
          body: JSON.stringify({
            protocol_version: 1,
            session_id: "shared-session",
            mission_id: `mission-${faction.toLowerCase()}`,
            mission_epoch: 7,
            faction,
            map_name: "Everon",
          }),
        }),
        env,
      );
    const upload = (faction: "OPFOR" | "BLUFOR") =>
      handleRequest(
        new Request("https://commander.test/api/map", {
          method: "POST",
          headers: {
            authorization: "Bearer machine-secret",
            "content-type": "application/json",
          },
          body: JSON.stringify({
            protocol_version: 1,
            session_id: "shared-session",
            mission_id: `mission-${faction.toLowerCase()}`,
            mission_epoch: 7,
            faction,
            briefing,
          }),
        }),
        env,
      );

    expect((await connect("OPFOR")).status).toBe(200);
    expect((await connect("BLUFOR")).status).toBe(200);

    const opforName = JSON.stringify(["shared-session", 7, "OPFOR"]);
    const bluforName = JSON.stringify(["shared-session", 7, "BLUFOR"]);
    expect(getByName.mock.calls.map(([name]) => name)).toEqual([opforName, bluforName]);
    expect(stubs.size).toBe(2);
    expect(stubs.get(opforName)).not.toBe(stubs.get(bluforName));

    const opforIndex = `session:${opforName}`;
    const bluforIndex = `session:${bluforName}`;
    expect(JSON.parse(values.get(opforIndex) ?? "{}")).toMatchObject({
      missionId: "mission-opfor",
      faction: "OPFOR",
      epoch: 7,
      mapName: "Everon",
    });
    expect(JSON.parse(values.get(bluforIndex) ?? "{}")).toMatchObject({
      missionId: "mission-blufor",
      faction: "BLUFOR",
      epoch: 7,
      mapName: "Everon",
    });

    expect((await upload("OPFOR")).status).toBe(200);
    expect((await upload("BLUFOR")).status).toBe(200);
    expect(stubs.get(opforName)?.setMapBriefing).toHaveBeenCalledTimes(1);
    expect(stubs.get(bluforName)?.setMapBriefing).toHaveBeenCalledTimes(1);
    expect(stubs.get(opforName)?.setMapBriefing).not.toBe(stubs.get(bluforName)?.setMapBriefing);
  });

  it("does not attach a cached briefing whose map differs from the connect mission", async () => {
    const values = new Map<string, string>();
    const terrainCache = {
      put: vi.fn(async (key: string, value: string) => {
        values.set(key, value);
      }),
      get: vi.fn(async (key: string) => values.get(key) ?? null),
    };
    const foreignInput = {
      map_name: "Malden",
      grid_size: 1,
      grid_width: 1,
      grid_height: 1,
      grid_resolution_meters: 10,
      source: "arma_extracted" as const,
      classification_version: 1,
      terrain_grid: [
        {
          grid: [0, 0] as const,
          type: "field" as const,
          cover: "light" as const,
          elevation: 0,
          traversable: true,
        },
      ],
      key_features: [],
    };
    const foreignBriefing = {
      ...foreignInput,
      content_hash: computeMapBriefingContentHash(foreignInput),
    };
    const foreignKey = `map:Malden:arma_extracted:v1:${foreignBriefing.content_hash}`;
    values.set("map:Everon:latest", JSON.stringify({ key: foreignKey }));
    values.set(foreignKey, JSON.stringify(foreignBriefing));
    const connectSession = vi.fn().mockResolvedValue({
      protocol_version: 1,
      accepted: true,
      request_full_snapshot: true,
      tick_rate_hint: 2_000,
    });
    const setMapBriefing = vi.fn();
    const env = makeEnv({
      TERRAIN_CACHE: terrainCache as unknown as Env["TERRAIN_CACHE"],
      ORCHESTRATOR: {
        getByName: vi.fn(() => ({ connectSession, setMapBriefing })),
      } as unknown as Env["ORCHESTRATOR"],
    });

    const response = await handleRequest(
      new Request("https://commander.test/api/connect", {
        method: "POST",
        headers: {
          authorization: "Bearer machine-secret",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          protocol_version: 1,
          session_id: "map-connect-session",
          mission_id: "map-connect-mission",
          mission_epoch: 3,
          faction: "OPFOR",
          map_name: "Everon",
        }),
      }),
      env,
    );

    expect(response.status).toBe(200);
    expect(connectSession).toHaveBeenCalledTimes(1);
    expect(setMapBriefing).not.toHaveBeenCalled();
  });

  it("fails closed when durable export routes have no R2 binding", async () => {
    const response = await handleRequest(
      new Request("http://127.0.0.1/admin/exports?session_id=session&faction=OPFOR&epoch=1", {
        method: "POST",
      }),
      makeEnv(),
    );

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "MISCONFIGURED" },
    });
  });

  it("persists, lists, and downloads one bounded durable export page through the HttpApi", async () => {
    const bucket = new FakeR2Bucket();
    const metadata = await Effect.runPromise(
      new R2SessionExportRepository(bucket).write(makeExport(), {
        exportedAt: 1_775_131_200_000,
        id: "route-export",
      }),
    );
    const persistSessionExport = vi.fn().mockResolvedValue(metadata);
    const env = makeEnv({
      SESSION_EXPORTS: bucket as unknown as NonNullable<Env["SESSION_EXPORTS"]>,
      ORCHESTRATOR: {
        getByName: vi.fn(() => ({ persistSessionExport })),
      } as unknown as Env["ORCHESTRATOR"],
    });

    const persisted = await handleRequest(
      new Request(
        "http://127.0.0.1/admin/exports?session_id=route-session&faction=OPFOR&epoch=3&export_id=route-export",
        { method: "POST" },
      ),
      env,
    );
    expect(persisted.status).toBe(200);
    await expect(persisted.json()).resolves.toMatchObject({
      key: metadata.key,
      exportId: "route-export",
    });
    expect(persistSessionExport).toHaveBeenCalledWith("route-export");

    const listed = await handleRequest(
      new Request(
        "http://127.0.0.1/admin/exports?session_id=route-session&faction=OPFOR&epoch=3&limit=1",
      ),
      env,
    );
    expect(listed.status).toBe(200);
    await expect(listed.json()).resolves.toMatchObject({
      exports: [{ key: metadata.key, exportId: "route-export" }],
    });

    const downloaded = await handleRequest(
      new Request(`http://127.0.0.1/admin/exports/object?key=${encodeURIComponent(metadata.key)}`),
      env,
    );
    expect(downloaded.status).toBe(200);
    await expect(downloaded.json()).resolves.toMatchObject({
      metadata: { key: metadata.key, exportId: "route-export" },
      header: { session: { session_id: "route-session", faction: "OPFOR", mission_epoch: 3 } },
      page: { logs: [], ticks: [], events: [], snapshots: [] },
      index: 0,
    });
  });

  it("passes an Agent response through without losing its WebSocket attachment", async () => {
    const webSocket = { id: "commander-upgrade" };
    const agentResponse = new Response("agent-response", {
      headers: { "x-agent": "orchestrator" },
    });
    Object.defineProperty(agentResponse, "webSocket", { value: webSocket });
    mocks.agentRoute.mockResolvedValue(agentResponse);

    const response = await handleRequest(
      new Request("http://127.0.0.1/agents/orchestrator/demo", {
        headers: { upgrade: "websocket" },
      }),
      makeEnv(),
    );

    expect(response).toBe(agentResponse);
    expect((response as Response & { readonly webSocket: unknown }).webSocket).toBe(webSocket);
    expect(response.headers.get("x-agent")).toBe("orchestrator");
  });
});
