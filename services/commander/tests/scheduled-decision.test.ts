import { describe, expect, it, vi } from "vitest";
import { Schema } from "effect";
import { GameSnapshot } from "@stavka/protocol";
import fixture from "../../../packages/protocol/fixtures/test-12-round-trip.json";
import { initialCommanderState, type CommanderSessionState } from "../src/state/types";

vi.mock("agents", () => ({ Agent: class {} }));
const { OrchestratorAgent } = await import("../src/durable/orchestrator");

describe("scheduled Commander decisions", () => {
  const snapshot = Schema.decodeUnknownSync(GameSnapshot)(fixture.request.snapshot);
  const makeAgent = (decisionPending: boolean, lastDecisionAt: number) => {
    const agent = Object.create(OrchestratorAgent.prototype) as InstanceType<
      typeof OrchestratorAgent
    >;
    const schedule = vi.fn(async () => undefined);
    Object.assign(agent, {
      state: {
        ...initialCommanderState(),
        connected: true,
        snapshot,
        decisionPending,
        lastDecisionAt,
      },
      schedule,
      setState(state: CommanderSessionState) {
        Object.assign(agent, { state });
      },
    });
    return { agent, schedule };
  };
  it("does not spend another model call while the simulation clock is unchanged", async () => {
    const { agent, schedule } = makeAgent(false, snapshot.mission.time_elapsed_seconds);
    await agent.scheduledDecision();
    expect(schedule).not.toHaveBeenCalled();
  });
  it("does not enqueue a second decision while the current one is pending", async () => {
    const { agent, schedule } = makeAgent(true, 0);
    await agent.scheduledDecision();
    expect(schedule).not.toHaveBeenCalled();
  });
  it("schedules once when new simulation time is available", async () => {
    const { agent, schedule } = makeAgent(false, snapshot.mission.time_elapsed_seconds - 1);
    await agent.scheduledDecision();
    expect(schedule).toHaveBeenCalledOnce();
    expect(agent.state.decisionPending).toBe(true);
  });
});
