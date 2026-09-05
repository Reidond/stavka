import type { GameSnapshot } from "@stavka/protocol";
import { describe, expect, it, vi } from "vitest";

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

vi.mock("../src/brain/planner", async () => {
  const { Effect } = await import("effect");
  return {
    planDecision: () =>
      Effect.sync(() => {
        mocks.mutateDuringPlan?.();
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

describe("stale commander decision accounting", () => {
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
      agent.setState({ ...agent.state, lastTickId: 2 });
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
    expect(mocks.scheduled).toHaveBeenCalledWith(
      0,
      "runScheduledDecision",
      { kind: "commander", version: 5 },
      expect.any(Object),
    );
  });
});
