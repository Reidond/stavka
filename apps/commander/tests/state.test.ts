import type { TickRequest } from "@stavka/protocol";
import { describe, expect, it } from "vitest";

import type { CommanderConfig } from "../src/config";
import { planRuleCommander } from "../src/brain/rule-commander";
import {
  applyTick,
  cachedTickResponse,
  recoverPendingDecision,
  requestCommanderDecision,
  withConnect,
} from "../src/state/game-state";
import { initialCommanderState } from "../src/state/types";

const config: CommanderConfig = {
  commanderModel: "stavka/commander",
  sergeantModel: "stavka/sergeant",
  heavyModel: "stavka/heavy",
  decisionIntervalSeconds: 45,
  doctrine: "balanced",
  maxActiveUnits: 50,
  difficulty: 0.5,
  playerScaling: true,
  tickIdleMs: 2_000,
  tickActiveMs: 750,
  tickBurstMs: 300,
  aiProvider: "mock",
  aiBaseUrl: "http://127.0.0.1:4141",
  seatExhaustionPolicy: "fallback",
  seatStretchMultiplier: 4,
  seatHeartbeatTtlSeconds: 45,
  seatJobTimeoutSeconds: 30,
  seatKeys: {},
};

const fullTick = (): Extract<TickRequest, { readonly type: "full" }> => ({
  protocol_version: 1,
  session_id: "session",
  faction: "OPFOR",
  tick_id: 1,
  timestamp: 100,
  full_snapshot_interval: 30,
  type: "full",
  snapshot: {
    mission: {
      id: "mission",
      epoch: 1,
      name: "Test",
      map: "Poligon",
      time_elapsed_seconds: 100,
      player_count: { friendly: 1, enemy: 1 },
    },
    objectives: [
      {
        id: "obj",
        name: "Hill",
        position: [100, 0, 100],
        status: "enemy",
        capture_progress: 0,
      },
    ],
    friendly_groups: [],
    known_enemies: [],
    resources: {
      manpower: 150,
      vehicle_pool: 5,
      reinforcement_cooldown_seconds: 0,
      max_active_units: 50,
    },
  },
  sergeant_reports: [],
  events: [],
  command_results: [],
});

describe("commander state", () => {
  it("accepts a full snapshot and rejects stale deltas with a resync request", () => {
    const applied = applyTick(initialCommanderState(), fullTick(), config);
    expect(applied.accepted).toBe(true);
    const stale: TickRequest = {
      ...fullTick(),
      tick_id: 2,
      type: "delta",
      since_tick: 0,
      changes: {
        groups_upserted: [],
        groups_moved: [],
        groups_destroyed: [],
        objectives_upserted: [],
        known_enemies_upserted: [],
        known_enemies_expired: [],
      },
    };
    const result = applyTick(applied.state, stale, config);
    expect(result.accepted).toBe(false);
    expect(result.requestFullSnapshot).toBe(true);
  });

  it("keeps rule plans inside manpower and active-unit budgets", () => {
    const state = applyTick(initialCommanderState(), fullTick(), config).state;
    const plan = planRuleCommander(state, "scheduled_tick");
    expect(plan.commands).toHaveLength(1);
    expect(plan.commands[0]?.type).toBe("spawn_group");
    expect(plan.manpowerSpent).toBeLessThanOrEqual(state.budget.manpower);
  });

  it("moves rule-planned destinations off water onto traversable terrain", () => {
    const request = fullTick();
    const applied = applyTick(
      initialCommanderState(),
      {
        ...request,
        snapshot: {
          ...request.snapshot,
          objectives: [
            {
              id: "obj",
              name: "Hill",
              position: [5, 0, 5],
              status: "enemy",
              capture_progress: 0,
            },
          ],
          friendly_groups: [
            {
              id: "alpha",
              faction: "OPFOR",
              template: "infantry",
              position: [15, 0, 5],
              strength: { current: 8, max: 8 },
              status: "idle",
              behavior: "hold",
            },
          ],
          resources: { ...request.snapshot.resources, manpower: 0 },
        },
      },
      config,
    ).state;
    const state = {
      ...applied,
      mapBriefing: {
        map_name: "Everon",
        grid_size: 2,
        grid_width: 2,
        grid_height: 2,
        grid_resolution_meters: 10,
        source: "arma_extracted" as const,
        classification_version: 1,
        content_hash: "stavka-map-v1-rule-terrain",
        terrain_grid: [
          {
            grid: [0, 0] as const,
            type: "water" as const,
            cover: "none" as const,
            elevation: 0,
            traversable: false,
          },
          {
            grid: [1, 0] as const,
            type: "field" as const,
            cover: "heavy" as const,
            elevation: 12,
            traversable: true,
          },
        ],
        key_features: [
          {
            name: "Dry Hill",
            grid: [1, 0] as const,
            type: "high_ground" as const,
            elevation: 12,
          },
        ],
      },
    };

    const plan = planRuleCommander(state, "event:contact");

    expect(plan.commands).toHaveLength(1);
    expect(plan.commands[0]).toMatchObject({
      type: "attack_group",
      params: { group_id: "alpha", destination: [15, 12, 5] },
    });
  });

  it("keeps command outcomes for exactly the ten-minute short-term window", () => {
    const first = applyTick(
      initialCommanderState(),
      {
        ...fullTick(),
        command_results: [{ command_id: "cmd_1", status: "completed" }],
      },
      config,
    ).state;
    expect(first.memory.shortTerm.outcomes).toHaveLength(1);

    const withinWindow = applyTick(
      first,
      {
        ...fullTick(),
        tick_id: 2,
        timestamp: 700,
      },
      config,
    ).state;
    expect(withinWindow.memory.shortTerm.outcomes).toHaveLength(1);

    const expired = applyTick(
      withinWindow,
      {
        ...fullTick(),
        tick_id: 3,
        timestamp: 701,
      },
      config,
    ).state;
    expect(expired.memory.shortTerm.outcomes).toEqual([]);
  });

  it("compacts raw observations after two minutes and expires them after ten", () => {
    const observed = applyTick(
      initialCommanderState(),
      {
        ...fullTick(),
        events: [
          {
            id: "contact-1",
            type: "contact",
            timestamp: 100,
            significance: "notable",
            group_id: "alpha",
          },
        ],
        sergeant_reports: [
          {
            type: "sergeant_report",
            timestamp: 100,
            payload: {
              group_id: "alpha",
              report_type: "contact",
              position: [100, 0, 100],
              strength: { current: 8, max: 8 },
              status: "engaged",
              contacts: [],
              ammo_status: "adequate",
              morale: "steady",
              local_decision: "Holding contact",
            },
          },
        ],
      },
      config,
    ).state;

    expect(observed.memory.shortTerm.events).toHaveLength(1);
    expect(observed.memory.shortTerm.reports).toHaveLength(1);
    expect(observed.memory.shortTerm.summaries).toEqual([]);

    const compacted = applyTick(
      observed,
      {
        ...fullTick(),
        tick_id: 2,
        timestamp: 221,
      },
      config,
    ).state;

    expect(compacted.memory.shortTerm.events).toEqual([]);
    expect(compacted.memory.shortTerm.reports).toEqual([]);
    expect(compacted.memory.shortTerm.summaries).toEqual([
      expect.objectContaining({ kind: "event", key: "contact", count: 1 }),
      expect.objectContaining({ kind: "report", key: "alpha:contact", count: 1 }),
    ]);

    const expired = applyTick(
      compacted,
      {
        ...fullTick(),
        tick_id: 3,
        timestamp: 701,
      },
      config,
    ).state;
    expect(expired.memory.shortTerm.summaries).toEqual([]);
  });

  it("applies delta mission/removals and requests the configured periodic full snapshot", () => {
    const initial = applyTick(
      initialCommanderState(),
      {
        ...fullTick(),
        snapshot: {
          ...fullTick().snapshot,
          objectives: [
            ...fullTick().snapshot.objectives,
            {
              id: "remove",
              name: "Remove",
              position: [0, 0, 0],
              status: "neutral",
              capture_progress: 0,
            },
          ],
        },
      },
      config,
    ).state;
    const second: TickRequest = {
      ...fullTick(),
      type: "delta",
      tick_id: 2,
      timestamp: 101,
      full_snapshot_interval: 2,
      since_tick: 1,
      changes: {
        mission: { ...fullTick().snapshot.mission, time_elapsed_seconds: 101 },
        objectives_removed: ["remove"],
        groups_upserted: [],
        groups_moved: [],
        groups_destroyed: [],
        objectives_upserted: [],
        known_enemies_upserted: [],
        known_enemies_expired: [],
      },
    };
    const applied = applyTick(initial, second, config);
    expect(applied.requestFullSnapshot).toBe(false);
    expect(applied.state.snapshot?.mission.time_elapsed_seconds).toBe(101);
    expect(applied.state.snapshot?.objectives.some((item) => item.id === "remove")).toBe(false);

    const third = applyTick(applied.state, { ...second, tick_id: 3, since_tick: 2 }, config);
    expect(third.accepted).toBe(true);
    expect(third.requestFullSnapshot).toBe(true);
  });

  it("returns the persisted response for an exact retried tick", () => {
    const response = {
      protocol_version: 1 as const,
      tick_id: 1,
      commands: [
        {
          command_id: "cmd_1",
          type: "move_group" as const,
          params: { group_id: "group", destination: [1, 0, 1] as const },
        },
      ],
      tick_rate_hint: 750,
      request_full_snapshot: false,
      config_updates: {},
      commander_status: {
        connected: true,
        mode: "rule" as const,
        doctrine: "balanced",
        decision_pending: false,
        active_groups: 1,
      },
    };
    const state = {
      ...applyTick(initialCommanderState(), fullTick(), config).state,
      lastTickResponse: response,
    };

    expect(cachedTickResponse(state, fullTick())).toEqual(response);
    expect(cachedTickResponse(state, { ...fullTick(), tick_id: 2 })).toBeUndefined();
  });

  it("keeps the validated connect doctrine across later ticks", () => {
    const connected = withConnect(
      initialCommanderState(),
      {
        sessionId: "session",
        faction: "OPFOR",
        missionEpoch: 1,
        doctrine: "aggressive",
      },
      config,
    );

    expect(applyTick(connected, fullTick(), config).state.doctrine).toBe("aggressive");
  });

  it("clears a prior mission's map briefing when connecting to a new mission", () => {
    const previous = {
      ...withConnect(
        initialCommanderState(),
        {
          sessionId: "session",
          faction: "OPFOR",
          missionEpoch: 1,
        },
        config,
      ),
      mapBriefing: {
        map_name: "Everon",
        grid_size: 1,
        grid_width: 1,
        grid_height: 1,
        grid_resolution_meters: 10,
        source: "arma_extracted" as const,
        classification_version: 1,
        content_hash: "stavka-map-v1-mission-reset",
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
      },
    };

    const next = withConnect(
      previous,
      {
        sessionId: "session",
        faction: "OPFOR",
        missionEpoch: 2,
      },
      config,
    );

    expect(next.mapBriefing).toBeUndefined();
    expect(next.snapshot).toBeUndefined();
  });

  it("preserves resource reservations and unacknowledged commands across unchanged snapshots", () => {
    const spawn = {
      command_id: "spawn_1",
      type: "spawn_group" as const,
      params: { template: "infantry_squad", position: [100, 0, 100] as const },
    };
    const firstRequest = fullTick();
    const first = applyTick(
      initialCommanderState(),
      {
        ...firstRequest,
        snapshot: {
          ...firstRequest.snapshot,
          resources: { ...firstRequest.snapshot.resources, manpower: 6 },
        },
      },
      config,
    ).state;
    const reserved = {
      ...first,
      pendingCommands: [spawn],
      budget: { ...first.budget, manpower: 0 },
    };
    const second = applyTick(
      reserved,
      {
        ...firstRequest,
        tick_id: 2,
        timestamp: 101,
        snapshot: {
          ...firstRequest.snapshot,
          resources: { ...firstRequest.snapshot.resources, manpower: 6 },
        },
      },
      config,
    ).state;

    expect(second.budget.manpower).toBe(0);
    expect(second.pendingCommands).toEqual([spawn]);

    const acknowledged = applyTick(
      second,
      {
        ...firstRequest,
        tick_id: 3,
        timestamp: 102,
        command_results: [{ command_id: "spawn_1", status: "completed" }],
        snapshot: {
          ...firstRequest.snapshot,
          resources: { ...firstRequest.snapshot.resources, manpower: 6 },
        },
      },
      config,
    ).state;
    expect(acknowledged.pendingCommands).toEqual([]);
  });

  it("re-delivers accepted commands until one terminal result and ignores duplicate terminals", () => {
    const request = fullTick();
    const spawn = {
      command_id: "spawn-ledger",
      type: "spawn_group" as const,
      params: { template: "infantry_squad", position: [100, 0, 100] as const },
    };
    const initial = applyTick(
      initialCommanderState(),
      {
        ...request,
        snapshot: {
          ...request.snapshot,
          resources: { ...request.snapshot.resources, manpower: 6 },
        },
      },
      config,
    ).state;
    const issued = {
      ...initial,
      pendingCommands: [spawn],
      budget: { ...initial.budget, manpower: 0 },
    };
    const accepted = applyTick(
      issued,
      {
        ...request,
        tick_id: 2,
        command_results: [{ command_id: spawn.command_id, status: "accepted" }],
      },
      config,
    ).state;
    expect(accepted.pendingCommands).toEqual([spawn]);

    const completed = applyTick(
      accepted,
      {
        ...request,
        tick_id: 3,
        command_results: [{ command_id: spawn.command_id, status: "completed" }],
      },
      config,
    ).state;
    expect(completed.pendingCommands).toEqual([]);

    const duplicate = applyTick(
      completed,
      {
        ...request,
        tick_id: 4,
        command_results: [{ command_id: spawn.command_id, status: "completed" }],
      },
      config,
    ).state;
    expect(duplicate.pendingCommands).toEqual([]);
    expect(duplicate.budget.manpower).toBe(completed.budget.manpower);
  });

  it("scales active groups below the configured hard cap and never above fifty", () => {
    const low = applyTick(initialCommanderState(), fullTick(), config).state;
    expect(low.budget.maxActiveUnits).toBe(16);
    const request = fullTick();
    const high = applyTick(
      initialCommanderState(),
      {
        ...request,
        snapshot: {
          ...request.snapshot,
          mission: {
            ...request.snapshot.mission,
            player_count: { friendly: 10, enemy: 10 },
          },
        },
      },
      { ...config, maxActiveUnits: 100 },
    ).state;
    expect(high.budget.maxActiveUnits).toBe(50);
  });

  it("coalesces durable decision requests and clears a failed single-flight", () => {
    const scheduled = requestCommanderDecision(initialCommanderState(), "scheduled_tick");
    const urgent = requestCommanderDecision(scheduled, "event:contact");
    const lowerPriority = requestCommanderDecision(urgent, "scheduled_alarm");

    expect(lowerPriority).toMatchObject({
      decisionPending: true,
      pendingDecisionTrigger: "event:contact",
    });
    expect(recoverPendingDecision(lowerPriority)).toMatchObject({
      decisionPending: false,
      mode: "degraded",
    });
    expect(recoverPendingDecision(lowerPriority)).not.toHaveProperty("pendingDecisionTrigger");
  });
});
