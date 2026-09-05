vi.mock("agents", () => ({
  getAgentByName: async (namespace: { getByName: (name: string) => unknown }, name: string) =>
    namespace.getByName(name),
}));
import {
  ConnectRequest as ConnectRequestSchema,
  PROTOCOL_VERSION,
  TickRequest as TickRequestSchema,
  type ConnectResponse,
  type TickRequest,
  type TickResponse,
} from "@stavka/protocol";
import { Effect, Schema } from "effect";
import { describe, expect, it, vi } from "vitest";

import {
  createWorld,
  executeCommand,
  spawnGroup,
  stepWorldMany,
  upsertObjective,
} from "../../../packages/sim-core/src/index";
import { RestCommanderLink, type TransportService } from "../../../packages/sim-link/src/index";
import { planDecision, type PlannedDecision } from "../src/brain/planner";
import { planSergeantRules } from "../src/brain/rule-commander";
import type { CommanderConfig } from "../src/config";
import { applyTick, withConnect } from "../src/state/game-state";
import { initialCommanderState, type CommanderSessionState } from "../src/state/types";

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

const sessionKey = (sessionId: string, faction: string): string => `${sessionId}\0${faction}`;

/** In-memory protocol boundary: schema-decodes requests and never opens a socket. */
class SemanticCommanderTransport implements TransportService {
  readonly #planFirstDecision: boolean;
  readonly #states = new Map<string, CommanderSessionState>();
  readonly #requests = new Map<string, TickRequest[]>();
  readonly #decisions = new Map<string, PlannedDecision[]>();

  constructor(options: { readonly planFirstDecision: boolean }) {
    this.#planFirstDecision = options.planFirstDecision;
  }

  readonly postJson: TransportService["postJson"] = (path, body) => {
    if (path === "/api/connect") {
      return Schema.decodeUnknownEffect(ConnectRequestSchema, {
        onExcessProperty: "error",
      })(body).pipe(
        Effect.map((request): ConnectResponse => {
          const key = sessionKey(request.session_id, request.faction);
          this.#states.set(
            key,
            withConnect(
              this.#states.get(key) ?? initialCommanderState(),
              {
                sessionId: request.session_id,
                faction: request.faction,
                missionEpoch: request.mission_epoch,
                ...(request.doctrine === undefined ? {} : { doctrine: request.doctrine }),
              },
              config,
            ),
          );
          return {
            protocol_version: PROTOCOL_VERSION,
            accepted: true,
            request_full_snapshot: true,
            tick_rate_hint: config.tickActiveMs,
          };
        }),
      );
    }

    if (path !== "/api/tick") {
      return Effect.fail(new Error(`Unexpected semantic replay path: ${path}`));
    }

    return Schema.decodeUnknownEffect(TickRequestSchema, {
      onExcessProperty: "error",
    })(body).pipe(
      Effect.flatMap((request) => {
        const key = sessionKey(request.session_id, request.faction);
        const current = this.#states.get(key);
        if (current === undefined) {
          return Effect.fail(new Error(`Tick arrived before connect for ${key}`));
        }
        const applied = applyTick(current, request, config);
        if (!applied.accepted) {
          return Effect.fail(new Error(`Commander rejected tick ${request.tick_id} for ${key}`));
        }
        const requests = this.#requests.get(key) ?? [];
        requests.push(request);
        this.#requests.set(key, requests);

        const previousDecisions = this.#decisions.get(key) ?? [];
        const decisionEffect: Effect.Effect<PlannedDecision | undefined> =
          this.#planFirstDecision && previousDecisions.length === 0
            ? planDecision(applied.state, config, "semantic_replay").pipe(
                Effect.map((decision): PlannedDecision | undefined => decision),
              )
            : Effect.succeed(undefined);

        return decisionEffect.pipe(
          Effect.map((decision): TickResponse => {
            if (decision !== undefined) {
              previousDecisions.push(decision);
              this.#decisions.set(key, previousDecisions);
            }
            this.#states.set(
              key,
              decision === undefined ? applied.state : { ...applied.state, mode: decision.mode },
            );
            return {
              protocol_version: PROTOCOL_VERSION,
              tick_id: request.tick_id,
              commands: decision?.commands ?? [],
              tick_rate_hint: config.tickActiveMs,
              request_full_snapshot: applied.requestFullSnapshot,
              config_updates: {},
              commander_status: {
                connected: true,
                mode: decision?.mode ?? applied.state.mode,
                doctrine: applied.state.doctrine,
                decision_pending: false,
                active_groups: applied.state.snapshot?.friendly_groups.length ?? 0,
              },
            };
          }),
        );
      }),
    );
  };

  state(sessionId: string, faction: string): CommanderSessionState {
    const key = sessionKey(sessionId, faction);
    const state = this.#states.get(key);
    if (state === undefined) throw new Error(`Missing replay state for ${key}`);
    return state;
  }

  requests(sessionId: string, faction: string): readonly TickRequest[] {
    return this.#requests.get(sessionKey(sessionId, faction)) ?? [];
  }

  decisions(sessionId: string, faction: string): readonly PlannedDecision[] {
    return this.#decisions.get(sessionKey(sessionId, faction)) ?? [];
  }
}

describe("semantic replay", () => {
  it("replays full to delta through a zero-cost rule decision, execution, and result", async () => {
    const world = createWorld({ seed: 10_001, terrainWidth: 32, terrainHeight: 32 });
    upsertObjective(world, {
      id: "obj_home",
      name: "Home",
      position: [80, 0, 80],
      status: "friendly",
      capture_progress: 0,
    });
    const transport = new SemanticCommanderTransport({ planFirstDecision: true });
    const link = new RestCommanderLink({
      endpoint: "https://unused.semantic-replay.invalid",
      apiKey: "unused",
      sessionId: "single-replay",
      missionEpoch: 7,
      faction: "OPFOR",
      doctrine: "balanced",
      fullSnapshotInterval: 30,
      detectionRangeMeters: 300,
      transport,
      now: () => world.timeMs,
    });

    await link.connect();
    const full = await link.tick(world);

    expect(full.request.type).toBe("full");
    expect(full.response.commands).toHaveLength(1);
    expect(full.response.commands[0]).toMatchObject({
      command_id: "cmd_00000001",
      type: "spawn_group",
      params: { template: "infantry_squad", position: [80, 0, 80] },
    });
    expect(full.commandResults).toEqual([{ command_id: "cmd_00000001", status: "accepted" }]);
    expect(Object.values(world.groups)).toHaveLength(1);
    expect(Object.values(world.groups)[0]).toMatchObject({ faction: "OPFOR" });

    const [decision] = transport.decisions("single-replay", "OPFOR");
    expect(decision).toMatchObject({
      mode: "rule",
      model: "mock:commander",
      latencyMs: 0,
      manpowerSpent: 6,
      vehiclesReserved: 0,
      tokenUsage: { input: 0, output: 0 },
      costUsd: 0,
      fallback: false,
      stretched: false,
    });

    spawnGroup(world, {
      id: "blufor_contact",
      faction: "BLUFOR",
      template: "infantry_squad",
      position: [120, 0, 80],
    });
    stepWorldMany(world, 10);
    const delta = await link.tick(world);

    expect(delta.request.type).toBe("delta");
    if (delta.request.type !== "delta") throw new Error("Expected a delta replay tick");
    expect(delta.request.since_tick).toBe(1);
    expect(delta.request.changes.groups_upserted).toHaveLength(1);
    expect(delta.request.changes.known_enemies_upserted).toMatchObject([
      { id: "blufor_contact", reported_by: "grp_001" },
    ]);
    expect(delta.request.command_results).toEqual(full.commandResults);
    expect(delta.response.commands).toEqual([]);
    expect(transport.requests("single-replay", "OPFOR").map((request) => request.type)).toEqual([
      "full",
      "delta",
    ]);

    const replayed = transport.state("single-replay", "OPFOR");
    expect(replayed.mode).toBe("rule");
    expect(replayed.memory.shortTerm.outcomes.map((outcome) => outcome.result)).toContainEqual({
      command_id: "cmd_00000001",
      status: "accepted",
    });

    const contact = delta.request.sergeant_reports.find(
      (report) => report.payload.report_type === "contact",
    );
    expect(contact).toBeDefined();
    if (contact === undefined) throw new Error("Expected a deterministic contact report");
    const sergeantCommands = planSergeantRules(contact, replayed.snapshot);
    expect(sergeantCommands).toMatchObject([
      {
        type: "attack_group",
        priority: "urgent",
        params: { group_id: "grp_001" },
      },
    ]);
    const sergeantCommand = sergeantCommands[0];
    if (sergeantCommand === undefined) throw new Error("Expected a Sergeant rule command");
    executeCommand(world, sergeantCommand, "OPFOR");
    expect(world.groups.grp_001?.order).toMatchObject({ kind: "attack" });
  });

  it("isolates two faction projections and Commander states in a versus session", async () => {
    const world = createWorld({ seed: 20_002, terrainWidth: 32, terrainHeight: 32 });
    spawnGroup(world, {
      id: "opfor_alpha",
      faction: "OPFOR",
      template: "infantry_squad",
      position: [80, 0, 80],
    });
    spawnGroup(world, {
      id: "blufor_alpha",
      faction: "BLUFOR",
      template: "infantry_squad",
      position: [120, 0, 80],
    });
    stepWorldMany(world, 10);
    const transport = new SemanticCommanderTransport({ planFirstDecision: false });
    const makeLink = (faction: string): RestCommanderLink =>
      new RestCommanderLink({
        endpoint: "https://unused.semantic-replay.invalid",
        apiKey: "unused",
        sessionId: "versus-replay",
        missionEpoch: 9,
        faction,
        fullSnapshotInterval: 30,
        detectionRangeMeters: 300,
        transport,
        now: () => world.timeMs,
      });
    const opfor = makeLink("OPFOR");
    const blufor = makeLink("BLUFOR");

    await opfor.connect();
    await blufor.connect();
    const opforTick = await opfor.tick(world);
    const bluforTick = await blufor.tick(world);

    expect(opforTick.request.type).toBe("full");
    expect(bluforTick.request.type).toBe("full");
    if (opforTick.request.type !== "full" || bluforTick.request.type !== "full") {
      throw new Error("Expected full versus snapshots");
    }
    expect(opforTick.request.snapshot.friendly_groups.map((group) => group.id)).toEqual([
      "opfor_alpha",
    ]);
    expect(opforTick.request.snapshot.known_enemies.map((group) => group.id)).toEqual([
      "blufor_alpha",
    ]);
    expect(bluforTick.request.snapshot.friendly_groups.map((group) => group.id)).toEqual([
      "blufor_alpha",
    ]);
    expect(bluforTick.request.snapshot.known_enemies.map((group) => group.id)).toEqual([
      "opfor_alpha",
    ]);

    const opforState = transport.state("versus-replay", "OPFOR");
    const bluforState = transport.state("versus-replay", "BLUFOR");
    expect(opforState).not.toBe(bluforState);
    expect(opforState.faction).toBe("OPFOR");
    expect(bluforState.faction).toBe("BLUFOR");
    expect(opforState.snapshot?.friendly_groups.map((group) => group.faction)).toEqual(["OPFOR"]);
    expect(bluforState.snapshot?.friendly_groups.map((group) => group.faction)).toEqual(["BLUFOR"]);
    expect(transport.decisions("versus-replay", "OPFOR")).toEqual([]);
    expect(transport.decisions("versus-replay", "BLUFOR")).toEqual([]);
  });
});
