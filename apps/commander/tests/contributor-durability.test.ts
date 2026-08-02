import { describe, expect, it, vi } from "vitest";

import type { Env } from "../src/config";
import { initialCommanderState, type SeatRegistration } from "../src/state/types";

vi.mock("agents", () => ({
  Agent: class {
    state: unknown;
    env: unknown;
    name = "__seat-registry__";
    connections: unknown[] = [];

    setState(state: unknown): void {
      this.state = state;
    }

    getConnections(): Iterable<unknown> {
      return this.connections;
    }

    keepAlive(): Promise<() => void> {
      return Promise.resolve(() => undefined);
    }
  },
}));

const { OrchestratorAgent } = await import("../src/durable/orchestrator");

const contributor: SeatRegistration = {
  id: "contributor",
  name: "Contributor",
  mode: "contributor",
  provider: "codex",
  models: ["stavka/commander"],
  monthlyBudgetUsd: 1,
  priority: 10,
  healthy: true,
  exhausted: false,
  registeredAt: "2026-08-02T00:00:00.000Z",
  spentUsd: 0,
  reservedUsd: 0,
  budgetPeriod: "2026-08",
  healthExpiresAt: Date.now() / 1_000 + 60,
  activeConnectionId: "connection",
};

const makeAgent = () => {
  type Instance = InstanceType<typeof OrchestratorAgent>;
  type TestAgent = Instance & {
    state: Instance["initialState"];
    env: Env;
    connections: unknown[];
  };
  const Constructor = OrchestratorAgent as unknown as new () => TestAgent;
  const sent: string[] = [];
  const connection = {
    id: "connection",
    state: {
      channel: "seat" as const,
      authorizedSeatId: "contributor",
      seatId: "contributor",
    },
    setState(state: unknown): void {
      this.state = state as typeof this.state;
    },
    send(message: string): void {
      sent.push(message);
    },
    close: vi.fn(),
  };
  const agent = new Constructor();
  agent.state = { ...initialCommanderState(), seats: [contributor] };
  agent.env = {
    ORCHESTRATOR: {} as Env["ORCHESTRATOR"],
    TERRAIN_CACHE: {} as Env["TERRAIN_CACHE"],
    API_KEY: "machine",
  };
  agent.connections = [connection];
  return { agent, connection, sent };
};

describe("durable contributor jobs", () => {
  it("reissues one deterministic pending job after restart and rejects payload collisions", async () => {
    const first = makeAgent();
    void first.agent.invokeContributor(
      "contributor",
      "stavka/commander",
      "original prompt",
      1,
      "stable-decision",
    ).catch(() => undefined);
    await vi.waitFor(() => {
      expect(first.sent.some((message) => JSON.parse(message).type === "invoke")).toBe(true);
    });

    const replacement = makeAgent();
    replacement.agent.state = structuredClone(first.agent.state);
    await expect(replacement.agent.invokeContributor(
      "contributor",
      "stavka/commander",
      "changed prompt must not reuse the accepted job",
      1,
      "stable-decision",
    )).rejects.toMatchObject({ code: "CONTRIBUTOR_JOB_MISMATCH" });
    const resumed = replacement.agent.invokeContributor(
      "contributor",
      "stavka/commander",
      "original prompt",
      1,
      "stable-decision",
    );
    await vi.waitFor(() => {
      expect(replacement.sent.some((message) => JSON.parse(message).type === "invoke")).toBe(true);
    });
    const invoke = replacement.sent
      .map((message) => JSON.parse(message))
      .find((message) => message.type === "invoke");
    expect(invoke).toMatchObject({
      invocation: { prompt: "original prompt" },
    });
    expect(invoke?.job_id).toMatch(/^job_contributor_stable-decision_/);

    await replacement.agent.onMessage(replacement.connection as never, JSON.stringify({
      protocol_version: 1,
      type: "result",
      job_id: invoke?.job_id,
      seat_id: "contributor",
      ok: true,
      decision: { summary: "Recovered", commands: [] },
      usage: { input_tokens: 10, output_tokens: 5, estimated_cost_usd: 0.01 },
    }));
    await expect(resumed).resolves.toMatchObject({
      decision: { summary: "Recovered" },
      costUsd: 0.01,
    });

    const sendsBeforeCacheRead = replacement.sent.length;
    await expect(replacement.agent.invokeContributor(
      "contributor",
      "stavka/commander",
      "original prompt",
      1,
      "stable-decision",
    )).resolves.toMatchObject({ decision: { summary: "Recovered" } });
    expect(replacement.sent).toHaveLength(sendsBeforeCacheRead);
  });

  it("does not oversubscribe two competing reservations", async () => {
    const { agent } = makeAgent();
    const [first, second] = await Promise.all([
      agent.reserveSeatBudget("contributor", 0.6, "faction-a"),
      agent.reserveSeatBudget("contributor", 0.6, "faction-b"),
    ]);

    expect([first.accepted, second.accepted].filter(Boolean)).toHaveLength(1);
    expect(agent.state.seats[0]?.reservedUsd).toBe(0.6);
  });

  it("persists the job-to-lease identity before contributor work starts", async () => {
    const { agent, connection, sent } = makeAgent();
    await agent.reserveSeatBudget("contributor", 0.05, "lease-bound-job");
    const invocation = agent.invokeContributor(
      "contributor",
      "stavka/commander",
      "lease-bound prompt",
      30,
      "lease-bound",
      "lease-bound-job",
    );
    await vi.waitFor(() => {
      expect(sent.some((message) => JSON.parse(message).type === "invoke")).toBe(true);
    });

    const job = agent.state.contributorJobLedger[0];
    expect(job).toMatchObject({ leaseId: "lease-bound-job", status: "pending" });
    expect(agent.state.seatBudgetReservations).toEqual([
      expect.objectContaining({ id: "lease-bound-job", jobId: job?.id }),
    ]);

    const invoke = sent.map((message) => JSON.parse(message)).find((message) => message.type === "invoke");
    await agent.onMessage(connection as never, JSON.stringify({
      protocol_version: 1,
      type: "result",
      job_id: invoke?.job_id,
      seat_id: "contributor",
      ok: false,
      code: "TEST_COMPLETE",
      message: "Test cleanup",
      retryable: false,
    }));
    await expect(invocation).rejects.toMatchObject({ code: "TEST_COMPLETE" });
  });

  it("reclaims an abandoned reservation before admitting later work", async () => {
    const { agent } = makeAgent();
    agent.state = {
      ...agent.state,
      seats: [{ ...contributor, reservedUsd: 0.6 }],
      seatBudgetReservations: [{
        id: "abandoned",
        seatId: "contributor",
        amountUsd: 0.6,
        actualCostUsd: 0,
        period: "2026-08",
        status: "reserved",
        updatedAt: Date.now() / 1_000 - 301,
      }],
    };

    const reservation = await agent.reserveSeatBudget("contributor", 0.6, "replacement");

    expect(reservation.accepted).toBe(true);
    expect(agent.state.seats[0]?.reservedUsd).toBe(0.6);
    expect(agent.state.seatBudgetReservations).toEqual([
      expect.objectContaining({ id: "replacement", status: "reserved" }),
    ]);
  });

  it("rejects and bills a late result exactly once after a terminal timeout", async () => {
    const { agent, connection, sent } = makeAgent();
    const invocation = agent.invokeContributor(
      "contributor",
      "stavka/commander",
      "late usage",
      30,
      "late-result",
    );
    await vi.waitFor(() => {
      expect(sent.some((message) => JSON.parse(message).type === "invoke")).toBe(true);
    });
    const invoke = sent.map((message) => JSON.parse(message)).find((message) => message.type === "invoke");
    const jobId = invoke?.job_id as string;
    agent.state = {
      ...agent.state,
      contributorJobLedger: agent.state.contributorJobLedger.map((job) => ({
        ...job,
        status: "failed" as const,
        error: "CONTRIBUTOR_TIMEOUT: timed out",
        retryable: true,
      })),
    };
    const lateResult = JSON.stringify({
      protocol_version: 1,
      type: "result",
      job_id: jobId,
      seat_id: "contributor",
      ok: true,
      decision: { summary: "Too late", commands: [] },
      usage: { input_tokens: 10, output_tokens: 5, estimated_cost_usd: 0.04 },
    });

    await agent.onMessage(connection as never, lateResult);
    await expect(invocation).rejects.toMatchObject({ code: "PERSISTED_CONTRIBUTOR_FAILURE" });
    expect(agent.state.seats[0]?.spentUsd).toBe(0.04);
    expect(agent.state.contributorJobLedger[0]).toMatchObject({
      status: "failed",
      failureCostUsd: 0.04,
      failureTokenUsage: { input: 10, output: 5 },
    });
    expect(JSON.parse(sent.at(-1) ?? "{}")).toMatchObject({
      type: "result_ack",
      accepted: false,
      duplicate: true,
    });

    await agent.onMessage(connection as never, lateResult);
    expect(agent.state.seats[0]?.spentUsd).toBe(0.04);
  });

  it("retains reported failed-provider usage for routing and budget reconciliation", async () => {
    const { agent, connection, sent } = makeAgent();
    const invocation = agent.invokeContributor(
      "contributor",
      "stavka/commander",
      "provider failed after generation",
      30,
      "measured-failure",
    );
    await vi.waitFor(() => {
      expect(sent.some((message) => JSON.parse(message).type === "invoke")).toBe(true);
    });
    const invoke = sent.map((message) => JSON.parse(message)).find((message) => message.type === "invoke");

    await agent.onMessage(connection as never, JSON.stringify({
      protocol_version: 1,
      type: "result",
      job_id: invoke?.job_id,
      seat_id: "contributor",
      ok: false,
      code: "UPSTREAM_TIMEOUT",
      message: "provider response timed out after usage",
      retryable: true,
      resolved_model: "seat-model",
      usage: { input_tokens: 11, output_tokens: 7, estimated_cost_usd: 0.03 },
    }));

    await expect(invocation).rejects.toMatchObject({
      code: "UPSTREAM_TIMEOUT",
      retryable: true,
      tokenUsage: { input: 11, output: 7 },
      costUsd: 0.03,
      resolvedModel: "seat-model",
    });
    expect(agent.state.contributorJobLedger[0]).toMatchObject({
      status: "failed",
      retryable: true,
      failureTokenUsage: { input: 11, output: 7 },
      failureCostUsd: 0.03,
      resolvedModel: "seat-model",
    });
  });

  it("does not clear a persisted exhaustion fence on a healthy heartbeat", async () => {
    const { agent, connection } = makeAgent();
    agent.state = {
      ...agent.state,
      seats: [{ ...contributor, exhausted: true, spentUsd: 0, reservedUsd: 0 }],
    };

    await agent.onMessage(connection as never, JSON.stringify({
      protocol_version: 1,
      type: "heartbeat",
      seat_id: "contributor",
      status: "healthy",
    }));

    expect(agent.state.seats[0]).toMatchObject({ healthy: true, exhausted: true });
  });
});
