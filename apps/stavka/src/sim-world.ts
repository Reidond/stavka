import { Effect } from "effect";
import { verifyAccessRequest } from "@stavka/access-auth";
import type { CommanderCostAggregate, CommanderDecisionSummary, GameEvent } from "@stavka/protocol";
import { createScenario, snapshotWorld, stepWorldMany, type SimWorldState } from "@stavka/sim-core";
import { RestCommanderLink, type RestCommanderLinkState } from "@stavka/sim-link";
import { Agent, callable, getCurrentAgent, type Connection, type ConnectionContext } from "agents";

import {
  connectAndBriefCommander,
  mergeFactionCommandEffects,
  runCommanderTick,
} from "./commander-bridge";
import { accessConfig, type Env } from "./config";
import {
  commanderSessionId,
  parseSimWorldAgentName,
  type ScenarioIdentity,
} from "./scenario-identity";
import {
  decodeConfigureSimWorldInput,
  decodePaused,
  decodeTimeScale,
  hasControlPermission,
  type ConfigureSimWorldInput,
  type DoctrineName,
  type ScenarioName,
  type SimulationMode,
  type TimeScale,
} from "./sim-world-contract";

const VERSUS_FACTIONS = ["OPFOR", "BLUFOR"] as const;
const MAX_DECISIONS = 200;
const MAX_DECISION_KEYS = 512;
const MAX_PENDING_EVENTS = 500;

export interface PoligonLog {
  readonly id: string;
  readonly at: number;
  readonly level: "info" | "warning" | "error";
  readonly message: string;
  readonly faction?: string;
}

export type PoligonDecision = CommanderDecisionSummary & {
  readonly key: string;
  readonly faction: string;
};

export interface PoligonCommanderState {
  readonly connected: boolean;
  readonly tickRateHint: number;
  readonly mode: "rule" | "llm" | "degraded" | "offline";
  readonly doctrine?: string;
  readonly lastTickId: number;
  readonly costAggregates?: readonly CommanderCostAggregate[];
  readonly lastError?: string;
}

export interface PoligonState {
  readonly version: 2;
  readonly scenario: ScenarioName;
  readonly seed: number;
  readonly faction: string;
  readonly doctrine: DoctrineName;
  readonly mode: SimulationMode;
  readonly paused: boolean;
  readonly timeScale: TimeScale;
  readonly world: SimWorldState;
  readonly commanders: Readonly<Record<string, PoligonCommanderState>>;
  readonly linkCheckpoints: Readonly<Record<string, RestCommanderLinkState>>;
  readonly pendingCommanderEvents: Readonly<Record<string, readonly GameEvent[]>>;
  readonly logs: readonly PoligonLog[];
  readonly decisions: readonly PoligonDecision[];
  readonly seenDecisionKeys: readonly string[];
  readonly nextLogId: number;
}

const offlineCommander = (): PoligonCommanderState => ({
  connected: false,
  tickRateHint: 1_000,
  mode: "offline",
  lastTickId: 0,
});

const makeState = (scenario: ScenarioName, seed: number): PoligonState => ({
  version: 2,
  scenario,
  seed,
  faction: "OPFOR",
  doctrine: "balanced",
  mode: "single",
  paused: true,
  timeScale: 10,
  world: createScenario(scenario, seed),
  commanders: { OPFOR: offlineCommander() },
  linkCheckpoints: {},
  pendingCommanderEvents: {},
  logs: [],
  decisions: [],
  seenDecisionKeys: [],
  nextLogId: 1,
});

const makeIdentityState = (identity: ScenarioIdentity): PoligonState => ({
  ...makeState(identity.scenario, identity.seed),
  doctrine: identity.doctrine,
  timeScale: identity.timeScale,
  mode: identity.mode,
});

const stateMatchesIdentity = (state: PoligonState, identity: ScenarioIdentity): boolean =>
  state.scenario === identity.scenario &&
  state.seed === identity.seed &&
  state.doctrine === identity.doctrine &&
  state.timeScale === identity.timeScale &&
  state.mode === identity.mode;

const decisionKey = (faction: string, id: string): string => JSON.stringify([faction, id]);

const appendDecision = (
  state: PoligonState,
  faction: string,
  decision: CommanderDecisionSummary | undefined,
): PoligonState => {
  if (!decision) return state;
  const key = decisionKey(faction, decision.id);
  if (state.seenDecisionKeys.includes(key)) return state;
  return {
    ...state,
    decisions: [...state.decisions, { ...decision, key, faction }].slice(-MAX_DECISIONS),
    seenDecisionKeys: [...state.seenDecisionKeys, key].slice(-MAX_DECISION_KEYS),
  };
};

const appendLog = (
  state: PoligonState,
  level: PoligonLog["level"],
  message: string,
  faction?: string,
): PoligonState => ({
  ...state,
  logs: [
    ...state.logs,
    {
      id: `sim_${String(state.nextLogId).padStart(6, "0")}`,
      at: state.world.timeMs / 1_000,
      level,
      message,
      ...(faction ? { faction } : {}),
    },
  ].slice(-500),
  nextLogId: state.nextLogId + 1,
});

type LegacyState = Partial<PoligonState> & {
  readonly commander?: PoligonCommanderState;
  readonly seenDecisionIds?: readonly string[];
};

const normalizeState = (state: PoligonState): PoligonState => {
  const candidate = state as unknown as LegacyState;
  if (
    candidate.version === 2 &&
    candidate.mode !== undefined &&
    candidate.commanders !== undefined &&
    candidate.linkCheckpoints !== undefined &&
    candidate.pendingCommanderEvents !== undefined &&
    candidate.decisions !== undefined &&
    candidate.seenDecisionKeys !== undefined
  ) {
    return state;
  }

  const faction = candidate.faction ?? "OPFOR";
  const decisions = (candidate.decisions ?? []).map((decision) => {
    if ("faction" in decision && "key" in decision) return decision;
    const legacy = decision as unknown as CommanderDecisionSummary;
    return { ...legacy, faction, key: decisionKey(faction, legacy.id) };
  });
  const seenDecisionKeys =
    candidate.seenDecisionKeys ??
    candidate.seenDecisionIds?.map((id) => decisionKey(faction, id)) ??
    decisions.map((decision) => decision.key);

  return {
    ...(state as unknown as Omit<PoligonState, "version">),
    version: 2,
    mode: candidate.mode ?? "single",
    commanders: candidate.commanders ?? {
      [faction]: candidate.commander ?? offlineCommander(),
    },
    linkCheckpoints: candidate.linkCheckpoints ?? {},
    pendingCommanderEvents: candidate.pendingCommanderEvents ?? {},
    decisions: decisions.slice(-MAX_DECISIONS),
    seenDecisionKeys: seenDecisionKeys.slice(-MAX_DECISION_KEYS),
  };
};

const activeFactions = (state: PoligonState): readonly string[] =>
  state.mode === "versus" ? VERSUS_FACTIONS : [state.faction];

interface CommanderLinkSession {
  readonly faction: string;
  readonly link: RestCommanderLink;
  readonly sessionId: string;
}

export class SimWorld extends Agent<Env, PoligonState> {
  override initialState = makeState("engagement", 12);
  readonly #links = new Map<string, RestCommanderLink>();
  readonly #connectedSessions = new Set<string>();

  override async onStart(): Promise<void> {
    const identity = parseSimWorldAgentName(this.name);
    const normalized = normalizeState(this.state);
    const authoritative = stateMatchesIdentity(normalized, identity)
      ? normalized
      : makeIdentityState(identity);
    if (authoritative !== this.state) this.setState(authoritative);
    await this.scheduleEvery(1, "advance");
  }

  override shouldConnectionBeReadonly(
    _connection: Connection,
    _context: ConnectionContext,
  ): boolean {
    return true;
  }

  override async onConnect(connection: Connection, { request }: ConnectionContext): Promise<void> {
    const identity = await Effect.runPromise(verifyAccessRequest(request, accessConfig(this.env)));
    this.setConnectionReadonly(connection, !hasControlPermission(identity));
  }

  override validateStateChange(_nextState: PoligonState, source: Connection | "server"): void {
    if (source !== "server") {
      throw new Error("Simulation state can only be changed through validated controls");
    }
  }

  @callable({ description: "Configure a reproducible Poligon scenario" })
  configure(input: ConfigureSimWorldInput): PoligonState {
    this.#assertControlPermission();
    const decoded = decodeConfigureSimWorldInput(input);
    const identity = parseSimWorldAgentName(this.name);
    if (
      decoded.scenario !== identity.scenario ||
      decoded.seed !== identity.seed ||
      (decoded.doctrine !== undefined && decoded.doctrine !== identity.doctrine) ||
      (decoded.timeScale !== undefined && decoded.timeScale !== identity.timeScale) ||
      (decoded.mode !== undefined && decoded.mode !== identity.mode)
    ) {
      throw new Error("Simulation selectors must match the canonical Agent identity");
    }
    const faction = decoded.faction ?? this.state.faction;
    const doctrine = identity.doctrine;
    const timeScale = identity.timeScale;
    const mode = identity.mode;
    const sessionChanged =
      decoded.scenario !== this.state.scenario ||
      decoded.seed !== this.state.seed ||
      faction !== this.state.faction ||
      doctrine !== this.state.doctrine ||
      timeScale !== this.state.timeScale ||
      mode !== this.state.mode;
    let next = sessionChanged ? makeState(decoded.scenario, decoded.seed) : this.state;
    next = { ...next, faction, doctrine, timeScale, mode };
    if (sessionChanged) {
      next = appendLog(
        next,
        "info",
        `Loaded ${decoded.scenario} seed ${decoded.seed} in ${mode} mode.`,
      );
    }
    this.#resetLinks();
    this.setState(next);
    return next;
  }

  @callable({ description: "Pause or resume the simulation" })
  setPaused(paused: boolean): PoligonState {
    this.#assertControlPermission();
    const decoded = decodePaused(paused);
    const next = appendLog(
      { ...this.state, paused: decoded },
      "info",
      decoded ? "Simulation paused." : "Simulation resumed.",
    );
    this.setState(next);
    return next;
  }

  @callable({ description: "Set the deterministic simulation time scale" })
  setTimeScale(timeScale: TimeScale): PoligonState {
    this.#assertControlPermission();
    const decoded = decodeTimeScale(timeScale);
    if (decoded !== parseSimWorldAgentName(this.name).timeScale) {
      throw new Error("Time scale must match the canonical Agent identity");
    }
    const next = appendLog(
      {
        ...this.state,
        timeScale: decoded,
        commanders: {},
        linkCheckpoints: {},
        pendingCommanderEvents: {},
      },
      "info",
      `Time scale set to ×${decoded}.`,
    );
    this.#resetLinks();
    this.setState(next);
    return next;
  }

  @callable({ description: "Advance one fixed simulation step and force commander ticks" })
  async stepOnce(): Promise<PoligonState> {
    this.#assertControlPermission();
    return this.runSteps(1, true);
  }

  @callable({ description: "Reset the current scenario to its configured seed" })
  resetScenario(): PoligonState {
    this.#assertControlPermission();
    const reset = makeState(this.state.scenario, this.state.seed);
    const next = appendLog(
      {
        ...reset,
        faction: this.state.faction,
        doctrine: this.state.doctrine,
        mode: this.state.mode,
        timeScale: this.state.timeScale,
      },
      "info",
      "Scenario reset.",
    );
    this.#resetLinks();
    this.setState(next);
    return next;
  }

  async advance(): Promise<void> {
    if (this.state.paused) return;
    await this.runSteps(10 * this.state.timeScale, false);
  }

  @callable({ description: "Read the latest authoritative simulation snapshot" })
  getSnapshot(): PoligonState {
    return this.state;
  }

  @callable({ description: "Read the current connection's simulation capabilities" })
  getCapabilities(): { readonly canOperate: boolean } {
    const { connection } = getCurrentAgent<SimWorld>();
    return {
      canOperate: connection !== undefined && !this.isConnectionReadonly(connection),
    };
  }

  private async runSteps(steps: number, forceCommanderTick: boolean): Promise<PoligonState> {
    const baseState = this.state;
    const world = snapshotWorld(baseState.world);
    stepWorldMany(world, steps);
    let next: PoligonState = { ...baseState, world };
    const entries: CommanderLinkSession[] = [];
    for (const faction of activeFactions(next)) {
      const session = await this.commanderLink(faction, baseState);
      if (
        this.#abortRunIfStale(baseState, session ? [...entries, { faction, ...session }] : entries)
      ) {
        return this.state;
      }
      if (session) entries.push({ faction, ...session });
    }
    if (entries.length === 0) {
      if (this.#abortRunIfStale(baseState, entries)) return this.state;
      this.setState(next);
      return next;
    }

    const commandBase = snapshotWorld(world);
    const newEvents = [...world.events];
    world.events = [];
    const pendingCommanderEvents: Record<string, readonly GameEvent[]> = {
      ...next.pendingCommanderEvents,
    };

    for (const { faction, link, sessionId } of entries) {
      const commandWorld = snapshotWorld(commandBase);
      commandWorld.events = [...(pendingCommanderEvents[faction] ?? []), ...newEvents].slice(
        -MAX_PENDING_EVENTS,
      );
      let tickInvoked = false;
      try {
        if (!this.#connectedSessions.has(sessionId)) {
          await connectAndBriefCommander(link, commandWorld);
          if (this.#abortRunIfStale(baseState, entries)) return this.state;
          this.#connectedSessions.add(sessionId);
          next = appendLog(
            next,
            "info",
            "Commander connected; terrain briefing uploaded.",
            faction,
          );
        }
        tickInvoked = true;
        const outcome = await runCommanderTick(link, commandWorld, forceCommanderTick);
        if (this.#abortRunIfStale(baseState, entries)) return this.state;
        if (!outcome) {
          pendingCommanderEvents[faction] = [...commandWorld.events].slice(-MAX_PENDING_EVENTS);
          const previous = next.commanders[faction] ?? offlineCommander();
          const { lastError: _lastError, ...healthy } = previous;
          next = {
            ...next,
            commanders: {
              ...next.commanders,
              [faction]: { ...healthy, connected: true, tickRateHint: link.tickRateHint },
            },
          };
          next = await this.#checkpointLink(next, sessionId, link);
          if (this.#abortRunIfStale(baseState, entries)) return this.state;
          continue;
        }

        pendingCommanderEvents[faction] = [];
        mergeFactionCommandEffects(world, commandWorld, faction, outcome);
        next = {
          ...next,
          world,
          commanders: {
            ...next.commanders,
            [faction]: {
              connected: true,
              tickRateHint: outcome.response.tick_rate_hint,
              mode: outcome.response.commander_status.mode,
              doctrine: outcome.response.commander_status.doctrine,
              lastTickId: outcome.response.tick_id,
              ...(outcome.response.commander_status.cost_aggregates === undefined
                ? {}
                : {
                    costAggregates: outcome.response.commander_status.cost_aggregates.map(
                      (aggregate) => ({ ...aggregate }),
                    ),
                  }),
            },
          },
        };
        next = appendDecision(next, faction, outcome.response.commander_status.last_decision);
        if (outcome.response.commands.length > 0) {
          next = appendLog(
            next,
            "info",
            `Processed ${outcome.response.commands.length} commander order(s).`,
            faction,
          );
        }
        next = await this.#checkpointLink(next, sessionId, link);
        if (this.#abortRunIfStale(baseState, entries)) return this.state;
      } catch (error) {
        if (this.#abortRunIfStale(baseState, entries)) return this.state;
        const message = error instanceof Error ? error.message : "Unknown commander link error";
        pendingCommanderEvents[faction] = tickInvoked
          ? []
          : [...commandWorld.events].slice(-MAX_PENDING_EVENTS);
        next = appendLog(
          {
            ...next,
            world,
            commanders: {
              ...next.commanders,
              [faction]: {
                ...(next.commanders[faction] ?? offlineCommander()),
                connected: false,
                mode: "offline",
                lastError: message,
              },
            },
          },
          "warning",
          `Commander unavailable: ${message}`,
          faction,
        );
        this.#connectedSessions.delete(sessionId);
        link.requestFullSnapshot();
        next = await this.#checkpointLink(next, sessionId, link);
        if (this.#abortRunIfStale(baseState, entries)) return this.state;
      }
    }

    next = { ...next, world, pendingCommanderEvents };
    if (this.#abortRunIfStale(baseState, entries)) return this.state;
    this.setState(next);
    return next;
  }

  private async commanderLink(
    faction: string,
    state: PoligonState,
  ): Promise<{ readonly link: RestCommanderLink; readonly sessionId: string } | undefined> {
    if (!this.env.COMMANDER_API_KEY) return undefined;
    if (!this.env.COMMANDER_SERVICE && !this.env.COMMANDER_URL) return undefined;
    const sessionId = commanderSessionId({
      scenario: state.scenario,
      seed: state.seed,
      faction,
      doctrine: state.doctrine,
      timeScale: state.timeScale,
      mode: state.mode,
    });
    const existing = this.#links.get(sessionId);
    if (existing) return { link: existing, sessionId };

    // Production rides the private COMMANDER_SERVICE binding; COMMANDER_URL
    // remains a local-development fallback.
    const service = this.env.COMMANDER_SERVICE;
    const link = new RestCommanderLink({
      endpoint: service ? "https://commander.internal" : (this.env.COMMANDER_URL as string),
      apiKey: this.env.COMMANDER_API_KEY,
      sessionId,
      faction,
      doctrine: state.doctrine,
      missionEpoch: 1,
      mapName: "Poligon Procedural",
      ...(service
        ? {
            fetch: ((input: RequestInfo | URL, init?: RequestInit) =>
              service.fetch(
                input instanceof Request ? input : String(input),
                init,
              )) as typeof globalThis.fetch,
          }
        : {}),
    });
    const checkpoint = state.linkCheckpoints[sessionId];
    if (checkpoint) {
      try {
        await link.restoreState(checkpoint);
        if (this.state !== state) return undefined;
        if (link.connected) this.#connectedSessions.add(sessionId);
      } catch {
        if (this.state !== state) return undefined;
        link.requestFullSnapshot();
      }
    }
    this.#links.set(sessionId, link);
    return { link, sessionId };
  }

  async #checkpointLink(
    state: PoligonState,
    sessionId: string,
    link: RestCommanderLink,
  ): Promise<PoligonState> {
    return {
      ...state,
      linkCheckpoints: {
        ...state.linkCheckpoints,
        [sessionId]: await link.snapshotState(),
      },
    };
  }

  #abortRunIfStale(baseState: PoligonState, entries: readonly CommanderLinkSession[]): boolean {
    if (this.state === baseState) return false;
    for (const { link, sessionId } of entries) {
      if (this.#links.get(sessionId) !== link) continue;
      this.#links.delete(sessionId);
      this.#connectedSessions.delete(sessionId);
    }
    return true;
  }

  #assertControlPermission(): void {
    const { connection } = getCurrentAgent<SimWorld>();
    if (connection && this.isConnectionReadonly(connection)) {
      throw new Error("Operate permission is required to control this simulation");
    }
  }

  #resetLinks(): void {
    this.#links.clear();
    this.#connectedSessions.clear();
  }
}
