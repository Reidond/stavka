import {
  TickRequest,
  TickResponse,
  computeMapBriefingContentHash,
  decodeMapBriefing,
  decodeMapUploadRequest,
  decodeTickRequest,
  decodeTickResponse,
} from "@stavka/protocol";
import {
  applyCasualty,
  createScenario,
  createWorld,
  drainEvents,
  executeCommand,
  spawnGroup,
  spawnVehicle,
  stepWorldMany,
} from "@stavka/sim-core";
import { Effect, Schema } from "effect";
import { describe, expect, it } from "vitest";

import test12Fixture from "../../protocol/fixtures/test-12-round-trip.json";

import {
  ConnectRejectedError,
  EventFilter,
  RestCommanderLink,
  RestCommanderLinkStateMismatchError,
  RestRequestTimeoutError,
  RestTransport,
  SergeantReporter,
  TickResponseMismatchError,
  TickInFlightError,
  Transport,
  createMapBriefing,
  decayKnownEnemies,
  diffSnapshots,
  filterVisibleEvents,
  projectWorld,
  toLegacyTest12Request,
  type TransportService,
} from "../src";

const response = (tickId: number, overrides: Partial<TickResponse> = {}): TickResponse => ({
  protocol_version: 1,
  tick_id: tickId,
  commands: [],
  tick_rate_hint: 750,
  request_full_snapshot: false,
  config_updates: {},
  commander_status: {
    connected: true,
    mode: "rule",
    doctrine: "balanced",
    decision_pending: false,
    active_groups: 1,
  },
  ...overrides,
});

describe("state mirroring", () => {
  it("builds a deterministic map briefing without out-of-bounds terrain cells", () => {
    const world = createWorld({ seed: 5, terrainWidth: 32, terrainHeight: 24 });
    const briefing = createMapBriefing(world, "Test Range");
    const repeated = createMapBriefing(world, "Test Range");
    const elevations = briefing.terrain_grid.map((cell) => cell.elevation);
    const types = new Set(briefing.terrain_grid.map((cell) => cell.type));
    const covers = new Set(briefing.terrain_grid.map((cell) => cell.cover));
    const terrainPromptData = {
      keyFeatures: briefing.key_features,
      coverSummary: briefing.terrain_grid.reduce<Record<string, number>>((summary, cell) => {
        summary[cell.cover] = (summary[cell.cover] ?? 0) + 1;
        return summary;
      }, {}),
    };

    expect(repeated).toEqual(briefing);
    expect(briefing.map_name).toBe("Test Range");
    expect(briefing.grid_size).toBe(32);
    expect(briefing.grid_width).toBe(32);
    expect(briefing.grid_height).toBe(24);
    expect(briefing.grid_resolution_meters).toBe(10);
    expect(briefing).toMatchObject({
      source: "simulator_synthetic",
      classification_version: 1,
      content_hash: expect.stringMatching(/^stavka-map-v1-[0-9a-f]{16}$/),
    });
    expect(decodeMapBriefing(briefing)).toEqual(briefing);
    expect(computeMapBriefingContentHash(briefing)).toBe(briefing.content_hash);
    expect(
      computeMapBriefingContentHash({
        ...briefing,
        grid_width: briefing.grid_height,
        grid_height: briefing.grid_width,
      }),
    ).not.toBe(briefing.content_hash);
    const firstCell = briefing.terrain_grid[0];
    if (!firstCell) throw new Error("Expected classified terrain cells");
    expect(
      computeMapBriefingContentHash({
        ...briefing,
        terrain_grid: [
          { ...firstCell, elevation: firstCell.elevation + 0.1 },
          ...briefing.terrain_grid.slice(1),
        ],
      }),
    ).not.toBe(briefing.content_hash);
    expect(elevations).not.toContain(-256);
    expect(types).toEqual(new Set(["forest", "road", "field", "urban"]));
    expect(covers).toEqual(new Set(["none", "light", "heavy", "urban"]));
    expect(
      briefing.terrain_grid.reduce<Record<string, number>>((counts, cell) => {
        counts[cell.type] = (counts[cell.type] ?? 0) + 1;
        return counts;
      }, {}),
    ).toEqual({ forest: 157, road: 46, field: 368, urban: 13 });
    expect(
      briefing.terrain_grid.reduce<Record<string, number>>((counts, cell) => {
        counts[cell.cover] = (counts[cell.cover] ?? 0) + 1;
        return counts;
      }, {}),
    ).toEqual({ none: 414, heavy: 81, light: 76, urban: 13 });
    expect(briefing.terrain_grid.some((cell) => cell.type !== "water" && !cell.traversable)).toBe(
      true,
    );
    expect(briefing.key_features).toMatchObject([
      { name: "Highest point", elevation: Math.max(...elevations) },
      { name: "Central settlement", type: "settlement" },
    ]);
    expect(terrainPromptData.coverSummary).toMatchObject({
      none: expect.any(Number),
      light: expect.any(Number),
      heavy: expect.any(Number),
      urban: expect.any(Number),
    });
    expect(terrainPromptData.keyFeatures.map((feature) => feature.type)).toEqual([
      "high_ground",
      "settlement",
    ]);
  });

  it("omits sentinel cells and marks steep valid terrain as non-traversable", () => {
    const base = createWorld({ seed: 6, terrainWidth: 3, terrainHeight: 3 });
    const world = {
      ...base,
      terrain: {
        ...base.terrain,
        samples: [-256, 10, -256, 10, 100, 10, -256, 10, -256],
      },
    };
    const briefing = createMapBriefing(world);

    expect(briefing.terrain_grid).toHaveLength(5);
    expect(
      briefing.terrain_grid.find((cell) => cell.grid[0] === 1 && cell.grid[1] === 1),
    ).toMatchObject({
      elevation: 100,
      traversable: false,
    });
    expect(briefing.terrain_grid.some((cell) => cell.type === "water")).toBe(false);
    expect(briefing.terrain_grid.filter((cell) => cell.elevation === 10)).toEqual(
      expect.arrayContaining([expect.objectContaining({ traversable: false })]),
    );
  });

  it("does not invent water from tied valid elevations", () => {
    const base = createWorld({ seed: 6, terrainWidth: 10, terrainHeight: 10 });
    const world = {
      ...base,
      terrain: {
        ...base.terrain,
        samples: Array.from({ length: 100 }, () => 10),
      },
    };
    const briefing = createMapBriefing(world);
    const water = briefing.terrain_grid.filter((cell) => cell.type === "water");

    expect(water).toEqual([]);
    expect(briefing.terrain_grid).toHaveLength(100);
  });

  it("keeps a one-cell flat terrain usable and feature coordinates unique", () => {
    const base = createWorld({ seed: 7, terrainWidth: 1, terrainHeight: 1 });
    const world = { ...base, terrain: { ...base.terrain, samples: [10] } };
    const briefing = createMapBriefing(world);

    expect(briefing.terrain_grid).toMatchObject([{ type: "urban", traversable: true }]);
    expect(new Set(briefing.key_features.map((feature) => feature.grid.join(":"))).size).toBe(
      briefing.key_features.length,
    );
  });

  it("projects full state then emits movement and mission-time deltas", () => {
    const world = createScenario("movement", 5);
    const before = projectWorld(world, "BLUFOR", { sessionId: "s" });
    stepWorldMany(world, 300);
    const after = projectWorld(world, "BLUFOR", { sessionId: "s" });
    const delta = diffSnapshots(before, after);
    expect(delta.groups_upserted).toHaveLength(0);
    expect(delta.groups_moved).toHaveLength(1);
    expect(delta.mission).toEqual(after.mission);
    expect(delta).not.toHaveProperty("objectives_removed");
  });

  it("emits changed mission state and removed objective IDs in deltas", () => {
    const world = createScenario("movement", 5);
    const projected = projectWorld(world, "BLUFOR", { sessionId: "s" });
    const before = {
      ...projected,
      objectives: [
        {
          id: "objective-1",
          name: "Crossroads",
          position: [100, 0, 100] as const,
          status: "neutral" as const,
          capture_progress: 0,
        },
      ],
    };
    const after = {
      ...before,
      mission: {
        ...before.mission,
        time_elapsed_seconds: before.mission.time_elapsed_seconds + 1,
        player_count: { friendly: 2, enemy: 1 },
      },
      objectives: [],
    };

    expect(diffSnapshots(before, after)).toMatchObject({
      mission: after.mission,
      objectives_upserted: [],
      objectives_removed: ["objective-1"],
    });
  });

  it("uses strict XZ movement thresholds and ignores elevation-only changes", () => {
    const before = projectWorld(createScenario("movement", 5), "BLUFOR", { sessionId: "s" });
    const group = before.friendly_groups[0];
    if (!group) throw new Error("Expected a projected group");
    const withPosition = (position: typeof group.position) => ({
      ...before,
      friendly_groups: [{ ...group, position }],
    });

    expect(
      diffSnapshots(before, withPosition([group.position[0] + 50, 999, group.position[2]]), 50)
        .groups_moved,
    ).toEqual([]);
    expect(
      diffSnapshots(before, withPosition([group.position[0] + 50.001, 0, group.position[2]]), 50)
        .groups_moved,
    ).toHaveLength(1);
    expect(
      diffSnapshots(before, withPosition([group.position[0], 999, group.position[2]]), 0)
        .groups_moved,
    ).toEqual([]);
  });

  it("projects objective ownership relative to each faction", () => {
    const world = createWorld({ seed: 8 });
    world.objectives.alpha = {
      id: "alpha",
      name: "Alpha",
      position: [100, 0, 100],
      status: "friendly",
      capture_progress: 1,
      ownerFaction: "BLUFOR",
    };

    expect(projectWorld(world, "BLUFOR", { sessionId: "blue" }).objectives[0]?.status).toBe(
      "friendly",
    );
    expect(projectWorld(world, "OPFOR", { sessionId: "red" }).objectives[0]?.status).toBe("enemy");
  });

  it("keeps legacy Test 12 behind an explicit adapter", () => {
    const world = createScenario("movement", 5);
    const request: TickRequest = {
      protocol_version: 1,
      session_id: "s",
      faction: "BLUFOR",
      tick_id: 3,
      timestamp: 1,
      full_snapshot_interval: 30,
      type: "full",
      snapshot: projectWorld(world, "BLUFOR", { sessionId: "s" }),
      sergeant_reports: [],
      events: [],
      command_results: [],
    };
    expect(toLegacyTest12Request(request)).toMatchObject({ tick: 3, groups: [{ id: "blue_1" }] });
  });

  it("runs all three derived Test-12 ticks through projection, decoding, and execution", async () => {
    const goldenRequest = decodeTickRequest(test12Fixture.request);
    if (goldenRequest.type !== "full") throw new Error("Expected a full Test-12 request");
    const goldenGroup = goldenRequest.snapshot.friendly_groups[0];
    if (!goldenGroup) throw new Error("Expected a Test-12 group");

    const world = createWorld({ seed: 12 });
    const group = spawnGroup(world, {
      id: goldenGroup.id,
      faction: goldenGroup.faction,
      template: goldenGroup.template,
      position: goldenGroup.position,
      strength: goldenGroup.strength.max,
    });
    group.behavior = goldenGroup.behavior;
    for (let index = 0; index < goldenRequest.snapshot.resources.vehicle_pool; index += 1) {
      spawnVehicle(world, {
        id: `fixture-vehicle-${index}`,
        template: "fixture_vehicle",
        position: [0, 0, 0],
      });
    }
    stepWorldMany(world, 10);
    drainEvents(world);
    world.tick = 0;
    world.timeMs = 0;
    let nowMs = goldenRequest.timestamp * 1_000;
    const transport: TransportService = {
      postJson: (path, body) => {
        if (path !== "/api/tick") return Effect.fail(new Error(`Unexpected Test-12 path ${path}`));
        const request = decodeTickRequest(body);
        const fixtureTick = test12Fixture.ticks.find(
          (entry) => entry.request.tick_id === request.tick_id,
        );
        return fixtureTick === undefined
          ? Effect.fail(new Error(`Missing Test-12 response for tick ${request.tick_id}`))
          : Effect.succeed(fixtureTick.response);
      },
    };
    const link = new RestCommanderLink({
      endpoint: "https://unused.test",
      apiKey: "unused",
      sessionId: goldenRequest.session_id,
      missionId: goldenRequest.snapshot.mission.id,
      missionName: goldenRequest.snapshot.mission.name,
      faction: goldenRequest.faction,
      mapName: goldenRequest.snapshot.mission.map,
      fullSnapshotInterval: goldenRequest.full_snapshot_interval,
      now: () => nowMs,
      transport,
    });

    for (let index = 0; index < test12Fixture.ticks.length; index += 1) {
      const fixtureTick = test12Fixture.ticks[index];
      if (!fixtureTick) throw new Error(`Missing Test-12 fixture tick ${index + 1}`);
      if (index > 0) stepWorldMany(world, 80);
      nowMs = fixtureTick.request.timestamp * 1_000;
      const outcome = await link.tick(world);
      expect(Schema.encodeSync(TickRequest)(decodeTickRequest(outcome.request))).toEqual(
        fixtureTick.request,
      );
      expect(Schema.encodeSync(TickResponse)(decodeTickResponse(outcome.response))).toEqual(
        fixtureTick.response,
      );
    }

    expect(world.groups[goldenGroup.id]?.order).toMatchObject({
      kind: "forced_move",
      destination: [2359, 0, 2047],
    });
    expect(world.groups.grp_001).toMatchObject({ faction: "US", status: "idle" });
    expect(world.groups.grp_001?.agents).toHaveLength(6);
  });

  it("reveals enemies only through a nearby friendly reporter", () => {
    const world = createWorld({ seed: 3 });
    spawnGroup(world, { id: "blue", faction: "BLUFOR", template: "squad", position: [0, 0, 0] });
    spawnGroup(world, { id: "red", faction: "OPFOR", template: "squad", position: [1_000, 0, 0] });
    stepWorldMany(world, 10);
    expect(projectWorld(world, "BLUFOR", { sessionId: "fog" }).known_enemies).toEqual([]);
    const red = world.groups.red;
    if (!red) throw new Error("red group missing");
    red.position = [250, 0, 0];
    expect(projectWorld(world, "BLUFOR", { sessionId: "fog" }).known_enemies).toMatchObject([
      { id: "red", reported_by: "blue", confidence: "confirmed", age_seconds: 0 },
    ]);
  });

  it("makes sweep contact wider than attack and preserves detector direction", () => {
    const setup = (kind: "attack" | "sweep", range: number) => {
      const world = createWorld({ seed: 35 });
      spawnGroup(world, {
        id: "enemy",
        faction: "OPFOR",
        template: "squad",
        position: [range, 0, 0],
      });
      spawnGroup(world, {
        id: "observer",
        faction: "BLUFOR",
        template: "squad",
        position: [0, 0, 0],
      });
      stepWorldMany(world, 10);
      drainEvents(world);
      executeCommand(world, {
        command_id: kind,
        type: kind === "sweep" ? "sweep_group" : "attack_group",
        params: { group_id: "observer", destination: [range + 100, 0, 0] },
      });
      drainEvents(world);
      stepWorldMany(world, 1);
      return world;
    };
    const attack = setup("attack", 150);
    const sweep = setup("sweep", 150);
    const beyondSweep = setup("sweep", 201);

    expect(attack.events.some((item) => item.type === "contact")).toBe(false);
    expect(sweep.events).toMatchObject([
      { type: "contact", group_id: "observer", details: { target_group_id: "enemy" } },
    ]);
    expect(
      projectWorld(sweep, "BLUFOR", {
        sessionId: "sweep",
        detectionRangeMeters: 80,
      }).known_enemies,
    ).toMatchObject([{ id: "enemy", reported_by: "observer" }]);
    expect(
      projectWorld(attack, "BLUFOR", {
        sessionId: "attack",
        detectionRangeMeters: 80,
      }).known_enemies,
    ).toEqual([]);
    expect(beyondSweep.events.some((item) => item.type === "contact")).toBe(false);
  });

  it("ages last-known contacts deterministically and expires stale truth", () => {
    const visible = [
      {
        id: "red",
        reported_by: "blue",
        type: "infantry" as const,
        estimated_count: 6,
        last_known_position: [250, 0, 0] as const,
        confidence: "confirmed" as const,
        age_seconds: 0,
      },
    ];
    expect(decayKnownEnemies(visible, [], 20)).toMatchObject([
      { confidence: "probable", age_seconds: 20 },
    ]);
    expect(decayKnownEnemies(visible, [], 60)).toMatchObject([
      { confidence: "possible", age_seconds: 60 },
    ]);
    expect(decayKnownEnemies(visible, [], 150)).toMatchObject([
      { confidence: "stale", age_seconds: 150 },
    ]);
    expect(decayKnownEnemies(visible, [], 181)).toEqual([]);
  });
});

describe("event filtering", () => {
  it("drops events for groups outside the faction-visible state", () => {
    const events = [
      { id: "friendly", type: "move", timestamp: 0, significance: "notable", group_id: "blue" },
      { id: "hidden", type: "move", timestamp: 0, significance: "notable", group_id: "red" },
      { id: "global", type: "objective", timestamp: 0, significance: "urgent" },
    ] as const;

    expect(filterVisibleEvents(events, new Set(["blue"])).map((event) => event.id)).toEqual([
      "friendly",
      "global",
    ]);
  });

  it("flushes notable events only after the ten-second batch window", () => {
    const filter = new EventFilter();
    const notable = { id: "n", type: "move", timestamp: 0, significance: "notable" } as const;

    expect(filter.ingest([notable], 0).events).toEqual([]);
    expect(filter.ingest([], 9.9).events).toEqual([]);
    expect(filter.ingest([], 10)).toEqual({ dispatchNow: false, events: [notable] });
  });

  it("drops routine, batches notable, and urgent flushes the batch", () => {
    const filter = new EventFilter();
    filter.ingest([
      { id: "r", type: "heartbeat", timestamp: 0, significance: "routine" },
      { id: "n", type: "move", timestamp: 0, significance: "notable" },
    ]);
    const result = filter.ingest([
      { id: "u", type: "casualty", timestamp: 1, significance: "urgent" },
    ]);
    expect(result.dispatchNow).toBe(true);
    expect(result.events.map((item) => item.id)).toEqual(["n", "u"]);
  });

  it("restores a failed batch without changing its cadence", () => {
    const filter = new EventFilter();
    const notable = { id: "n", type: "move", timestamp: 0, significance: "notable" } as const;
    filter.ingest([notable], 0);
    const due = filter.ingest([], 10);
    filter.restore(due.events);

    expect(filter.ingest([], 10).events).toEqual([notable]);
  });
});

describe("sergeant reporting", () => {
  it("reports only contacts visible to the friendly detecting group", () => {
    const world = createWorld({ seed: 9 });
    spawnGroup(world, {
      id: "blue",
      faction: "BLUFOR",
      template: "squad",
      position: [0, 0, 0],
    });
    spawnGroup(world, {
      id: "red",
      faction: "OPFOR",
      template: "squad",
      position: [100, 0, 0],
      strength: 4,
    });
    stepWorldMany(world, 10);
    const snapshot = projectWorld(world, "BLUFOR", { sessionId: "s" });
    const reporter = new SergeantReporter();

    const reports = reporter.generate({
      snapshot,
      visibleEnemies: snapshot.known_enemies,
      events: [],
      timestamp: 1,
    });

    expect(reports).toMatchObject([
      {
        type: "sergeant_report",
        timestamp: 1,
        payload: {
          group_id: "blue",
          report_type: "contact",
          contacts: [{ type: "infantry", estimated_count: 4, bearing: 90, distance: 100 }],
        },
      },
    ]);
    expect(
      reporter.generate({
        snapshot,
        visibleEnemies: snapshot.known_enemies,
        events: [],
        timestamp: 2,
      }),
    ).toEqual([]);
  });

  it("synthesizes a destroyed-group casualty report from the previous friendly state", () => {
    const world = createWorld({ seed: 10 });
    spawnGroup(world, {
      id: "blue",
      faction: "BLUFOR",
      template: "squad",
      position: [0, 0, 0],
      strength: 1,
    });
    stepWorldMany(world, 10);
    drainEvents(world);
    const previousSnapshot = projectWorld(world, "BLUFOR", { sessionId: "s" });
    applyCasualty(world, "blue");
    const events = drainEvents(world);
    const snapshot = projectWorld(world, "BLUFOR", { sessionId: "s" });
    const reporter = new SergeantReporter();

    expect(
      reporter.generate({
        snapshot,
        previousSnapshot,
        visibleEnemies: snapshot.known_enemies,
        events,
        timestamp: 1,
      }),
    ).toMatchObject([
      {
        payload: {
          group_id: "blue",
          report_type: "casualty",
          strength: { current: 0, max: 1 },
          status: "destroyed",
          morale: "broken",
          request: "requesting_reinforcement",
        },
      },
    ]);
  });

  it("emits deterministic idle sitreps once per minute", () => {
    const world = createWorld({ seed: 11 });
    spawnGroup(world, {
      id: "blue",
      faction: "BLUFOR",
      template: "squad",
      position: [0, 0, 0],
    });
    stepWorldMany(world, 10);
    const snapshot = projectWorld(world, "BLUFOR", { sessionId: "s" });
    const reporter = new SergeantReporter();
    const context = { snapshot, visibleEnemies: [], events: [] } as const;

    expect(reporter.generate({ ...context, timestamp: 1 })).toEqual([]);
    expect(reporter.generate({ ...context, timestamp: 60.9 })).toEqual([]);
    expect(reporter.generate({ ...context, timestamp: 61 })).toMatchObject([
      { payload: { group_id: "blue", report_type: "sitrep", status: "idle" } },
    ]);
    expect(reporter.generate({ ...context, timestamp: 61.1 })).toEqual([]);
  });
});

describe("transport boundary", () => {
  it("exposes the REST implementation as an Effect service Layer", async () => {
    let receivedUrl = "";
    let receivedBody: unknown;
    let receivedHeaders = new Headers();
    const fetch: typeof globalThis.fetch = async (input, init) => {
      receivedUrl = String(input);
      receivedBody = JSON.parse(String(init?.body));
      receivedHeaders = new Headers(init?.headers);
      return Response.json({ ok: true });
    };
    const program = Effect.gen(function* () {
      const transport = yield* Transport;
      return yield* transport.postJson("/probe", { ready: true });
    }).pipe(
      Effect.provide(
        RestTransport.layer({
          endpoint: "https://commander.test/",
          apiKey: "secret",
          missionEpoch: 7,
          fetch,
        }),
      ),
    );

    await expect(Effect.runPromise(program)).resolves.toEqual({ ok: true });
    expect(receivedUrl).toBe("https://commander.test/probe");
    expect(receivedBody).toEqual({ ready: true });
    expect(receivedHeaders.get("authorization")).toBe("Bearer secret");
    expect(receivedHeaders.get("x-stavka-mission-epoch")).toBe("7");
  });

  it("lets RestCommanderLink consume an injected Effect-first transport", async () => {
    const calls: { readonly path: string; readonly body: unknown }[] = [];
    const transport: TransportService = {
      postJson: (path, body) =>
        Effect.sync(() => {
          calls.push({ path, body });
          return {
            protocol_version: 1,
            accepted: true,
            request_full_snapshot: true,
            tick_rate_hint: 2_500,
          };
        }),
    };
    const link = new RestCommanderLink({
      endpoint: "https://unused.test",
      apiKey: "unused",
      sessionId: "transport-session",
      faction: "BLUFOR",
      missionId: "transport-mission",
      missionEpoch: 7,
      doctrine: "aggressive",
      transport,
    });

    await expect(link.connect()).resolves.toMatchObject({ accepted: true });
    const briefing = createMapBriefing(createWorld({ seed: 4 }), "Transport Range");
    await expect(link.uploadMap(briefing)).resolves.toBeUndefined();
    expect(link.tickRateHint).toBe(2_500);
    expect(calls).toMatchObject([
      {
        path: "/api/connect",
        body: {
          session_id: "transport-session",
          faction: "BLUFOR",
          doctrine: "aggressive",
        },
      },
      {
        path: "/api/map",
        body: {
          protocol_version: 1,
          session_id: "transport-session",
          mission_id: "transport-mission",
          mission_epoch: 7,
          faction: "BLUFOR",
          briefing,
        },
      },
    ]);
    expect(decodeMapUploadRequest(calls[1]?.body)).toEqual(calls[1]?.body);
  });
});

describe("REST commander link", () => {
  it("fails a rejected connect without retaining a connected state", async () => {
    let accepted = true;
    const fetch: typeof globalThis.fetch = async () =>
      Response.json({
        protocol_version: 1,
        accepted,
        request_full_snapshot: true,
        tick_rate_hint: accepted ? 2_000 : 9_000,
      });
    const link = new RestCommanderLink({
      endpoint: "https://commander.test",
      apiKey: "key",
      sessionId: "s",
      faction: "BLUFOR",
      fetch,
    });

    await expect(link.connect()).resolves.toMatchObject({ accepted: true });
    expect(link.connected).toBe(true);
    expect(link.tickRateHint).toBe(2_000);

    accepted = false;
    await expect(link.connect()).rejects.toBeInstanceOf(ConnectRejectedError);
    expect(link.connected).toBe(false);
    expect(link.tickRateHint).toBe(2_000);
  });

  it("uses the server tick-rate hint when the host opts into scheduled ticks", async () => {
    let now = 1_000;
    let calls = 0;
    const fetch: typeof globalThis.fetch = async (_input, init) => {
      calls += 1;
      const request = JSON.parse(String(init?.body)) as TickRequest;
      return Response.json(response(request.tick_id, { tick_rate_hint: 2_000 }));
    };
    const world = createScenario("movement", 15);
    const link = new RestCommanderLink({
      endpoint: "https://commander.test",
      apiKey: "key",
      sessionId: "s",
      faction: "BLUFOR",
      fetch,
      now: () => now,
    });

    expect(await link.tickIfDue(world)).toBeDefined();
    now = 2_999;
    expect(await link.tickIfDue(world)).toBeUndefined();
    now = 3_000;
    expect(await link.tickIfDue(world)).toBeDefined();
    expect(calls).toBe(2);
  });

  it("sends full then delta, executes commands, and reports their result next tick", async () => {
    const requests: TickRequest[] = [];
    const epochs: string[] = [];
    const fetch: typeof globalThis.fetch = async (_input, init) => {
      const request = JSON.parse(String(init?.body)) as TickRequest;
      requests.push(request);
      epochs.push(new Headers(init?.headers).get("x-stavka-mission-epoch") ?? "");
      const command =
        request.tick_id === 1
          ? [
              {
                command_id: "move-1",
                type: "move_group" as const,
                params: { group_id: "blue_1", destination: [100, 0, 0] as const },
              },
            ]
          : [];
      return Response.json(response(request.tick_id, { commands: command }));
    };
    const world = createScenario("movement", 2);
    const link = new RestCommanderLink({
      endpoint: "https://commander.test/",
      apiKey: "sk-stavka-test",
      sessionId: "s",
      faction: "BLUFOR",
      fetch,
    });
    await link.tick(world);
    await link.tick(world);
    expect(requests[0]?.type).toBe("full");
    expect(requests[1]?.type).toBe("delta");
    expect(requests[1]?.command_results).toEqual([{ command_id: "move-1", status: "accepted" }]);
    expect(link.tickRateHint).toBe(750);
    expect(epochs).toEqual(["1", "1"]);
  });

  it("retries one transient retryable failure with its configured backoff", async () => {
    let calls = 0;
    const requests: TickRequest[] = [];
    const fetch: typeof globalThis.fetch = async (_input, init) => {
      calls += 1;
      const request = JSON.parse(String(init?.body)) as TickRequest;
      requests.push(request);
      if (calls === 2) return new Response("down", { status: 503 });
      return Response.json(response(request.tick_id));
    };
    const world = createScenario("movement", 2);
    const link = new RestCommanderLink({
      endpoint: "https://commander.test",
      apiKey: "key",
      sessionId: "s",
      faction: "BLUFOR",
      fetch,
      retryBaseDelayMs: 1,
      retryMaxAttempts: 1,
    });
    await link.tick(world);
    await expect(link.tick(world)).resolves.toMatchObject({ request: { type: "delta" } });
    expect(requests.map((request) => request.type)).toEqual(["full", "delta", "delta"]);
    expect(requests[1]?.tick_id).toBe(requests[2]?.tick_id);
  });

  it("forces a full resync only after bounded retry exhaustion", async () => {
    let calls = 0;
    const requests: TickRequest[] = [];
    const fetch: typeof globalThis.fetch = async (_input, init) => {
      calls += 1;
      const request = JSON.parse(String(init?.body)) as TickRequest;
      requests.push(request);
      if (request.tick_id === 2) return new Response("down", { status: 503 });
      return Response.json(response(request.tick_id));
    };
    const world = createScenario("movement", 2);
    const link = new RestCommanderLink({
      endpoint: "https://commander.test",
      apiKey: "key",
      sessionId: "s",
      faction: "BLUFOR",
      fetch,
      retryBaseDelayMs: 1,
      retryMaxAttempts: 2,
    });

    await link.tick(world);
    await expect(link.tick(world)).rejects.toThrow("503");
    await link.tick(world);

    expect(calls).toBe(5);
    expect(requests.map((request) => request.type)).toEqual([
      "full",
      "delta",
      "delta",
      "delta",
      "full",
    ]);
  });

  it("rejects a mismatched tick response before settling or executing its commands", async () => {
    const requests: TickRequest[] = [];
    const fetch: typeof globalThis.fetch = async (_input, init) => {
      const request = Schema.decodeUnknownSync(TickRequest)(JSON.parse(String(init?.body)));
      requests.push(request);
      if (request.tick_id === 1) {
        return Response.json(
          response(request.tick_id, {
            commands: [
              {
                command_id: "mismatch-move",
                type: "move_group",
                params: { group_id: "blue_1", destination: [10, 0, 0] },
              },
            ],
          }),
        );
      }
      if (request.tick_id === 2) {
        return Response.json(
          response(request.tick_id + 1, {
            commands: [
              {
                command_id: "must-not-execute",
                type: "despawn_group",
                params: { group_id: "blue_1" },
              },
            ],
          }),
        );
      }
      return Response.json(response(request.tick_id));
    };
    const world = createScenario("movement", 2);
    const link = new RestCommanderLink({
      endpoint: "https://commander.test",
      apiKey: "key",
      sessionId: "s",
      faction: "BLUFOR",
      fetch,
    });

    await link.tick(world);
    await expect(link.tick(world)).rejects.toBeInstanceOf(TickResponseMismatchError);

    expect(world.groups.blue_1).toBeDefined();
    expect(await link.snapshotState()).toMatchObject({
      command_ledger: [
        {
          result: { command_id: "mismatch-move", status: "accepted" },
          accepted_sent: false,
        },
      ],
    });

    await link.tick(world);
    expect(requests.map((request) => request.type)).toEqual(["full", "delta", "full"]);
    expect(requests[2]?.command_results).toEqual([
      { command_id: "mismatch-move", status: "accepted" },
    ]);
  });

  it("keeps a waypoint command accepted until the receiver reaches its terminal state across a checkpoint", async () => {
    const requests: TickRequest[] = [];
    let tickCalls = 0;
    const transport: TransportService = {
      postJson: (path, body) => {
        if (path !== "/api/tick") return Effect.fail(new Error(`Unexpected path ${path}`));
        const request = Schema.decodeUnknownSync(TickRequest)(body);
        requests.push(request);
        tickCalls += 1;
        return Effect.succeed(
          response(request.tick_id, {
            commands:
              tickCalls === 1
                ? [
                    {
                      command_id: "durable-move",
                      type: "move_group" as const,
                      params: { group_id: "blue", destination: [10, 0, 0] as const },
                    },
                  ]
                : [],
          }),
        );
      },
    };
    const options = {
      endpoint: "https://commander.test",
      apiKey: "key",
      sessionId: "durable-lifecycle",
      faction: "BLUFOR",
      transport,
    };
    const world = createWorld({ seed: 19 });
    spawnGroup(world, { id: "blue", faction: "BLUFOR", template: "squad", position: [0, 0, 0] });
    stepWorldMany(world, 10);
    const original = new RestCommanderLink(options);

    await original.tick(world);
    await original.tick(world);
    const checkpoint = JSON.parse(JSON.stringify(await original.snapshotState())) as unknown;
    expect(requests[1]?.command_results).toEqual([
      { command_id: "durable-move", status: "accepted" },
    ]);
    expect(checkpoint).toMatchObject({
      command_ledger: [
        {
          result: { command_id: "durable-move", status: "accepted" },
          accepted_sent: true,
          execution: { kind: "waypoint", group_id: "blue", waypoint_kind: "forced_move" },
        },
      ],
    });

    const restored = new RestCommanderLink(options);
    await restored.restoreState(checkpoint);
    stepWorldMany(world, 300);
    await restored.tick(world);
    await restored.tick(world);

    expect(requests[2]?.command_results).toEqual([
      { command_id: "durable-move", status: "accepted" },
    ]);
    expect(requests[3]?.command_results).toEqual([
      { command_id: "durable-move", status: "completed" },
    ]);
  });

  it("uses validated bounded timeouts and retry settings", async () => {
    let attempts = 0;
    const transport: TransportService = {
      postJson: () =>
        Effect.sync(() => {
          attempts += 1;
        }).pipe(Effect.andThen(Effect.never)),
    };
    const link = new RestCommanderLink({
      endpoint: "https://commander.test",
      apiKey: "key",
      sessionId: "timeout",
      faction: "BLUFOR",
      transport,
      requestTimeoutMs: 10,
      retryBaseDelayMs: 1,
      retryMaxAttempts: 1,
    });

    await expect(link.connect()).rejects.toBeInstanceOf(RestRequestTimeoutError);
    expect(attempts).toBe(2);

    const common = {
      endpoint: "https://commander.test",
      apiKey: "key",
      sessionId: "invalid-timeout",
      faction: "BLUFOR",
      transport,
    };
    expect(() => new RestCommanderLink({ ...common, requestTimeoutMs: 60_001 })).toThrow(
      RangeError,
    );
    expect(() => new RestCommanderLink({ ...common, retryBaseDelayMs: 0 })).toThrow(RangeError);
    expect(() => new RestCommanderLink({ ...common, retryMaxAttempts: 6 })).toThrow(RangeError);
  });

  it("rejects undefined config update keys instead of silently ignoring them", async () => {
    let calls = 0;
    const requests: TickRequest[] = [];
    const fetch: typeof globalThis.fetch = async (_input, init) => {
      calls += 1;
      const request = Schema.decodeUnknownSync(TickRequest)(JSON.parse(String(init?.body)));
      requests.push(request);
      return Response.json(
        response(request.tick_id, {
          config_updates:
            calls === 1
              ? ({ unsupported_key: true } as unknown as TickResponse["config_updates"])
              : {},
          commands:
            calls === 1
              ? [
                  {
                    command_id: "must-not-run",
                    type: "despawn_group",
                    params: { group_id: "blue_1" },
                  },
                ]
              : [],
        }),
      );
    };
    const world = createScenario("movement", 18);
    const link = new RestCommanderLink({
      endpoint: "https://commander.test",
      apiKey: "key",
      sessionId: "s",
      faction: "BLUFOR",
      fetch,
    });

    await expect(link.tick(world)).rejects.toThrow(/unsupported_key|unexpected/i);
    expect(world.groups.blue_1).toBeDefined();
    await link.tick(world);
    expect(requests.map((request) => request.type)).toEqual(["full", "full"]);
  });

  it("applies typed config updates and accumulates movement against the last report", async () => {
    const requests: TickRequest[] = [];
    const fetch: typeof globalThis.fetch = async (_input, init) => {
      const request = Schema.decodeUnknownSync(TickRequest)(JSON.parse(String(init?.body)));
      requests.push(request);
      return Response.json(
        response(request.tick_id, {
          config_updates:
            request.tick_id === 1
              ? {
                  full_snapshot_interval: 15,
                  detection_range_meters: 450,
                  contact_expiry_seconds: 240,
                  delta_movement_threshold_meters: 25,
                }
              : {},
        }),
      );
    };
    const world = createScenario("movement", 20);
    const link = new RestCommanderLink({
      endpoint: "https://commander.test",
      apiKey: "key",
      sessionId: "s",
      faction: "BLUFOR",
      fetch,
    });

    await link.tick(world);
    stepWorldMany(world, 100);
    await link.tick(world);
    stepWorldMany(world, 30);
    await link.tick(world);

    expect(requests[1]).toMatchObject({
      type: "delta",
      full_snapshot_interval: 15,
      changes: { groups_moved: [] },
    });
    expect(requests[2]).toMatchObject({
      type: "delta",
      changes: { groups_moved: [{ id: "blue_1" }] },
    });
    expect(await link.snapshotState()).toMatchObject({
      full_snapshot_interval: 15,
      detection_range_meters: 450,
      contact_expiry_seconds: 240,
      delta_movement_threshold_meters: 25,
    });
  });

  it("restores JSON-safe link state without losing cadence, reports, or queued results", async () => {
    let now = 0;
    let tickCalls = 0;
    const requests: TickRequest[] = [];
    const transport: TransportService = {
      postJson: (path, body) => {
        if (path === "/api/connect") {
          return Effect.succeed({
            protocol_version: 1,
            accepted: true,
            request_full_snapshot: true,
            tick_rate_hint: 60_000,
          });
        }
        if (path !== "/api/tick") {
          return Effect.fail(new Error(`Unexpected state test path ${path}`));
        }
        const request = Schema.decodeUnknownSync(TickRequest)(body);
        requests.push(request);
        tickCalls += 1;
        return Effect.succeed(
          response(request.tick_id, {
            tick_rate_hint: 60_000,
            commands:
              tickCalls === 1
                ? [
                    {
                      command_id: "persisted-move",
                      type: "move_group",
                      params: { group_id: "blue", destination: [200, 0, 0] },
                    },
                  ]
                : [],
          }),
        );
      },
    };
    const options = {
      endpoint: "https://private-commander.test",
      apiKey: "super-secret-key",
      sessionId: "persisted-session",
      faction: "BLUFOR",
      doctrine: "defensive" as const,
      transport,
      now: () => now,
    };
    const world = createWorld({ seed: 19 });
    spawnGroup(world, { id: "blue", faction: "BLUFOR", template: "squad", position: [0, 0, 0] });
    spawnGroup(world, { id: "red", faction: "OPFOR", template: "squad", position: [100, 0, 0] });
    stepWorldMany(world, 10);
    const original = new RestCommanderLink(options);
    await original.connect();
    await original.tickIfDue(world);
    expect(original.shouldTick(world)).toBe(false);

    const persisted = JSON.parse(JSON.stringify(await original.snapshotState())) as unknown;
    expect(JSON.stringify(persisted)).not.toContain("super-secret-key");
    expect(JSON.stringify(persisted)).not.toContain("private-commander.test");
    const restored = new RestCommanderLink(options);
    await restored.restoreState(persisted);
    expect(restored.connected).toBe(true);
    expect(restored.shouldTick(world)).toBe(false);

    stepWorldMany(world, 100);
    now = 1_000;
    expect(restored.shouldTick(world)).toBe(true);
    const outcome = await restored.tickIfDue(world);

    expect(outcome?.request).toMatchObject({
      tick_id: 2,
      type: "delta",
      since_tick: 1,
      command_results: [{ command_id: "persisted-move", status: "accepted" }],
    });
    expect(outcome?.request.events.length).toBeGreaterThan(0);
    expect(
      outcome?.request.sergeant_reports.some((report) => report.payload.report_type === "contact"),
    ).toBe(false);
    expect(requests).toHaveLength(2);
  });

  it("rejects incompatible link state atomically", async () => {
    const transport: TransportService = {
      postJson: () => Effect.fail(new Error("transport should not be called")),
    };
    const source = new RestCommanderLink({
      endpoint: "https://unused.test",
      apiKey: "secret",
      sessionId: "source",
      faction: "BLUFOR",
      transport,
    });
    const persisted = await source.snapshotState();
    const target = new RestCommanderLink({
      endpoint: "https://unused.test",
      apiKey: "different-secret",
      sessionId: "target",
      faction: "BLUFOR",
      transport,
    });

    await expect(target.restoreState(persisted)).rejects.toBeInstanceOf(
      RestCommanderLinkStateMismatchError,
    );
    await expect(target.restoreState({ ...persisted, version: 2 })).rejects.toThrow();
    expect(await target.snapshotState()).toMatchObject({
      session_id: "target",
      tick_id: 0,
      connected: false,
    });
  });

  it("batches notable events for ten seconds and queues a synthesized sitrep", async () => {
    let now = 0;
    const requests: TickRequest[] = [];
    const fetch: typeof globalThis.fetch = async (_input, init) => {
      const request = JSON.parse(String(init?.body)) as TickRequest;
      requests.push(request);
      return Response.json(response(request.tick_id, { tick_rate_hint: 60_000 }));
    };
    const world = createScenario("movement", 12);
    const link = new RestCommanderLink({
      endpoint: "https://commander.test",
      apiKey: "key",
      sessionId: "s",
      faction: "BLUFOR",
      fetch,
      now: () => now,
    });

    await link.tickIfDue(world);
    stepWorldMany(world, 100);
    now = 1_000;
    await link.tickIfDue(world);

    expect(requests[0]?.events).toEqual([]);
    expect(requests[1]?.events.map((event) => event.type)).toEqual([
      "group_spawned",
      "order_issued",
      "agents_materialized",
    ]);
    expect(requests[1]?.sergeant_reports).toMatchObject([
      { payload: { group_id: "blue_1", report_type: "sitrep", status: "moving" } },
    ]);
  });

  it("does not leak hidden enemy events or contacts into reports", async () => {
    const requests: TickRequest[] = [];
    const fetch: typeof globalThis.fetch = async (_input, init) => {
      const request = JSON.parse(String(init?.body)) as TickRequest;
      requests.push(request);
      return Response.json(response(request.tick_id));
    };
    const world = createWorld({ seed: 14 });
    spawnGroup(world, {
      id: "blue",
      faction: "BLUFOR",
      template: "squad",
      position: [0, 0, 0],
    });
    spawnGroup(world, {
      id: "red",
      faction: "OPFOR",
      template: "squad",
      position: [1_000, 0, 0],
    });
    stepWorldMany(world, 10);
    const link = new RestCommanderLink({
      endpoint: "https://commander.test",
      apiKey: "key",
      sessionId: "s",
      faction: "BLUFOR",
      fetch,
    });

    await link.tick(world);
    stepWorldMany(world, 100);
    await link.tick(world);

    expect(requests[1]?.events.every((event) => event.group_id !== "red")).toBe(true);
    expect(requests[1]?.sergeant_reports).toMatchObject([
      { payload: { group_id: "blue", contacts: [] } },
    ]);
  });

  it("flushes urgent casualties immediately with a synthesized report", async () => {
    let now = 0;
    const requests: TickRequest[] = [];
    const fetch: typeof globalThis.fetch = async (_input, init) => {
      const request = JSON.parse(String(init?.body)) as TickRequest;
      requests.push(request);
      return Response.json(response(request.tick_id, { tick_rate_hint: 60_000 }));
    };
    const world = createWorld({ seed: 13 });
    spawnGroup(world, {
      id: "blue",
      faction: "BLUFOR",
      template: "squad",
      position: [0, 0, 0],
      strength: 2,
    });
    stepWorldMany(world, 10);
    const link = new RestCommanderLink({
      endpoint: "https://commander.test",
      apiKey: "key",
      sessionId: "s",
      faction: "BLUFOR",
      fetch,
      now: () => now,
    });

    await link.tickIfDue(world);
    applyCasualty(world, "blue");
    now = 1;
    await link.tickIfDue(world);

    expect(requests[1]?.events.at(-1)?.type).toBe("casualty");
    expect(requests[1]?.sergeant_reports).toMatchObject([
      { payload: { group_id: "blue", report_type: "casualty" } },
    ]);
  });

  it("bypasses the tick hint when a friendly group detects a new contact", async () => {
    let now = 0;
    const requests: TickRequest[] = [];
    const fetch: typeof globalThis.fetch = async (_input, init) => {
      const request = JSON.parse(String(init?.body)) as TickRequest;
      requests.push(request);
      return Response.json(response(request.tick_id, { tick_rate_hint: 60_000 }));
    };
    const world = createWorld({ seed: 16 });
    spawnGroup(world, {
      id: "blue",
      faction: "BLUFOR",
      template: "squad",
      position: [0, 0, 0],
    });
    spawnGroup(world, {
      id: "red",
      faction: "OPFOR",
      template: "squad",
      position: [1_000, 0, 0],
    });
    stepWorldMany(world, 10);
    const link = new RestCommanderLink({
      endpoint: "https://commander.test",
      apiKey: "key",
      sessionId: "s",
      faction: "BLUFOR",
      fetch,
      now: () => now,
    });

    await link.tickIfDue(world);
    const red = world.groups.red;
    if (!red) throw new Error("red group missing");
    red.position = [250, 0, 0];
    now = 1;
    await link.tickIfDue(world);

    expect(requests).toHaveLength(2);
    expect(requests[1]?.sergeant_reports).toMatchObject([
      { payload: { group_id: "blue", report_type: "contact" } },
    ]);
  });

  it("preserves fetch failures at the Promise boundary", async () => {
    const failure = new TypeError("network unavailable");
    const fetch: typeof globalThis.fetch = async () => {
      throw failure;
    };
    const link = new RestCommanderLink({
      endpoint: "https://commander.test",
      apiKey: "key",
      sessionId: "s",
      faction: "BLUFOR",
      fetch,
    });

    await expect(link.connect()).rejects.toBe(failure);
  });

  it("rejects an empty successful JSON response", async () => {
    const fetch: typeof globalThis.fetch = async () => new Response("", { status: 200 });
    const link = new RestCommanderLink({
      endpoint: "https://commander.test",
      apiKey: "key",
      sessionId: "s",
      faction: "BLUFOR",
      fetch,
    });

    await expect(link.connect()).rejects.toBeInstanceOf(SyntaxError);
  });

  it("validates connect responses at the protocol boundary", async () => {
    const fetch: typeof globalThis.fetch = async () =>
      Response.json({ protocol_version: 1, accepted: true });
    const link = new RestCommanderLink({
      endpoint: "https://commander.test",
      apiKey: "key",
      sessionId: "s",
      faction: "BLUFOR",
      fetch,
    });

    await expect(link.connect()).rejects.toThrow();
  });

  it("rejects concurrent ticks", async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const fetch: typeof globalThis.fetch = async (_input, init) => {
      await gate;
      const request = JSON.parse(String(init?.body)) as TickRequest;
      return Response.json(response(request.tick_id));
    };
    const world = createWorld({ seed: 1 });
    spawnGroup(world, { faction: "A", template: "squad", position: [0, 0, 0] });
    const link = new RestCommanderLink({
      endpoint: "https://commander.test",
      apiKey: "key",
      sessionId: "s",
      faction: "A",
      fetch,
    });
    const first = link.tick(world);
    await expect(link.tick(world)).rejects.toBeInstanceOf(TickInFlightError);
    release?.();
    await first;
  });
});
