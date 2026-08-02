import type { GameSnapshot, SergeantReport } from "@stavka/protocol";
import { Effect } from "effect";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Env } from "../src/config";

const mocks = vi.hoisted(() => ({
  startFiber: vi.fn<(
    name: string,
    work: (fiber: { stash: (snapshot: unknown) => void }) => Promise<void>,
    options: unknown,
  ) => Promise<{ status: string }>>(),
}));

vi.mock("agents", () => ({
  Agent: class {
    state: unknown;
    env: unknown;
    name = "alpha";

    setState(state: unknown): void {
      this.state = state;
    }

    startFiber(
      name: string,
      work: (fiber: { stash: (snapshot: unknown) => void }) => Promise<void>,
      options: unknown,
    ): Promise<{ status: string }> {
      return mocks.startFiber(name, work, options);
    }
  },
}));

vi.mock("../src/logging/decision-log-repository", () => ({
  SqlDecisionLogRepository: class {
    initialize = Effect.void;
    save = () => Effect.void;
  },
}));

const { SergeantAgent } = await import("../src/durable/sergeant");

type SergeantInstance = InstanceType<typeof SergeantAgent>;
type TestAgent = SergeantInstance & {
  state: SergeantInstance["initialState"];
  env: Env;
};

const snapshot: GameSnapshot = {
  mission: {
    id: "mission",
    epoch: 1,
    name: "Test",
    map: "Everon",
    time_elapsed_seconds: 100,
    player_count: { friendly: 1, enemy: 1 },
  },
  objectives: [],
  friendly_groups: [{
    id: "alpha",
    faction: "OPFOR",
    template: "infantry",
    position: [100, 0, 100],
    strength: { current: 8, max: 8 },
    behavior: "hold",
    status: "engaged",
  }],
  known_enemies: [],
  resources: {
    manpower: 100,
    vehicle_pool: 2,
    reinforcement_cooldown_seconds: 0,
    max_active_units: 20,
  },
};

const report: SergeantReport = {
  type: "sergeant_report",
  timestamp: 100,
  payload: {
    group_id: "alpha",
    report_type: "contact",
    position: [100, 0, 100],
    strength: { current: 8, max: 8 },
    status: "engaged",
    contacts: [{ type: "infantry", estimated_count: 4, bearing: 90, distance: 50 }],
    ammo_status: "adequate",
    morale: "steady",
    local_decision: "Holding contact",
  },
};

const createAgent = (): TestAgent => {
  const Constructor = SergeantAgent as unknown as new () => TestAgent;
  const agent = new Constructor();
  agent.state = structuredClone(agent.initialState);
  agent.env = {
    ORCHESTRATOR: {},
    TERRAIN_CACHE: {},
    API_KEY: "machine",
    STAVKA_AI_PROVIDER: "mock",
  } as unknown as Env;
  return agent;
};

const reportAt = (timestamp: number): SergeantReport => ({
  ...report,
  timestamp,
  payload: {
    ...report.payload,
    local_decision: `Holding contact at ${timestamp}`,
  },
});

describe("deferred sergeant assessments", () => {
  beforeEach(() => {
    mocks.startFiber.mockReset().mockResolvedValue({ status: "running" });
  });

  it("durably accepts provider work and exposes it only after its child fiber", async () => {
    const agent = createAgent();

    await agent.queueAssessment(report, snapshot, []);

    expect(mocks.startFiber).toHaveBeenCalledWith(
      "sergeant-assessment",
      expect.any(Function),
      expect.objectContaining({ idempotencyKey: "sergeant:alpha:1:1" }),
    );
    expect(await agent.listCompletedAssessments()).toEqual([]);

    const fiber = mocks.startFiber.mock.calls[0]?.[1];
    if (fiber === undefined) throw new Error("Expected the assessment fiber");
    await fiber({ stash: () => undefined });
    const completed = await agent.listCompletedAssessments();
    expect(completed).toHaveLength(1);
    expect(completed[0]?.commands[0]?.type).toBe("attack_group");
    expect(agent.state.pendingWorkQueue).toMatchObject([
      { completedAssessment: { log: { id: completed[0]?.log.id } } },
    ]);
    expect(await agent.listCompletedAssessments()).toHaveLength(1);
    await agent.acknowledgeAssessments(completed.map((assessment) => assessment.log.id));
    expect(await agent.listCompletedAssessments()).toEqual([]);
    expect(agent.state.pendingWorkQueue).toEqual([]);
  });

  it("retains every assessment in a burst and acknowledges only named results", async () => {
    const agent = createAgent();

    await Promise.all([
      agent.queueAssessment(reportAt(101), snapshot, []),
      agent.queueAssessment(reportAt(102), snapshot, []),
      agent.queueAssessment(reportAt(103), snapshot, []),
    ]);

    expect(mocks.startFiber).toHaveBeenCalledTimes(3);
    expect(await agent.listCompletedAssessments()).toEqual([]);

    const first = mocks.startFiber.mock.calls[0]?.[1];
    const second = mocks.startFiber.mock.calls[1]?.[1];
    const third = mocks.startFiber.mock.calls[2]?.[1];
    if (first === undefined || second === undefined || third === undefined) {
      throw new Error("Expected all assessment fibers");
    }
    await second({ stash: () => undefined });
    await first({ stash: () => undefined });
    await third({ stash: () => undefined });

    const completed = await agent.listCompletedAssessments();
    const ids = completed.map((assessment) => assessment.log.id);
    expect(completed).toHaveLength(3);
    expect(new Set(ids).size).toBe(3);
    expect(completed.map((assessment) => assessment.timestamp)).toEqual([102, 101, 103]);
    expect(agent.state.pendingWorkQueue).toHaveLength(3);
    expect(agent.state.pendingWorkQueue.every((work) => work.completedAssessment !== undefined)).toBe(
      true,
    );

    await agent.acknowledgeAssessments(ids.slice(1, 2));
    const retained = await agent.listCompletedAssessments();
    expect(retained.map((assessment) => assessment.log.id)).toEqual([ids[0], ids[2]]);

    await agent.acknowledgeAssessments(["unknown-assessment"]);
    expect(await agent.listCompletedAssessments()).toEqual(retained);
    await agent.acknowledgeAssessments(
      retained.map((assessment) => assessment.log.id),
    );
    expect(await agent.listCompletedAssessments()).toEqual([]);
  });
});
