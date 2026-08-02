import { describe, expect, it, vi } from "vitest";
import { createScenario, snapshotWorld, stepWorldMany, type SimWorldState } from "@stavka/sim-core";
import type { RestCommanderLinkOptions } from "@stavka/sim-link";
import type { Connection, ConnectionContext } from "agents";

import type { Env } from "../src/config";

const runtime = vi.hoisted(() => ({
  callableMethods: [] as string[],
  connection: undefined as { readonly?: boolean } | undefined,
  linkOptions: [] as RestCommanderLinkOptions[],
  mutateFactionWorlds: false,
  restoredSessionIds: [] as string[],
  scheduleCalls: [] as string[],
  tickGate: undefined as Promise<void> | undefined,
  tickStarted: vi.fn(),
}));

vi.mock("agents", () => ({
  Agent: class {
    env: Env;
    initialState: unknown;
    name: string;
    state: unknown;

    constructor(context: { readonly id?: { readonly name?: string } }, env: Env) {
      this.env = env;
      this.name = context.id?.name ?? "engagement-12-balanced-x10-single";
    }

    setState(state: unknown): void {
      this.state = state;
    }

    isConnectionReadonly(connection: { readonly?: boolean }): boolean {
      return connection.readonly === true;
    }

    setConnectionReadonly(connection: { readonly?: boolean }, readonly: boolean): void {
      Object.assign(connection, { readonly });
    }

    async scheduleEvery(_seconds: number, callback: string): Promise<void> {
      runtime.scheduleCalls.push(callback);
    }
  },
  callable:
    () =>
    <This, Args extends unknown[], Return>(
      target: (this: This, ...args: Args) => Return,
      context: ClassMethodDecoratorContext,
    ) => {
      runtime.callableMethods.push(String(context.name));
      return target;
    },
  getCurrentAgent: () => ({ connection: runtime.connection }),
}));

vi.mock("@stavka/sim-link", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@stavka/sim-link")>();
  return {
    ...actual,
    RestCommanderLink: class {
      readonly tickRateHint = 1_000;
      readonly options: RestCommanderLinkOptions;
      connected = false;

      constructor(options: RestCommanderLinkOptions) {
        this.options = options;
        runtime.linkOptions.push(options);
      }

      async connect(): Promise<void> {
        this.connected = true;
      }

      async uploadMap(): Promise<void> {}

      snapshotState() {
        return { session_id: this.options.sessionId, connected: this.connected };
      }

      restoreState(snapshot: { connected?: boolean }): void {
        this.connected = snapshot.connected === true;
        runtime.restoredSessionIds.push(this.options.sessionId);
      }

      async tick(world: SimWorldState) {
        runtime.tickStarted();
        if (runtime.tickGate) await runtime.tickGate;
        if (runtime.mutateFactionWorlds) {
          const ownId = this.options.faction === "OPFOR" ? "red_1" : "blue_1";
          const enemyId = this.options.faction === "OPFOR" ? "blue_1" : "red_1";
          if (world.groups[ownId]) {
            world.groups[ownId].position =
              this.options.faction === "OPFOR" ? [111, 0, 0] : [222, 0, 0];
          }
          if (world.groups[enemyId]) world.groups[enemyId].position = [999, 0, 0];
        }
        return {
          request: {},
          response: {
            protocol_version: 1,
            tick_id: 1,
            commands: [],
            tick_rate_hint: 1_000,
            request_full_snapshot: false,
            config_updates: {},
            commander_status: {
              connected: true,
              mode: "rule",
              doctrine: "aggressive",
              decision_pending: false,
              active_groups: 1,
              cost_aggregates: [
                {
                  agent_tier: "commander",
                  model: `mock/${this.options.faction.toLowerCase()}-commander`,
                  calls: 2,
                  input_tokens: 1_200,
                  output_tokens: 300,
                  cost_usd: 0.0125,
                },
                {
                  agent_tier: "sergeant",
                  model: `mock/${this.options.faction.toLowerCase()}-sergeant`,
                  calls: 4,
                  input_tokens: 800,
                  output_tokens: 160,
                  cost_usd: 0.0025,
                },
              ],
              last_decision: {
                id: "decision-1",
                timestamp: "2026-08-02T19:00:00.000Z",
                summary: `${this.options.faction} holds its assigned ridge.`,
                model: "rule-planner",
                latency_ms: 12,
                cost_usd: 0,
              },
            },
          },
          commandResults: [],
        };
      }

      async tickIfDue(world: SimWorldState) {
        return this.tick(world);
      }

      requestFullSnapshot(): void {}
    },
  };
});

const { SimWorld } = await import("../src/sim-world");

const makeWorld = (
  overrides: Partial<Env> = {},
  name = "engagement-12-balanced-x10-single",
): InstanceType<typeof SimWorld> => {
  const world = new SimWorld({ id: { name } } as unknown as DurableObjectState, {
    SIM_WORLD: {} as Env["SIM_WORLD"],
    ...overrides,
  });
  world.setState(world.initialState);
  return world;
};

const beginBlockedStep = async (world: InstanceType<typeof SimWorld>) => {
  let release = (): void => {};
  runtime.tickGate = new Promise<void>((resolve) => {
    release = resolve;
  });
  runtime.tickStarted.mockClear();
  const pending = world.stepOnce();
  await vi.waitFor(() => expect(runtime.tickStarted).toHaveBeenCalledOnce());
  return { pending, release };
};

describe("SimWorld Agents SDK RPC boundary", () => {
  it("initializes a first spectator from the complete Agent identity before scheduling", async () => {
    runtime.scheduleCalls.length = 0;
    const world = makeWorld({}, "movement-91-defensive-x100-versus");

    await world.onStart();

    expect(world.state).toMatchObject({
      scenario: "movement",
      seed: 91,
      doctrine: "defensive",
      timeScale: 100,
      mode: "versus",
      paused: true,
    });
    expect(world.state.world).toEqual(createScenario("movement", 91));
    expect(runtime.scheduleCalls).toEqual(["advance"]);
  });

  it("preserves matching persisted progress when the Agent wakes", async () => {
    runtime.scheduleCalls.length = 0;
    const world = makeWorld();
    const advancedWorld = snapshotWorld(world.state.world);
    stepWorldMany(advancedWorld, 5);
    const persisted = {
      ...world.state,
      world: advancedWorld,
      logs: [
        ...world.state.logs,
        { id: "persisted", at: 1.5, level: "info" as const, message: "Still here." },
      ],
    };
    world.setState(persisted);

    await world.onStart();

    expect(world.state).toBe(persisted);
    expect(world.state.world.tick).toBe(advancedWorld.tick);
    expect(world.state.logs.at(-1)?.id).toBe("persisted");
    expect(runtime.scheduleCalls).toEqual(["advance"]);
  });

  it("fails closed on an invalid Agent identity before mutating state or scheduling", async () => {
    runtime.scheduleCalls.length = 0;
    const world = makeWorld({}, "engagement-12-balanced-x2-single");
    const before = world.state;

    await expect(world.onStart()).rejects.toThrow("Invalid SimWorld agent name");
    expect(world.state).toBe(before);
    expect(runtime.scheduleCalls).toEqual([]);
  });

  it("exposes only the intended browser RPC methods as callable", () => {
    expect(new Set(runtime.callableMethods)).toEqual(
      new Set([
        "configure",
        "setPaused",
        "setTimeScale",
        "stepOnce",
        "resetScenario",
        "getSnapshot",
        "getCapabilities",
      ]),
    );
    expect(runtime.callableMethods).not.toContain("advance");
  });

  it("starts connections readonly and upgrades a verified Access operator-capable user", async () => {
    const world = makeWorld({
      ENVIRONMENT: "local",
      DEV_ACCESS_EMAIL: "operator@example.test",
    });
    const connection = { readonly: true };
    const context = { request: new Request("http://127.0.0.1/agents/sim-world/demo") };

    expect(
      world.shouldConnectionBeReadonly(
        connection as unknown as Connection,
        context as ConnectionContext,
      ),
    ).toBe(true);
    await world.onConnect(connection as unknown as Connection, context as ConnectionContext);

    expect(connection.readonly).toBe(false);
  });

  it("rejects a readonly connection before a control method mutates state", () => {
    const world = makeWorld();
    const before = world.state;
    runtime.connection = { readonly: true };

    expect(() => world.configure({ scenario: "movement", seed: 9 })).toThrow(
      "Operate permission is required",
    );
    expect(world.state).toBe(before);
    expect(world.getCapabilities()).toEqual({ canOperate: false });
  });

  it("allows a writable operate/admin connection to invoke control methods", () => {
    const world = makeWorld({}, "movement-9-aggressive-x100-single");
    runtime.connection = { readonly: false };

    const configured = world.configure({
      scenario: "movement",
      seed: 9,
      doctrine: "aggressive",
      timeScale: 100,
    });

    expect(configured).toMatchObject({
      scenario: "movement",
      seed: 9,
      doctrine: "aggressive",
      timeScale: 100,
    });
    expect(world.state).toBe(configured);
    expect(world.getCapabilities()).toEqual({ canOperate: true });
  });

  it("does not let an awaited Commander tick overwrite a concurrent pause", async () => {
    runtime.connection = { readonly: false };
    const world = makeWorld({
      COMMANDER_URL: "https://commander.test",
      COMMANDER_API_KEY: "test-key",
    });
    world.setPaused(false);
    const tickBefore = world.state.world.tick;
    const { pending, release } = await beginBlockedStep(world);

    const paused = world.setPaused(true);
    release();
    const result = await pending;
    runtime.tickGate = undefined;

    expect(result).toBe(paused);
    expect(world.state).toBe(paused);
    expect(world.state.paused).toBe(true);
    expect(world.state.world.tick).toBe(tickBefore);
  });

  it("does not let an awaited Commander tick overwrite a concurrent configure", async () => {
    runtime.connection = { readonly: false };
    const world = makeWorld({
      COMMANDER_URL: "https://commander.test",
      COMMANDER_API_KEY: "test-key",
    });
    const { pending, release } = await beginBlockedStep(world);

    const configured = world.configure({
      scenario: "engagement",
      seed: 12,
      doctrine: "balanced",
      timeScale: 10,
      mode: "single",
    });
    release();
    const result = await pending;
    runtime.tickGate = undefined;

    expect(result).toBe(configured);
    expect(world.state).toBe(configured);
    expect(world.state).toMatchObject({
      scenario: "engagement",
      seed: 12,
      doctrine: "balanced",
      timeScale: 10,
      mode: "single",
    });
    expect(world.state.world).toEqual(createScenario("engagement", 12));
  });

  it("does not let an awaited Commander tick overwrite a concurrent reset", async () => {
    runtime.connection = { readonly: false };
    const world = makeWorld({
      COMMANDER_URL: "https://commander.test",
      COMMANDER_API_KEY: "test-key",
    });
    const { pending, release } = await beginBlockedStep(world);

    const reset = world.resetScenario();
    release();
    const result = await pending;
    runtime.tickGate = undefined;

    expect(result).toBe(reset);
    expect(world.state).toBe(reset);
    expect(world.state.world).toEqual(createScenario("engagement", 12));
    expect(world.state.logs.at(-1)?.message).toBe("Scenario reset.");
  });

  it("rejects unvalidated client state replacement even for a writable connection", () => {
    const world = makeWorld();

    expect(() => world.validateStateChange(world.state, {} as Connection)).toThrow(
      "Simulation state can only be changed through validated controls",
    );
    expect(() => world.validateStateChange(world.state, "server")).not.toThrow();
  });

  it("passes the selected doctrine into the commander session", async () => {
    runtime.linkOptions.length = 0;
    runtime.connection = { readonly: false };
    const world = makeWorld(
      {
        COMMANDER_URL: "https://commander.test",
        COMMANDER_API_KEY: "test-key",
      },
      "engagement-12-aggressive-x10-single",
    );
    world.configure({
      scenario: "engagement",
      seed: 12,
      doctrine: "aggressive",
    });

    await world.stepOnce();
    await world.stepOnce();

    expect(runtime.linkOptions).toHaveLength(1);
    expect(runtime.linkOptions[0]).toMatchObject({
      doctrine: "aggressive",
      faction: "OPFOR",
      sessionId: "poligon-engagement-12-opfor-aggressive-x10-single",
    });
    expect(world.state.commanders.OPFOR?.doctrine).toBe("aggressive");
    expect(world.state.decisions).toEqual([
      {
        key: '["OPFOR","decision-1"]',
        faction: "OPFOR",
        id: "decision-1",
        timestamp: "2026-08-02T19:00:00.000Z",
        summary: "OPFOR holds its assigned ridge.",
        model: "rule-planner",
        latency_ms: 12,
        cost_usd: 0,
      },
    ]);
    expect(world.state.seenDecisionKeys).toEqual(['["OPFOR","decision-1"]']);
    expect(world.state.commanders.OPFOR?.costAggregates).toEqual([
      {
        agent_tier: "commander",
        model: "mock/opfor-commander",
        calls: 2,
        input_tokens: 1_200,
        output_tokens: 300,
        cost_usd: 0.0125,
      },
      {
        agent_tier: "sergeant",
        model: "mock/opfor-sergeant",
        calls: 4,
        input_tokens: 800,
        output_tokens: 160,
        cost_usd: 0.0025,
      },
    ]);
    expect(Object.keys(world.state.linkCheckpoints)).toEqual([
      "poligon-engagement-12-opfor-aggressive-x10-single",
    ]);
  });

  it("runs isolated OPFOR and BLUFOR commander sessions against one world", async () => {
    runtime.linkOptions.length = 0;
    runtime.mutateFactionWorlds = true;
    runtime.connection = { readonly: false };
    const world = makeWorld(
      {
        COMMANDER_URL: "https://commander.test",
        COMMANDER_API_KEY: "test-key",
      },
      "engagement-12-balanced-x10-versus",
    );
    world.configure({
      scenario: "engagement",
      seed: 12,
      doctrine: "balanced",
      mode: "versus",
    });

    await world.stepOnce();
    runtime.mutateFactionWorlds = false;

    expect(runtime.linkOptions.map((options) => [options.faction, options.sessionId])).toEqual([
      ["OPFOR", "poligon-engagement-12-opfor-balanced-x10-versus"],
      ["BLUFOR", "poligon-engagement-12-blufor-balanced-x10-versus"],
    ]);
    expect(world.state.world.groups.red_1?.position).toEqual([111, 0, 0]);
    expect(world.state.world.groups.blue_1?.position).toEqual([222, 0, 0]);
    expect(Object.keys(world.state.commanders).sort()).toEqual(["BLUFOR", "OPFOR"]);
    expect(world.state.commanders.OPFOR?.costAggregates?.[0]?.model).toBe("mock/opfor-commander");
    expect(world.state.commanders.BLUFOR?.costAggregates?.[0]?.model).toBe("mock/blufor-commander");
    expect(world.state.decisions.map((decision) => decision.faction).sort()).toEqual([
      "BLUFOR",
      "OPFOR",
    ]);
    expect(Object.keys(world.state.linkCheckpoints).sort()).toEqual([
      "poligon-engagement-12-blufor-balanced-x10-versus",
      "poligon-engagement-12-opfor-balanced-x10-versus",
    ]);
  });

  it("rejects identity-changing controls on an existing named Agent", async () => {
    runtime.connection = { readonly: false };
    const world = makeWorld({
      COMMANDER_URL: "https://commander.test",
      COMMANDER_API_KEY: "test-key",
    });
    await world.stepOnce();
    expect(world.state.commanders.OPFOR?.costAggregates).toHaveLength(2);

    const before = world.state;
    expect(() => world.configure({ scenario: "movement", seed: 91 })).toThrow(
      "canonical Agent identity",
    );
    expect(() => world.setTimeScale(100)).toThrow("canonical Agent identity");
    expect(world.state).toBe(before);
    expect(world.state.commanders.OPFOR?.costAggregates).toHaveLength(2);
  });

  it("restores the persisted link checkpoint after an Agent eviction", async () => {
    runtime.restoredSessionIds.length = 0;
    runtime.connection = { readonly: false };
    const env = {
      COMMANDER_URL: "https://commander.test",
      COMMANDER_API_KEY: "test-key",
    } as const;
    const first = makeWorld(env);
    await first.stepOnce();

    const rehydrated = makeWorld(env);
    rehydrated.setState(first.state);
    await rehydrated.stepOnce();

    expect(runtime.restoredSessionIds).toContain("poligon-engagement-12-opfor-balanced-x10-single");
    expect(rehydrated.state.commanders.OPFOR?.lastTickId).toBe(1);
  });
});
