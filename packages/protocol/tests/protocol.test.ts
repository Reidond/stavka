import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { Schema } from "effect";
import { describe, expect, it } from "vitest";

import {
  ConnectRequest,
  MapBriefing,
  SessionExport,
  TickRequest,
  TickResponse,
  computeMapBriefingContentHash,
  decodeCommand,
  decodeConnectRequest,
  decodeMapBriefing,
  decodeMapUploadRequest,
  decodeSessionExport,
  decodeTickRequest,
  decodeTickResponse,
} from "../src";

const fixturePath = fileURLToPath(new URL("../fixtures/test-12-round-trip.json", import.meta.url));
const fixture = JSON.parse(readFileSync(fixturePath, "utf8")) as {
  provenance: {
    source_document: string;
    source_sections: string[];
    legacy_wire_status: string;
    normalization: string;
    validated_environment: string;
  };
  request: unknown;
  response: unknown;
  ticks: Array<{
    phase: "move" | "spawn" | "noop";
    documented_state: string;
    legacy_response: unknown;
    request: unknown;
    response: unknown;
  }>;
};

const withMapHash = <T extends Parameters<typeof computeMapBriefingContentHash>[0]>(
  briefing: T,
) => ({
  ...briefing,
  content_hash: computeMapBriefingContentHash(briefing),
});

describe("wire protocol", () => {
  it("decodes and exactly re-encodes every complete Test 12 v1 message", () => {
    expect(fixture.provenance).toMatchObject({
      source_document: "PRODUCT.md",
      legacy_wire_status: expect.stringContaining("not all three raw request bodies"),
      validated_environment: expect.stringContaining("Windows"),
    });
    expect(fixture.ticks.map((tick) => tick.phase)).toEqual(["move", "spawn", "noop"]);
    expect(fixture.request).toEqual(fixture.ticks[0]?.request);
    expect(fixture.response).toEqual(fixture.ticks[0]?.response);

    for (const tick of fixture.ticks) {
      const request = decodeTickRequest(tick.request);
      const response = decodeTickResponse(tick.response);
      expect(Schema.encodeSync(TickRequest)(request)).toStrictEqual(tick.request);
      expect(Schema.encodeSync(TickResponse)(response)).toStrictEqual(tick.response);
      expect(response.tick_id).toBe(request.tick_id);
    }

    expect(fixture.ticks.map((tick) => tick.legacy_response)).toEqual([
      {
        tick: 1,
        commands: [
          {
            type: "move_group",
            groupId: 0,
            position: [2359, 0, 2047],
            waypointType: "ForcedMove",
          },
        ],
      },
      {
        tick: 2,
        commands: [
          {
            type: "spawn_group",
            prefab: "{84E5BBAB25EA23E5}Prefabs/Groups/BLUFOR/Group_US_FireTeam.et",
            position: [2059, 0, 2197],
            faction: "US",
          },
        ],
      },
      { tick: 3, commands: [] },
    ]);
  });

  it("rejects an unversioned tick", () => {
    const request = { ...(fixture.request as Record<string, unknown>) };
    delete request.protocol_version;
    expect(() => decodeTickRequest(request)).toThrow();
  });

  it("rejects non-finite, negative, fractional, empty, and excess core wire values", () => {
    const full = structuredClone(fixture.request) as Record<string, any>;
    const invalidTicks = [
      { ...full, session_id: "" },
      { ...full, faction: "  " },
      { ...full, tick_id: -1 },
      { ...full, timestamp: -1 },
      { ...full, full_snapshot_interval: 0 },
      { ...full, unexpected: true },
      {
        ...full,
        snapshot: { ...full.snapshot, mission: { ...full.snapshot.mission, epoch: 1.5 } },
      },
      {
        ...full,
        snapshot: {
          ...full.snapshot,
          friendly_groups: [
            { ...full.snapshot.friendly_groups[0], strength: { current: 7, max: 6 } },
          ],
        },
      },
      {
        ...full,
        snapshot: {
          ...full.snapshot,
          friendly_groups: [
            { ...full.snapshot.friendly_groups[0], position: [Number.POSITIVE_INFINITY, 0, 0] },
          ],
        },
      },
      {
        ...full,
        snapshot: {
          ...full.snapshot,
          resources: { ...full.snapshot.resources, vehicle_pool: -1 },
        },
      },
    ];
    for (const candidate of invalidTicks) expect(() => decodeTickRequest(candidate)).toThrow();

    expect(() =>
      decodeCommand({
        command_id: "patrol",
        type: "patrol_group",
        params: { group_id: "g", position: [0, 0, 0], radius: 0 },
      }),
    ).toThrow();
    expect(() =>
      decodeConnectRequest({
        protocol_version: 1,
        session_id: "session",
        mission_id: "mission",
        mission_epoch: 1,
        faction: "BLUFOR",
        map_name: "Poligon",
        unexpected: true,
      }),
    ).toThrow();
  });

  it("keeps legacy deltas valid while carrying mission updates and objective removals", () => {
    const full = decodeTickRequest(fixture.request);
    if (full.type !== "full") throw new Error("Expected the golden request to be full");
    const legacyDelta = {
      protocol_version: 1,
      session_id: full.session_id,
      faction: full.faction,
      tick_id: 2,
      timestamp: full.timestamp + 1,
      full_snapshot_interval: full.full_snapshot_interval,
      type: "delta",
      since_tick: full.tick_id,
      changes: {
        groups_upserted: [],
        groups_moved: [],
        groups_destroyed: [],
        objectives_upserted: [],
        known_enemies_upserted: [],
        known_enemies_expired: [],
      },
      sergeant_reports: [],
      events: [],
      command_results: [],
    } as const;
    expect(Schema.encodeSync(TickRequest)(decodeTickRequest(legacyDelta))).toEqual(legacyDelta);

    const enrichedDelta = {
      ...legacyDelta,
      changes: {
        ...legacyDelta.changes,
        mission: {
          ...full.snapshot.mission,
          time_elapsed_seconds: full.snapshot.mission.time_elapsed_seconds + 1,
          player_count: { friendly: 2, enemy: 3 },
        },
        objectives_removed: ["obj_retired"],
      },
    } as const;
    expect(Schema.encodeSync(TickRequest)(decodeTickRequest(enrichedDelta))).toEqual(enrichedDelta);
  });

  it("rejects deltas whose base tick does not precede the update tick", () => {
    const full = decodeTickRequest(fixture.request);
    if (full.type !== "full") throw new Error("Expected the golden request to be full");
    const delta = {
      protocol_version: 1,
      session_id: full.session_id,
      faction: full.faction,
      tick_id: 2,
      timestamp: full.timestamp + 1,
      full_snapshot_interval: full.full_snapshot_interval,
      type: "delta",
      since_tick: 1,
      changes: {
        groups_upserted: [],
        groups_moved: [],
        groups_destroyed: [],
        objectives_upserted: [],
        known_enemies_upserted: [],
        known_enemies_expired: [],
      },
      sergeant_reports: [],
      events: [],
      command_results: [],
    } as const;

    expect(decodeTickRequest(delta)).toEqual(delta);
    expect(() => decodeTickRequest({ ...delta, since_tick: delta.tick_id })).toThrow(
      /since_tick.*precede/i,
    );
    expect(() => decodeTickRequest({ ...delta, since_tick: delta.tick_id + 10 })).toThrow(
      /since_tick.*precede/i,
    );
  });

  it("rejects duplicate snapshot and delta entity ids plus destructive group conflicts", () => {
    const full = decodeTickRequest(fixture.request);
    const delta = decodeTickRequest(fixture.ticks[1]?.request);
    if (full.type !== "full" || delta.type !== "delta") {
      throw new Error("Expected full and delta Test-12 fixtures");
    }
    const group = full.snapshot.friendly_groups[0];
    if (!group) throw new Error("Expected Test-12 group");
    const objective = {
      id: "objective-1",
      name: "Objective 1",
      position: [10, 0, 20],
      status: "neutral",
      capture_progress: 0,
    } as const;
    const enemy = {
      id: "enemy-1",
      reported_by: group.id,
      type: "infantry",
      estimated_count: 4,
      last_known_position: [30, 0, 40],
      confidence: "probable",
      age_seconds: 1,
    } as const;

    for (const snapshot of [
      { ...full.snapshot, objectives: [objective, { ...objective }] },
      { ...full.snapshot, friendly_groups: [group, { ...group }] },
      { ...full.snapshot, known_enemies: [enemy, { ...enemy }] },
    ]) {
      expect(() => decodeTickRequest({ ...full, snapshot })).toThrow(/ids.*unique/i);
    }

    const baseChanges = {
      ...delta.changes,
      groups_upserted: [],
      groups_moved: [],
      groups_destroyed: [],
      objectives_upserted: [],
      objectives_removed: [],
      known_enemies_upserted: [],
      known_enemies_expired: [],
    };
    const movement = { id: group.id, position: group.position } as const;
    for (const changes of [
      { ...baseChanges, groups_upserted: [group, { ...group }] },
      { ...baseChanges, groups_moved: [movement, { ...movement }] },
      { ...baseChanges, groups_destroyed: [group.id, group.id] },
      { ...baseChanges, objectives_upserted: [objective, { ...objective }] },
      { ...baseChanges, objectives_removed: [objective.id, objective.id] },
      { ...baseChanges, known_enemies_upserted: [enemy, { ...enemy }] },
      { ...baseChanges, known_enemies_expired: [enemy.id, enemy.id] },
    ]) {
      expect(() => decodeTickRequest({ ...delta, changes })).toThrow(/ids.*unique/i);
    }

    expect(() =>
      decodeTickRequest({
        ...delta,
        changes: {
          ...baseChanges,
          groups_upserted: [group],
          groups_moved: [{ id: group.id, position: [999, 0, 999] }],
        },
      }),
    ).toThrow(/movement conflicts/i);
    for (const changes of [
      { ...baseChanges, groups_upserted: [group], groups_destroyed: [group.id] },
      { ...baseChanges, groups_moved: [movement], groups_destroyed: [group.id] },
    ]) {
      expect(() => decodeTickRequest({ ...delta, changes })).toThrow(/destroyed group/i);
    }

    expect(() =>
      decodeTickRequest({
        ...delta,
        changes: {
          ...baseChanges,
          groups_upserted: [group],
          groups_moved: [movement],
          objectives_upserted: [objective],
          objectives_removed: [objective.id],
          known_enemies_upserted: [enemy],
          known_enemies_expired: [enemy.id],
        },
      }),
    ).not.toThrow();
  });

  it("validates set_objective parameters as an action-discriminated contract", () => {
    const valid = [
      {
        command_id: "create",
        type: "set_objective",
        params: {
          objective_id: "alpha",
          action: "create",
          position: [10, 0, 20],
          status: "neutral",
        },
      },
      {
        command_id: "update",
        type: "set_objective",
        params: { objective_id: "alpha", action: "update", status: "contested" },
      },
      {
        command_id: "remove",
        type: "set_objective",
        params: { objective_id: "alpha", action: "remove" },
      },
      {
        command_id: "assign",
        type: "set_objective",
        params: { objective_id: "alpha", action: "assign", assignee_group_id: "blue" },
      },
    ] as const;
    for (const command of valid) expect(decodeCommand(command)).toEqual(command);

    const invalid = [
      {
        command_id: "create-missing-position",
        type: "set_objective",
        params: { objective_id: "alpha", action: "create" },
      },
      {
        command_id: "create-with-assignee",
        type: "set_objective",
        params: {
          objective_id: "alpha",
          action: "create",
          position: [0, 0, 0],
          assignee_group_id: "blue",
        },
      },
      {
        command_id: "empty-update",
        type: "set_objective",
        params: { objective_id: "alpha", action: "update" },
      },
      {
        command_id: "remove-with-status",
        type: "set_objective",
        params: { objective_id: "alpha", action: "remove", status: "neutral" },
      },
      {
        command_id: "assign-missing-group",
        type: "set_objective",
        params: { objective_id: "alpha", action: "assign" },
      },
      {
        command_id: "assign-with-position",
        type: "set_objective",
        params: {
          objective_id: "alpha",
          action: "assign",
          assignee_group_id: "blue",
          position: [0, 0, 0],
        },
      },
    ];
    for (const command of invalid) expect(() => decodeCommand(command)).toThrow();
  });

  it("validates an optional doctrine on connect without changing legacy connects", () => {
    const connect = {
      protocol_version: 1,
      session_id: "session",
      mission_id: "mission",
      mission_epoch: 1,
      faction: "OPFOR",
      map_name: "Poligon",
    } as const;
    expect(Schema.encodeSync(ConnectRequest)(decodeConnectRequest(connect))).toEqual(connect);
    expect(decodeConnectRequest({ ...connect, doctrine: "defensive" }).doctrine).toBe("defensive");
    expect(() => decodeConnectRequest({ ...connect, doctrine: "reckless" })).toThrow();
  });

  it("carries a compact optional decision summary without changing legacy responses", () => {
    const legacy = decodeTickResponse(fixture.response);
    expect(Schema.encodeSync(TickResponse)(legacy)).toEqual(fixture.response);

    const response = {
      ...(fixture.response as Record<string, unknown>),
      commander_status: {
        ...(fixture.response as { commander_status: Record<string, unknown> }).commander_status,
        last_decision: {
          id: "dec_000142",
          timestamp: "2026-08-02T21:55:00.000Z",
          summary: "Reinforce the northern approach.",
          model: "gpt-5.6-sol",
          latency_ms: 842,
          cost_usd: 0.0045,
        },
      },
    };
    expect(Schema.encodeSync(TickResponse)(decodeTickResponse(response))).toEqual(response);
    expect(() =>
      decodeTickResponse({
        ...response,
        commander_status: {
          ...(response.commander_status as Record<string, unknown>),
          last_decision: {
            ...(response.commander_status as { last_decision: Record<string, unknown> })
              .last_decision,
            cost_usd: -1,
          },
        },
      }),
    ).toThrow();
  });

  it("carries optional typed commander cost aggregates without changing legacy responses", () => {
    const legacy = decodeTickResponse(fixture.response);
    expect(Schema.encodeSync(TickResponse)(legacy)).toEqual(fixture.response);

    const response = {
      ...(fixture.response as Record<string, unknown>),
      commander_status: {
        ...(fixture.response as { commander_status: Record<string, unknown> }).commander_status,
        cost_aggregates: [
          {
            agent_tier: "commander",
            model: "stavka/commander",
            calls: 2,
            input_tokens: 1_200,
            output_tokens: 300,
            cost_usd: 0.0125,
          },
          {
            agent_tier: "sergeant",
            model: "stavka/sergeant",
            calls: 4,
            input_tokens: 800,
            output_tokens: 160,
            cost_usd: 0,
          },
        ],
      },
    };
    expect(Schema.encodeSync(TickResponse)(decodeTickResponse(response))).toEqual(response);

    for (const invalidAggregate of [
      {
        agent_tier: "observer",
        model: "m",
        calls: 0,
        input_tokens: 0,
        output_tokens: 0,
        cost_usd: 0,
      },
      {
        agent_tier: "commander",
        model: "",
        calls: 0,
        input_tokens: 0,
        output_tokens: 0,
        cost_usd: 0,
      },
      {
        agent_tier: "commander",
        model: "m",
        calls: -1,
        input_tokens: 0,
        output_tokens: 0,
        cost_usd: 0,
      },
      {
        agent_tier: "commander",
        model: "m",
        calls: 0.5,
        input_tokens: 0,
        output_tokens: 0,
        cost_usd: 0,
      },
      {
        agent_tier: "commander",
        model: "m",
        calls: 0,
        input_tokens: -1,
        output_tokens: 0,
        cost_usd: 0,
      },
      {
        agent_tier: "commander",
        model: "m",
        calls: 0,
        input_tokens: 0,
        output_tokens: -1,
        cost_usd: 0,
      },
      {
        agent_tier: "commander",
        model: "m",
        calls: 0,
        input_tokens: 0,
        output_tokens: 0,
        cost_usd: Number.POSITIVE_INFINITY,
      },
    ]) {
      expect(() =>
        decodeTickResponse({
          ...response,
          commander_status: {
            ...(response.commander_status as Record<string, unknown>),
            cost_aggregates: [invalidAggregate],
          },
        }),
      ).toThrow();
    }
  });

  it("accepts only constrained runtime config updates", () => {
    const configured = {
      ...(fixture.response as Record<string, unknown>),
      config_updates: {
        full_snapshot_interval: 15,
        detection_range_meters: 450,
        contact_expiry_seconds: 240,
        delta_movement_threshold_meters: 25,
      },
    };
    expect(Schema.encodeSync(TickResponse)(decodeTickResponse(configured))).toEqual(configured);

    for (const config_updates of [
      { full_snapshot_interval: 0 },
      { full_snapshot_interval: 1.5 },
      { detection_range_meters: 0 },
      { contact_expiry_seconds: Number.POSITIVE_INFINITY },
      { delta_movement_threshold_meters: -1 },
      { unsupported_key: true },
    ]) {
      expect(() =>
        decodeTickResponse({
          ...(fixture.response as Record<string, unknown>),
          config_updates,
        }),
      ).toThrow();
    }
  });

  it("rejects duplicate command ids within one tick response", () => {
    const response = decodeTickResponse(fixture.response);
    const command = response.commands[0];
    if (!command) throw new Error("Expected Test-12 command");
    expect(() =>
      decodeTickResponse({
        ...response,
        commands: [command, { ...command }],
      }),
    ).toThrow(/command_id.*unique/i);
  });

  it("rejects duplicate and conflicting command results within one tick request", () => {
    const request = decodeTickRequest(fixture.request);
    const accepted = { command_id: "same-command", status: "accepted" } as const;
    for (const command_results of [
      [accepted, { ...accepted }],
      [accepted, { command_id: accepted.command_id, status: "failed", reason: "rejected" }],
    ]) {
      expect(() => decodeTickRequest({ ...request, command_results })).toThrow(
        /command_id.*unique/i,
      );
    }
  });

  it("round-trips the stable replay export envelope and rejects mismatched ticks", () => {
    const request = decodeTickRequest(fixture.request);
    if (request.type !== "full") throw new Error("Expected full replay fixture");
    const replay = {
      export_version: 1,
      session: {
        protocol_version: 1,
        session_id: request.session_id,
        faction: request.faction,
        mission_epoch: request.snapshot.mission.epoch,
        doctrine: "balanced",
        mode: "rule",
        map_name: request.snapshot.mission.map,
        exported_at: "2026-08-02T12:00:00.000Z",
      },
      logs: [
        {
          id: "dec_000001",
          timestamp: "2026-08-02T12:00:00.000Z",
          agent: "commander",
          trigger: "scheduled_tick",
          input: { stateSnapshot: request.snapshot, events: [], prompt: "Hold position" },
          output: {
            rawResponse: "{}",
            parsedCommands: [],
            summary: "Held position.",
          },
          commandsIssued: [],
          model: "stavka/commander",
          latencyMs: 25,
          tokenUsage: { input: 20, output: 5 },
          costUsd: 0.001,
        },
      ],
      archive: {
        ticks: [
          {
            tickId: request.tick_id,
            timestamp: request.timestamp,
            kind: request.type,
            request,
          },
        ],
        events: [],
        snapshots: [
          { tickId: request.tick_id, timestamp: request.timestamp, snapshot: request.snapshot },
        ],
      },
      cost_aggregates: [
        {
          agent_tier: "commander",
          model: "stavka/commander",
          calls: 1,
          input_tokens: 20,
          output_tokens: 5,
          cost_usd: 0.001,
        },
      ],
    } as const;

    const firstTick = replay.archive.ticks[0];
    const firstSnapshot = replay.archive.snapshots[0];
    const deltaRequest = {
      protocol_version: 1,
      session_id: request.session_id,
      faction: request.faction,
      tick_id: request.tick_id + 1,
      timestamp: request.timestamp,
      full_snapshot_interval: request.full_snapshot_interval,
      type: "delta",
      since_tick: request.tick_id,
      changes: {
        groups_upserted: [],
        groups_moved: [],
        groups_destroyed: [],
        objectives_upserted: [],
        known_enemies_upserted: [],
        known_enemies_expired: [],
      },
      sergeant_reports: [],
      events: [],
      command_results: [],
    } as const;
    const deltaTick = {
      tickId: deltaRequest.tick_id,
      timestamp: deltaRequest.timestamp,
      kind: deltaRequest.type,
      request: deltaRequest,
    } as const;
    const secondFullRequest = {
      ...request,
      tick_id: request.tick_id + 1,
      timestamp: request.timestamp,
    };
    const secondFullTick = {
      tickId: secondFullRequest.tick_id,
      timestamp: secondFullRequest.timestamp,
      kind: secondFullRequest.type,
      request: secondFullRequest,
    } as const;

    expect(Schema.encodeSync(SessionExport)(decodeSessionExport(replay))).toEqual(replay);
    expect(() =>
      decodeSessionExport({
        ...replay,
        archive: { ...replay.archive, ticks: [firstTick, deltaTick] },
      }),
    ).not.toThrow();
    expect(() =>
      decodeSessionExport({
        ...replay,
        archive: { ...replay.archive, ticks: [firstTick, secondFullTick] },
      }),
    ).not.toThrow();
    expect(() =>
      decodeSessionExport({
        ...replay,
        archive: { ticks: [], events: [], snapshots: [] },
      }),
    ).not.toThrow();
    expect(() =>
      decodeSessionExport({
        ...replay,
        archive: {
          ...replay.archive,
          ticks: [{ ...replay.archive.ticks[0], tickId: request.tick_id + 1 }],
        },
      }),
    ).toThrow();
    for (const archive of [
      { ...replay.archive, ticks: [deltaTick], snapshots: [] },
      { ...replay.archive, ticks: [firstTick, firstTick] },
      { ...replay.archive, ticks: [secondFullTick, firstTick] },
      {
        ...replay.archive,
        ticks: [
          firstTick,
          {
            ...secondFullTick,
            timestamp: firstTick.timestamp - 1,
            request: { ...secondFullRequest, timestamp: firstTick.timestamp - 1 },
          },
        ],
      },
      {
        ...replay.archive,
        ticks: [
          firstTick,
          {
            ...deltaTick,
            request: {
              ...deltaRequest,
              snapshot: {
                ...request.snapshot,
                mission: { ...request.snapshot.mission, name: "Tampered delta snapshot" },
              },
            },
          },
        ],
      },
      {
        ...replay.archive,
        ticks: [
          firstTick,
          secondFullTick,
          {
            ...deltaTick,
            tickId: 3,
            request: {
              ...deltaRequest,
              tick_id: 3,
              since_tick: firstTick.tickId,
            },
          },
        ],
      },
      { ...replay.archive, snapshots: [firstSnapshot, firstSnapshot] },
      {
        ...replay.archive,
        snapshots: [{ ...firstSnapshot, tickId: firstSnapshot.tickId + 100 }],
      },
      {
        ...replay.archive,
        snapshots: [{ ...firstSnapshot, timestamp: firstSnapshot.timestamp + 1 }],
      },
      {
        ...replay.archive,
        snapshots: [
          {
            ...firstSnapshot,
            snapshot: {
              ...firstSnapshot.snapshot,
              mission: { ...firstSnapshot.snapshot.mission, name: "Tampered mission" },
            },
          },
        ],
      },
    ]) {
      expect(() => decodeSessionExport({ ...replay, archive })).toThrow();
    }
    expect(() =>
      decodeSessionExport({
        ...replay,
        session: { ...replay.session, session_id: "different-session" },
      }),
    ).toThrow();
    expect(() =>
      decodeSessionExport({
        ...replay,
        session: { ...replay.session, faction: "different-faction" },
      }),
    ).toThrow();
    expect(() => decodeSessionExport({ ...replay, unexpected: true })).toThrow();
  });

  it("round-trips a strict canonical non-square map briefing with optional slope data", () => {
    const briefing = withMapHash({
      map_name: "Synthetic Range",
      grid_size: 3,
      grid_width: 3,
      grid_height: 2,
      grid_resolution_meters: 10,
      source: "simulator_synthetic",
      classification_version: 1,
      terrain_grid: [
        {
          grid: [0, 0],
          type: "forest",
          cover: "heavy",
          elevation: 12.5,
          slope_degrees: 18.4,
          traversable: true,
        },
        {
          grid: [2, 1],
          type: "water",
          cover: "none",
          elevation: -1,
          traversable: false,
        },
      ],
      key_features: [
        {
          name: "Hill 12",
          grid: [0, 0],
          type: "high_ground",
          elevation: 12.5,
        },
      ],
    } as const);

    expect(Schema.encodeSync(MapBriefing)(decodeMapBriefing(briefing))).toEqual(briefing);
    expect(
      decodeMapUploadRequest({
        protocol_version: 1,
        session_id: "session",
        mission_id: "mission",
        mission_epoch: 1,
        faction: "USSR",
        briefing,
      }).briefing,
    ).toEqual(briefing);

    expect(
      computeMapBriefingContentHash({
        ...briefing,
        terrain_grid: [...briefing.terrain_grid].reverse(),
        key_features: [...briefing.key_features].reverse(),
      }),
    ).toBe(briefing.content_hash);
  });

  it("binds map identity to explicit dimensions and classified content", () => {
    const shared = {
      map_name: "Collision Range",
      grid_resolution_meters: 10,
      source: "simulator_synthetic",
      classification_version: 1,
      terrain_grid: [],
      key_features: [],
    } as const;
    const twoByThree = withMapHash({ ...shared, grid_size: 3, grid_width: 2, grid_height: 3 });
    const threeByTwo = withMapHash({ ...shared, grid_size: 3, grid_width: 3, grid_height: 2 });

    expect(twoByThree.content_hash).not.toBe(threeByTwo.content_hash);
    expect(decodeMapBriefing(twoByThree)).toEqual(twoByThree);
    expect(decodeMapBriefing(threeByTwo)).toEqual(threeByTwo);
    expect(() => decodeMapBriefing({ ...twoByThree, map_name: "Different Range" })).toThrow(
      /content_hash/i,
    );
  });

  it("rejects invalid, incoherent, out-of-bounds, sentinel, and excess map data", () => {
    const cell = {
      grid: [0, 0],
      type: "field",
      cover: "none",
      elevation: 10,
      slope_degrees: 0,
      traversable: true,
    } as const;
    const feature = {
      name: "Crossing",
      grid: [0, 0],
      type: "chokepoint",
      elevation: 10,
    } as const;
    const briefingWithoutHash = {
      map_name: "Range",
      grid_size: 2,
      grid_width: 2,
      grid_height: 2,
      grid_resolution_meters: 10,
      source: "simulator_synthetic",
      classification_version: 1,
      terrain_grid: [cell],
      key_features: [feature],
    } as const;
    const briefing = withMapHash(briefingWithoutHash);
    const invalid = [
      { ...briefing, grid_size: -1 },
      { ...briefing, grid_size: 1.5 },
      { ...briefing, grid_size: Number.NaN },
      { ...briefing, grid_resolution_meters: -1 },
      { ...briefing, grid_resolution_meters: 0 },
      { ...briefing, grid_resolution_meters: Number.NaN },
      { ...briefing, terrain_grid: [{ ...cell, grid: [-1, 0] }] },
      { ...briefing, terrain_grid: [{ ...cell, grid: [2, 0] }] },
      { ...briefing, terrain_grid: [{ ...cell, elevation: -256 }] },
      { ...briefing, terrain_grid: [{ ...cell, elevation: Number.POSITIVE_INFINITY }] },
      { ...briefing, terrain_grid: [{ ...cell, elevation: Number.NaN }] },
      { ...briefing, terrain_grid: [{ ...cell, slope_degrees: Number.NaN }] },
      { ...briefing, terrain_grid: [{ ...cell, slope_degrees: 91 }] },
      { ...briefing, terrain_grid: [{ ...cell, type: "unknown" }] },
      { ...briefing, terrain_grid: [{ ...cell, extra: true }] },
      { ...briefing, terrain_grid: [cell, cell] },
      { ...briefing, key_features: [{ ...feature, type: "hill" }] },
      { ...briefing, key_features: [{ ...feature, name: "" }] },
      { ...briefing, key_features: [{ ...feature, grid: [0, 2] }] },
      { ...briefing, key_features: [feature, { ...feature, name: "Duplicate" }] },
      { ...briefing, source: "unverified" },
      { ...briefing, grid_width: undefined },
      { ...briefing, grid_height: undefined },
      { ...briefing, grid_width: 2, grid_height: 2, grid_size: 3 },
      { ...briefing, source: undefined },
      { ...briefing, content_hash: undefined },
      { ...briefing, classification_version: 0 },
      { ...briefing, content_hash: "" },
      { ...briefing, map_name: "Tampered range" },
    ];

    for (const candidate of invalid) {
      expect(() => decodeMapBriefing(candidate)).toThrow();
    }
    for (const incoherent of [
      withMapHash({
        ...briefingWithoutHash,
        terrain_grid: [
          { ...cell, type: "water" as const, cover: "heavy" as const, traversable: true },
        ],
      }),
      withMapHash({
        ...briefingWithoutHash,
        terrain_grid: [{ ...cell, slope_degrees: 36, traversable: true }],
      }),
      withMapHash({
        ...briefingWithoutHash,
        terrain_grid: [{ ...cell, cover: "urban" as const }],
      }),
      withMapHash({
        ...briefingWithoutHash,
        key_features: [{ ...feature, grid: [1, 1] as const }],
      }),
    ]) {
      expect(() => decodeMapBriefing(incoherent)).toThrow();
    }
    expect(() =>
      decodeMapUploadRequest({
        protocol_version: 1,
        session_id: "session",
        mission_id: "mission",
        mission_epoch: 1,
        faction: "USSR",
        briefing,
        extra: true,
      }),
    ).toThrow();
  });

  it("keeps a 30-group full tick below the 50KB target", () => {
    const request = structuredClone(fixture.request) as {
      snapshot: { friendly_groups: unknown[] };
    };
    const group = request.snapshot.friendly_groups[0];
    request.snapshot.friendly_groups = Array.from({ length: 30 }, (_, index) => ({
      ...(group as Record<string, unknown>),
      id: `grp_${String(index + 1).padStart(2, "0")}`,
      position: [3150 + index * 10, 0, 4050 + index * 5],
    }));

    const encoded = JSON.stringify(decodeTickRequest(request));
    expect(new TextEncoder().encode(encoded).byteLength).toBeLessThan(50_000);
  });
});
