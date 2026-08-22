import type {
  FriendlyGroupState,
  GameSnapshot,
  KnownEnemyState,
  ObjectiveState,
  TickRequest,
  TickResponse,
} from "@stavka/protocol";

import type { CommanderConfig } from "../config";
import type { CommanderSessionState, ObservationSummary } from "./types";

export const SHORT_TERM_WINDOW_SECONDS = 10 * 60;
const RAW_OBSERVATION_WINDOW_SECONDS = 2 * 60;

const compactObservations = (
  state: CommanderSessionState,
  olderEvents: CommanderSessionState["memory"]["shortTerm"]["events"],
  olderReports: CommanderSessionState["memory"]["shortTerm"]["reports"],
  cutoff: number,
): ObservationSummary[] => {
  const indexed = new Map<string, ObservationSummary>();
  for (const summary of state.memory.shortTerm.summaries) {
    if (summary.timestamp >= cutoff) indexed.set(`${summary.kind}:${summary.key}`, summary);
  }
  const add = (
    kind: ObservationSummary["kind"],
    key: string,
    timestamp: number,
    label: string,
  ): void => {
    const index = `${kind}:${key}`;
    const previous = indexed.get(index);
    const count = (previous?.count ?? 0) + 1;
    indexed.set(index, {
      timestamp: Math.max(previous?.timestamp ?? timestamp, timestamp),
      kind,
      key,
      count,
      summary: `${count} ${label}`,
    });
  };
  for (const event of olderEvents) {
    add("event", event.type, event.timestamp, `${event.type} event(s)`);
  }
  for (const report of olderReports) {
    const key = `${report.payload.group_id}:${report.payload.report_type}`;
    add(
      "report",
      key,
      report.timestamp,
      `${report.payload.report_type} report(s) from ${report.payload.group_id}`,
    );
  }
  return [...indexed.values()].sort((left, right) => left.timestamp - right.timestamp).slice(-100);
};

const upsertById = <T extends { readonly id: string }>(
  current: readonly T[],
  updates: readonly T[],
): T[] => {
  const indexed = new Map(current.map((item) => [item.id, item]));
  for (const update of updates) indexed.set(update.id, update);
  return [...indexed.values()];
};

const applyDelta = (
  snapshot: GameSnapshot,
  request: Extract<TickRequest, { type: "delta" }>,
): GameSnapshot => {
  let groups = upsertById(snapshot.friendly_groups, request.changes.groups_upserted);
  const movement = new Map(request.changes.groups_moved.map((item) => [item.id, item.position]));
  groups = groups
    .filter((group) => !request.changes.groups_destroyed.includes(group.id))
    .map((group): FriendlyGroupState => {
      const position = movement.get(group.id);
      return position ? { ...group, position } : group;
    });
  const expiredEnemies = new Set(request.changes.known_enemies_expired);
  const removedObjectives = new Set(request.changes.objectives_removed ?? []);
  const knownEnemies = upsertById<KnownEnemyState>(
    snapshot.known_enemies.filter((enemy) => !expiredEnemies.has(enemy.id)),
    request.changes.known_enemies_upserted,
  );
  return {
    ...snapshot,
    mission: request.changes.mission ?? snapshot.mission,
    objectives: upsertById<ObjectiveState>(
      snapshot.objectives.filter((objective) => !removedObjectives.has(objective.id)),
      request.changes.objectives_upserted,
    ),
    friendly_groups: groups,
    known_enemies: knownEnemies,
    resources: request.changes.resources ?? snapshot.resources,
  };
};

const calculateDifficulty = (
  state: CommanderSessionState,
  snapshot: GameSnapshot,
): CommanderSessionState["difficulty"] => {
  const friendlyObjectives = snapshot.objectives.filter(
    (item) => item.status === "friendly",
  ).length;
  const enemyObjectives = snapshot.objectives.filter((item) => item.status === "enemy").length;
  const totalObjectives = Math.max(1, snapshot.objectives.length);
  const objectiveMomentum = (enemyObjectives - friendlyObjectives) / totalObjectives;
  const losses = state.memory.shortTerm.events.filter((item) => item.type === "casualty").length;
  const playerPerformance = Math.min(1, Math.max(-1, objectiveMomentum + losses / 20));
  return {
    ...state.difficulty,
    playerPerformance,
    objectiveMomentum,
    effective: Math.min(1, Math.max(0, state.difficulty.configured + playerPerformance * 0.15)),
  };
};

export interface TickApplication {
  readonly state: CommanderSessionState;
  readonly requestFullSnapshot: boolean;
  readonly accepted: boolean;
}

export const cachedTickResponse = (
  state: CommanderSessionState,
  request: TickRequest,
): TickResponse | undefined =>
  state.sessionId === request.session_id &&
  state.faction === request.faction &&
  state.lastTickId === request.tick_id
    ? state.lastTickResponse
    : undefined;

export const applyTick = (
  state: CommanderSessionState,
  request: TickRequest,
  config: CommanderConfig,
): TickApplication => {
  const sessionChanged =
    state.sessionId !== "" &&
    (state.sessionId !== request.session_id || state.faction !== request.faction);
  if (sessionChanged || request.tick_id <= state.lastTickId) {
    return { state, requestFullSnapshot: true, accepted: false };
  }

  let snapshot: GameSnapshot | undefined;
  let requestFullSnapshot = false;
  if (request.type === "full") snapshot = request.snapshot;
  else if (!state.snapshot || request.since_tick !== state.lastTickId) requestFullSnapshot = true;
  else snapshot = applyDelta(state.snapshot, request);

  if (
    request.type === "delta" &&
    request.tick_id - state.lastFullTickId >= Math.max(1, request.full_snapshot_interval)
  )
    requestFullSnapshot = true;

  if (!snapshot) return { state, requestFullSnapshot: true, accepted: false };
  const now = request.timestamp;
  const playerCount = Math.max(
    1,
    snapshot.mission.player_count.enemy + snapshot.mission.player_count.friendly,
  );
  const shortTermCutoff = now - SHORT_TERM_WINDOW_SECONDS;
  const rawCutoff = now - RAW_OBSERVATION_WINDOW_SECONDS;
  const retainedEvents = [...state.memory.shortTerm.events, ...request.events].filter(
    (event) => event.timestamp >= shortTermCutoff,
  );
  const retainedReports = [...state.memory.shortTerm.reports, ...request.sergeant_reports].filter(
    (report) => report.timestamp >= shortTermCutoff,
  );
  const summaries = compactObservations(
    state,
    retainedEvents.filter((event) => event.timestamp < rawCutoff),
    retainedReports.filter((report) => report.timestamp < rawCutoff),
    shortTermCutoff,
  );
  const events = retainedEvents.filter((event) => event.timestamp >= rawCutoff).slice(-100);
  const reports = retainedReports.filter((report) => report.timestamp >= rawCutoff).slice(-50);
  const decisions = state.memory.shortTerm.decisions
    .filter((decision) => decision.timestamp >= shortTermCutoff)
    .slice(-30);
  const outcomes = [
    ...(state.memory.shortTerm.outcomes ?? []),
    ...request.command_results.map((result) => ({ timestamp: now, result })),
  ]
    .filter((outcome) => outcome.timestamp >= shortTermCutoff)
    .slice(-100);
  const terminal = new Set(
    request.command_results
      .filter((result) => result.status !== "accepted")
      .map((result) => result.command_id),
  );
  const pendingCommands = state.pendingCommands.filter(
    (command) => !terminal.has(command.command_id),
  );
  const previousReportedManpower = state.budget.reportedManpower;
  const previousReportedVehicles = state.budget.reportedVehiclePool;
  let manpower =
    previousReportedManpower === undefined
      ? snapshot.resources.manpower
      : Math.min(
          snapshot.resources.manpower,
          Math.max(
            0,
            state.budget.manpower + snapshot.resources.manpower - previousReportedManpower,
          ),
        );
  let vehiclePool =
    previousReportedVehicles === undefined
      ? snapshot.resources.vehicle_pool
      : Math.min(
          snapshot.resources.vehicle_pool,
          Math.max(
            0,
            state.budget.vehiclePool + snapshot.resources.vehicle_pool - previousReportedVehicles,
          ),
        );
  for (const result of request.command_results) {
    if (result.status !== "failed" && result.status !== "ignored") continue;
    const command = state.pendingCommands.find((item) => item.command_id === result.command_id);
    if (command?.type !== "spawn_group") continue;
    manpower = Math.min(snapshot.resources.manpower, manpower + 6);
    if (/vehicle|mechanized|motorized|armor|tank|apc|ifv/i.test(command.params.template)) {
      vehiclePool = Math.min(snapshot.resources.vehicle_pool, vehiclePool + 1);
    }
  }
  const next: CommanderSessionState = {
    ...state,
    connected: true,
    sessionId: request.session_id,
    faction: request.faction,
    missionEpoch: snapshot.mission.epoch,
    lastTickId: request.tick_id,
    lastFullTickId: request.type === "full" ? request.tick_id : state.lastFullTickId,
    doctrine: state.doctrine,
    snapshot,
    pendingCommands,
    memory: {
      working: {
        snapshot,
        pendingCommandIds: pendingCommands.map((command) => command.command_id),
      },
      shortTerm: { events, reports, summaries, decisions, outcomes },
      longTerm: {
        decisionCount: state.memory.longTerm.decisionCount,
        eventCount: state.memory.longTerm.eventCount + request.events.length,
        snapshotCount: state.memory.longTerm.snapshotCount + (request.type === "full" ? 1 : 0),
      },
    },
    budget: {
      ...state.budget,
      manpower,
      vehiclePool,
      reinforcementReadyAt:
        snapshot.mission.time_elapsed_seconds + snapshot.resources.reinforcement_cooldown_seconds,
      maxActiveUnits: Math.min(
        50,
        config.maxActiveUnits,
        snapshot.resources.max_active_units,
        config.playerScaling ? 8 + playerCount * 4 : config.maxActiveUnits,
      ),
      lastUpdatedAt: now,
      reportedManpower: snapshot.resources.manpower,
      reportedVehiclePool: snapshot.resources.vehicle_pool,
    },
  };
  return {
    state: { ...next, difficulty: calculateDifficulty(next, snapshot) },
    requestFullSnapshot,
    accepted: true,
  };
};

export const withConnect = (
  state: CommanderSessionState,
  input: {
    readonly sessionId: string;
    readonly faction: string;
    readonly missionEpoch: number;
    readonly doctrine?: "aggressive" | "balanced" | "defensive";
  },
  config: CommanderConfig,
): CommanderSessionState => {
  const newMission =
    state.sessionId !== input.sessionId ||
    state.faction !== input.faction ||
    state.missionEpoch !== input.missionEpoch;
  let base = state;
  if (newMission) {
    const {
      snapshot: _snapshot,
      mapBriefing: _mapBriefing,
      disconnectedAt: _disconnectedAt,
      lastTickResponse: _lastTickResponse,
      pendingDecisionTrigger: _pendingDecisionTrigger,
      ...persisted
    } = state;
    base = {
      ...persisted,
      lastTickId: 0,
      lastFullTickId: 0,
      decisionPending: false,
      pendingCommands: [],
    };
  }
  return {
    ...base,
    connected: true,
    sessionId: input.sessionId,
    faction: input.faction,
    missionEpoch: input.missionEpoch,
    doctrine: input.doctrine ?? config.doctrine,
    difficulty: { ...base.difficulty, configured: config.difficulty, effective: config.difficulty },
    budget: { ...base.budget, maxActiveUnits: config.maxActiveUnits },
  };
};

const triggerPriority = (trigger: string): number =>
  trigger.startsWith("event:") ? 2 : trigger.startsWith("report:") ? 1 : 0;

export const requestCommanderDecision = (
  state: CommanderSessionState,
  trigger: string,
): CommanderSessionState => {
  const pendingDecisionTrigger =
    state.pendingDecisionTrigger === undefined ||
    triggerPriority(trigger) > triggerPriority(state.pendingDecisionTrigger)
      ? trigger
      : state.pendingDecisionTrigger;
  const changed = !state.decisionPending || pendingDecisionTrigger !== state.pendingDecisionTrigger;
  return {
    ...state,
    decisionPending: true,
    pendingDecisionTrigger,
    pendingDecisionVersion: state.pendingDecisionVersion + (changed ? 1 : 0),
  };
};

/**
 * Give an already-pending decision a new durable owner without lowering the
 * trigger that caused it. This is used when an asynchronous planner observes
 * that its snapshot is stale after the model returns: the old callback must
 * not settle the newer state, but the same-priority work still needs a new
 * scheduled run.
 */
export const requeueCommanderDecision = (
  state: CommanderSessionState,
  trigger = state.pendingDecisionTrigger ?? "scheduled_alarm",
): CommanderSessionState => {
  const pendingDecisionTrigger =
    state.pendingDecisionTrigger === undefined ||
    triggerPriority(trigger) > triggerPriority(state.pendingDecisionTrigger)
      ? trigger
      : state.pendingDecisionTrigger;
  return {
    ...state,
    decisionPending: true,
    pendingDecisionTrigger,
    pendingDecisionVersion: state.pendingDecisionVersion + 1,
  };
};

export const recoverPendingDecision = (state: CommanderSessionState): CommanderSessionState => {
  if (!state.decisionPending && state.pendingDecisionTrigger === undefined) return state;
  const { pendingDecisionTrigger: _pendingDecisionTrigger, ...rest } = state;
  return { ...rest, decisionPending: false, mode: "degraded" };
};
