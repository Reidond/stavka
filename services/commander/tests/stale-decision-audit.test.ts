import type { GameSnapshot } from "@stavka/protocol";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Env } from "../src/config";
import type { PlannedDecision } from "../src/brain/planner";
import {
  initialCommanderState,
  type CommanderSessionState,
  type SeatRegistration,
} from "../src/state/types";

const mocks = vi.hoisted(() => ({
  mutateDuringPlan: undefined as undefined | (() => void),
  plannedDecision: undefined as unknown,
  waitDuringPlan: undefined as undefined | (() => Promise<void>),
  planCalls: vi.fn(),
  scheduled: vi.fn(async (..._args: unknown[]) => undefined),
  sqlCalls: [] as unknown[][],
}));

vi.mock("agents", () => ({
  getAgentByName: async (namespace: { getByName: (name: string) => unknown }, name: string) =>
    namespace.getByName(name),
  Agent: class {
    state: unknown;
    env: unknown;
    name = "stale-audit-session";

    setState(state: unknown): void {
      this.state = state;
    }

    schedule(...args: unknown[]): Promise<void> {
      return mocks.scheduled(...args);
    }

    sql(_strings: TemplateStringsArray, ...values: unknown[]): unknown[] {
      mocks.sqlCalls.push(values);
      return [];
    }
  },
}));

vi.mock("../src/brain/planner", async (importOriginal) => {
  const { Effect } = await import("effect");
  const original = await importOriginal<typeof import("../src/brain/planner")>();
  return {
    ...original,
    planDecision: () =>
      Effect.gen(function* () {
        mocks.planCalls();
        mocks.mutateDuringPlan?.();
        if (mocks.waitDuringPlan) yield* Effect.promise(mocks.waitDuringPlan);
        return mocks.plannedDecision;
      }),
  };
});

const { OrchestratorAgent } = await import("../src/durable/orchestrator");

const snapshot: GameSnapshot = {
  mission: {
    id: "mission",
    epoch: 1,
    name: "Stale audit",
    map: "Everon",
    time_elapsed_seconds: 100,
    player_count: { friendly: 1, enemy: 1 },
  },
  objectives: [],
  friendly_groups: [],
  known_enemies: [],
  resources: {
    manpower: 100,
    vehicle_pool: 2,
    reinforcement_cooldown_seconds: 0,
    max_active_units: 20,
  },
};

const seat: SeatRegistration = {
  id: "seat-a",
  name: "Seat A",
  mode: "contributor",
  provider: "codex",
  models: ["stavka/commander"],
  monthlyBudgetUsd: 1,
  priority: 1,
  healthy: true,
  exhausted: false,
  registeredAt: "2026-08-02T00:00:00.000Z",
  spentUsd: 0,
  reservedUsd: 0,
  budgetPeriod: "2026-08",
};

const plannedDecision: PlannedDecision = {
  summary: "A stale provider decision",
  commands: [],
  prompt: "stale audit prompt",
  rawResponse: '{"summary":"A stale provider decision","commands":[]}',
  model: "final-seat-model",
  mode: "llm",
  latencyMs: 123,
  manpowerSpent: 0,
  vehiclesReserved: 0,
  commandSequenceAdvance: 0,
  tokenUsage: { input: 5, output: 3 },
  costUsd: 0.02,
  seatId: "seat-a",
  costAttributions: [
    {
      model: "failed-seat-model",
      tokenUsage: { input: 7, output: 2 },
      costUsd: 0.01,
      seatId: "seat-a",
    },
    {
      model: "final-seat-model",
      tokenUsage: { input: 5, output: 3 },
      costUsd: 0.02,
      seatId: "seat-a",
    },
  ],
  fallback: false,
  stretched: false,
};

const createAgent = () => {
  type TestAgent = InstanceType<typeof OrchestratorAgent> & {
    state: CommanderSessionState;
    env: Env;
  };
  const Constructor = OrchestratorAgent as unknown as new () => TestAgent;
  const agent = new Constructor();
  agent.state = {
    ...initialCommanderState(),
    connected: true,
    sessionId: "session",
    faction: "OPFOR",
    missionEpoch: 1,
    snapshot,
    lastTickId: 1,
    decisionPending: true,
    pendingDecisionVersion: 4,
    pendingDecisionTrigger: "scheduled_tick",
    seats: [seat],
  };
  const refreshSeats = vi
    .fn()
    .mockResolvedValueOnce([seat])
    .mockResolvedValue([{ ...seat, spentUsd: 0.03 }]);
  agent.env = {
    ORCHESTRATOR: { getByName: () => ({ refreshSeats }) },
    TERRAIN_CACHE: {},
    API_KEY: "machine",
    STAVKA_AI_PROVIDER: "mock",
  } as unknown as Env;
  return { agent, refreshSeats };
};

describe("stale commander decision accounting", () => {
  beforeEach(() => {
    mocks.scheduled.mockClear();
    mocks.sqlCalls.length = 0;
    mocks.planCalls.mockClear();
    mocks.waitDuringPlan = undefined;
    mocks.mutateDuringPlan = undefined;
    mocks.plannedDecision = plannedDecision;
  });

  it("accepts useful model work across ticks but revalidates ownership, resources and IDs", async () => {
    const { agent } = createAgent();
    const alpha = {
      id: "alpha",
      faction: "OPFOR",
      template: "infantry_squad",
      position: [100, 0, 100],
      strength: { current: 6, max: 6 },
      behavior: "hold",
      status: "idle",
    } as const;
    agent.state = {
      ...agent.state,
      snapshot: { ...snapshot, friendly_groups: [alpha, { ...alpha, id: "lost" }] },
    };
    const planningSnapshot = agent.state.snapshot;
    mocks.plannedDecision = {
      ...plannedDecision,
      summary: "Advance alpha and reinforce",
      commands: [
        {
          command_id: "cmd_00000001",
          type: "move_group",
          params: { group_id: "alpha", destination: [200, 0, 200] },
        },
        { command_id: "cmd_00000002", type: "despawn_group", params: { group_id: "lost" } },
        {
          command_id: "cmd_00000003",
          type: "spawn_group",
          params: { template: "infantry_squad", position: [100, 0, 100] },
        },
      ],
      commandSequenceAdvance: 3,
      manpowerSpent: 6,
    } satisfies PlannedDecision;
    mocks.mutateDuringPlan = () =>
      agent.setState({
        ...agent.state,
        lastTickId: 20,
        nextCommandSequence: 40,
        snapshot: {
          ...snapshot,
          mission: { ...snapshot.mission, time_elapsed_seconds: 130 },
          friendly_groups: [alpha],
        },
        budget: { ...agent.state.budget, manpower: 0 },
        pendingCommands: [
          {
            command_id: "existing",
            type: "defend_group",
            params: { group_id: "alpha", position: [100, 0, 100] },
          },
        ],
      });
    await agent.runScheduledDecision({ kind: "commander", version: 4 });
    expect(agent.state.lastTickId).toBe(20);
    expect(agent.state.lastDecisionAt).toBe(130);
    expect(agent.state.decisionPending).toBe(false);
    expect(agent.state.pendingCommands.map((c) => c.command_id)).toEqual([
      "existing",
      "cmd_00000040",
    ]);
    expect(agent.state.pendingCommands[1]).toMatchObject({
      type: "move_group",
      params: { group_id: "alpha" },
    });
    expect(agent.state.budget.manpower).toBe(0);
    expect(agent.state.nextCommandSequence).toBe(43);
    expect(agent.state.seats[0]?.spentUsd).toBe(0.03);
    expect(agent.state.costAggregates.reduce((total, item) => total + item.cost_usd, 0)).toBe(0.03);
    expect(agent.state.recentLogs[0]?.input.stateSnapshot).toEqual(planningSnapshot);
    expect(agent.state.recentLogs[0]?.output.summary).toContain(
      "cmd_00000041: group is not an existing owned group; cmd_00000042: insufficient manpower",
    );
    expect(mocks.scheduled).not.toHaveBeenCalled();
  });

  it("runs one provider attempt for overlapping callbacks of the same version", async () => {
    const { agent } = createAgent();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    mocks.waitDuringPlan = () => gate;
    const first = agent.runScheduledDecision({ kind: "commander", version: 4 });
    await vi.waitFor(() => expect(mocks.planCalls).toHaveBeenCalledTimes(1));
    await agent.runScheduledDecision({ kind: "commander", version: 4 });
    release();
    await first;
    expect(mocks.planCalls).toHaveBeenCalledTimes(1);
    expect(agent.state.recentLogs).toHaveLength(1);
    expect(agent.state.costAggregates.map((item) => item.calls)).toEqual([1, 1]);
    expect(agent.state.decisionPending).toBe(false);
  });

  it.each(["disconnect", "epoch", "faction"] as const)(
    "fences a result after %s without overwriting replacement state",
    async (change) => {
      const { agent } = createAgent();
      mocks.mutateDuringPlan = () =>
        agent.setState({
          ...agent.state,
          ...(change === "disconnect"
            ? { connected: false }
            : change === "epoch"
              ? { missionEpoch: 2 }
              : { faction: "BLUFOR" }),
        });
      await agent.runScheduledDecision({ kind: "commander", version: 4 });
      expect(agent.state.pendingCommands).toEqual([]);
      expect(agent.state.pendingDecisionVersion).toBe(4);
      expect(mocks.scheduled).not.toHaveBeenCalled();
      expect(mocks.sqlCalls).toHaveLength(1);
      expect(JSON.parse(mocks.sqlCalls[0]?.at(-1) as string)).toMatchObject({
        trigger: "scheduled_tick:stale_discarded",
        commandsIssued: [],
      });
      if (change !== "disconnect") expect(agent.state.costAggregates).toEqual([]);
    },
  );
  it("audits spent provider work without issuing stale commands or double-charging the registry mirror", async () => {
    mocks.scheduled.mockClear();
    mocks.sqlCalls.length = 0;
    mocks.plannedDecision = plannedDecision;

    type Instance = InstanceType<typeof OrchestratorAgent>;
    type TestAgent = Instance & {
      state: CommanderSessionState;
      env: Env;
    };
    const Constructor = OrchestratorAgent as unknown as new () => TestAgent;
    const agent = new Constructor();
    agent.state = {
      ...initialCommanderState(),
      connected: true,
      sessionId: "session",
      faction: "OPFOR",
      missionEpoch: 1,
      snapshot,
      lastTickId: 1,
      decisionPending: true,
      pendingDecisionVersion: 4,
      pendingDecisionTrigger: "scheduled_tick",
      seats: [seat],
    };
    const refreshSeats = vi
      .fn()
      .mockResolvedValueOnce([seat])
      .mockResolvedValueOnce([{ ...seat, spentUsd: 0.03 }]);
    agent.env = {
      ORCHESTRATOR: {
        getByName: () => ({ refreshSeats }),
      },
      TERRAIN_CACHE: {},
      API_KEY: "machine",
      STAVKA_AI_PROVIDER: "mock",
    } as unknown as Env;
    mocks.mutateDuringPlan = () => {
      agent.setState({
        ...agent.state,
        lastTickId: 2,
        pendingDecisionVersion: 5,
        pendingDecisionTrigger: "event:casualty",
      });
    };

    await agent.runScheduledDecision({ kind: "commander", version: 4 });

    expect(agent.state.pendingCommands).toEqual([]);
    expect(agent.state.pendingDecisionVersion).toBe(5);
    expect(agent.state.seats).toEqual([{ ...seat, spentUsd: 0.03 }]);
    expect(agent.state.costAggregates).toEqual([
      {
        agent_tier: "commander",
        model: "failed-seat-model",
        calls: 1,
        input_tokens: 7,
        output_tokens: 2,
        cost_usd: 0.01,
      },
      {
        agent_tier: "commander",
        model: "final-seat-model",
        calls: 1,
        input_tokens: 5,
        output_tokens: 3,
        cost_usd: 0.02,
      },
    ]);
    expect(agent.state.recentLogs).toMatchObject([
      {
        id: "audit_stale_000001_v4",
        trigger: "scheduled_tick:stale_discarded",
        output: { parsedCommands: [] },
        model: "final-seat-model",
        latencyMs: 123,
        tokenUsage: { input: 12, output: 5 },
        costUsd: 0.03,
      },
    ]);
    expect(mocks.sqlCalls).toHaveLength(1);
    expect(JSON.parse(mocks.sqlCalls[0]?.at(-1) as string)).toMatchObject({
      id: "audit_stale_000001_v4",
      commandsIssued: [],
      output: { parsedCommands: [] },
      costUsd: 0.03,
    });
    expect(agent.state.pendingDecisionTrigger).toBe("event:casualty");
    expect(mocks.scheduled).not.toHaveBeenCalled();
  });
});
