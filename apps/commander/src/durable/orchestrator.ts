import { Agent, type Connection, type ConnectionContext, type WSMessage } from "agents";
import {
  LlmContributorClientMessage,
  type LlmSeatRegistrationRequest,
  type LlmTierAlias,
  Command,
  type ConnectRequest,
  type ConnectResponse,
  type MapBriefing,
  type SessionExport,
  type TickRequest,
  type TickResponse,
} from "@stavka/protocol";
import { Clock, Effect, Schema } from "effect";

import {
  decodeContributorDecision,
  isActiveSeatConnection,
} from "../brain/contributor-channel";
import { estimateCost, type AiDecisionResult } from "../brain/llm-client";
import { planDecision, type PlannedDecision } from "../brain/planner";
import { authorizeSeatRequest } from "../brain/seat-auth";
import {
  reconcileSeatBudgetState,
  reserveSeatBudgetState,
  rollSeatBudgetPeriod,
  utcBudgetPeriod,
} from "../brain/seat-budget";
import {
  chargeSeat,
  ContributorResultError,
  isRetryableSeatFailure,
  resolveLlmRoute,
  runRoutedAiDecision,
  SEAT_REGISTRY_NAME,
  stretchedInterval,
} from "../brain/seat-router";
import { readConfigEffect, type Env } from "../config";
import {
  initialDecisionLogExportCursor,
  SqlDecisionLogRepository,
} from "../logging/decision-log-repository";
import {
  R2SessionExportRepository,
  type SessionExportHeader,
  type SessionExportMetadata,
  type SessionExportPageDescriptor,
} from "../logging/r2-session-export-repository";
import {
  initialSessionArchiveExportCursor,
  SqlSessionArchiveRepository,
} from "../logging/session-archive-repository";
import { decisionId, type DecisionLogEntry } from "../logging/types";
import {
  applyTick,
  cachedTickResponse,
  requeueCommanderDecision,
  requestCommanderDecision,
  SHORT_TERM_WINDOW_SECONDS,
  withConnect,
} from "../state/game-state";
import { recordCostAggregate } from "../state/cost-aggregates";
import {
  CommanderSessionStateSchema,
  initialCommanderState,
  type CommanderSessionState,
  type SeatRegistration,
} from "../state/types";
import { scopedSergeantSnapshot, SergeantAgent } from "./sergeant";

interface SeatConnectionState {
  readonly channel: "seat";
  readonly authorizedSeatId: "*" | string;
  readonly seatId?: string;
}

interface PendingContributorJob {
  readonly seatId: string;
  readonly tier: LlmTierAlias;
  readonly leaseId: string;
  readonly resumes: Set<(effect: Effect.Effect<AiDecisionResult, Error>) => void>;
}

interface ContributorInvocationFailure {
  readonly code: string;
  readonly message: string;
  readonly retryable: boolean;
  readonly tokenUsage?: { readonly input: number; readonly output: number };
  readonly costUsd?: number;
  readonly resolvedModel?: string;
}

type ContributorInvocationOutcome =
  | { readonly ok: true; readonly result: AiDecisionResult }
  | { readonly ok: false; readonly failure: ContributorInvocationFailure };

const STALE_SEAT_RESERVATION_SECONDS = 5 * 60;

const safeJobFragment = (value: string, maxLength: number): string =>
  value.replace(/[^a-zA-Z0-9_.:-]/g, "_").slice(0, maxLength);

const stableJobHash = (value: string): string => {
  let hash = 2_166_136_261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }
  return (hash >>> 0).toString(36);
};

const contributorJobId = (seatId: string, jobKey: string): string => {
  const seat = safeJobFragment(seatId, 40);
  const key = safeJobFragment(jobKey, 70);
  return `job_${seat}_${key}_${stableJobHash(`${seatId}\0${jobKey}`)}`.slice(0, 128);
};

const timeoutContributorError = (jobId: string): ContributorResultError =>
  new ContributorResultError({
    code: "CONTRIBUTOR_TIMEOUT",
    message: `Contributor job ${jobId} timed out`,
    retryable: true,
  });

const contributorInvocationFailure = (cause: unknown): ContributorInvocationFailure => {
  if (cause instanceof ContributorResultError) {
    return {
      code: cause.code,
      message: cause.message,
      retryable: cause.retryable,
      ...(cause.tokenUsage === undefined ? {} : { tokenUsage: cause.tokenUsage }),
      ...(cause.costUsd === undefined ? {} : { costUsd: cause.costUsd }),
      ...(cause.resolvedModel === undefined ? {} : { resolvedModel: cause.resolvedModel }),
    };
  }
  return {
    code: "CONTRIBUTOR_UNAVAILABLE",
    message: cause instanceof Error ? cause.message : "Contributor invocation failed",
    retryable: isRetryableSeatFailure(cause),
  };
};

const seatMessage = (message: unknown): string => JSON.stringify(message);

const wsText = (message: WSMessage): string => {
  if (typeof message === "string") return message;
  if (message instanceof ArrayBuffer) return new TextDecoder().decode(message);
  return new TextDecoder().decode(
    new Uint8Array(message.buffer, message.byteOffset, message.byteLength),
  );
};

const appendDecision = (
  state: CommanderSessionState,
  decision: PlannedDecision,
  trigger: string,
  timestamp: string,
): { readonly state: CommanderSessionState; readonly log: DecisionLogEntry } => {
  const { pendingDecisionTrigger: _pendingDecisionTrigger, ...settledState } = state;
  const id = decisionId(state.nextDecisionSequence);
  const decisionAt = state.snapshot?.mission.time_elapsed_seconds ?? state.lastDecisionAt;
  const log: DecisionLogEntry = {
    id,
    timestamp,
    agent: "commander",
    trigger,
    input: {
      stateSnapshot: state.snapshot ?? null,
      events: state.memory.shortTerm.events.slice(-30),
      prompt: decision.prompt,
    },
    output: {
      rawResponse: decision.rawResponse,
      parsedCommands: decision.commands,
      summary: decision.summary,
    },
    commandsIssued: decision.commands.map((command) => command.command_id),
    model: decision.model,
    latencyMs: decision.latencyMs,
    tokenUsage: decision.tokenUsage,
    costUsd: decision.costUsd,
  };
  const costAttributions = decisionCostAttributions(decision);
  const accounted = accountCostAttributions(state, "commander", costAttributions);
  return {
    log,
    state: {
      ...settledState,
      mode: decision.mode,
      decisionPending: false,
      lastDecisionAt: decisionAt,
      pendingCommands: [...state.pendingCommands, ...decision.commands],
      recentLogs: [...state.recentLogs, log].slice(-100),
      seats: accounted.seats,
      nextDecisionSequence: state.nextDecisionSequence + 1,
      nextCommandSequence: state.nextCommandSequence + decision.commandSequenceAdvance,
      costAggregates: accounted.costAggregates,
      budget: {
        ...state.budget,
        manpower: Math.max(0, state.budget.manpower - decision.manpowerSpent),
        vehiclePool: Math.max(0, state.budget.vehiclePool - decision.vehiclesReserved),
        reinforcementReadyAt:
          decision.manpowerSpent > 0
            ? (state.snapshot?.mission.time_elapsed_seconds ?? 0) + 30
            : state.budget.reinforcementReadyAt,
      },
      memory: {
        ...state.memory,
        shortTerm: {
          ...state.memory.shortTerm,
          decisions: [
            ...state.memory.shortTerm.decisions.filter(
              (item) => item.timestamp >= decisionAt - SHORT_TERM_WINDOW_SECONDS,
            ),
            { timestamp: decisionAt, summary: decision.summary },
          ].slice(-30),
        },
        longTerm: {
          ...state.memory.longTerm,
          decisionCount: state.memory.longTerm.decisionCount + 1,
        },
      },
    },
  };
};

type CostAttribution = {
  readonly model: string;
  readonly tokenUsage: { readonly input: number; readonly output: number };
  readonly costUsd: number;
  readonly seatId?: string;
};

const decisionCostAttributions = (
  decision: PlannedDecision,
): readonly CostAttribution[] => decision.costAttributions ?? [{
  model: decision.model,
  tokenUsage: decision.tokenUsage,
  costUsd: decision.costUsd,
  ...(decision.seatId === undefined ? {} : { seatId: decision.seatId }),
}];

const accountCostAttributions = (
  state: Pick<CommanderSessionState, "seats" | "costAggregates">,
  agentTier: "commander" | "sergeant",
  attributions: readonly CostAttribution[],
): Pick<CommanderSessionState, "seats" | "costAggregates"> => {
  let seats = state.seats;
  let costAggregates = state.costAggregates;
  for (const attribution of attributions) {
    const tokenUsage = {
      input: Math.max(0, attribution.tokenUsage.input),
      output: Math.max(0, attribution.tokenUsage.output),
    };
    const costUsd = Math.max(0, attribution.costUsd);
    seats = chargeSeat(seats, attribution.seatId, costUsd);
    costAggregates = recordCostAggregate(
      costAggregates,
      agentTier,
      attribution.model,
      tokenUsage,
      costUsd,
    );
  }
  return { seats, costAggregates };
};

const staleDecisionAuditLog = (
  planningState: CommanderSessionState,
  decision: PlannedDecision,
  trigger: string,
  timestamp: string,
  version: number,
): DecisionLogEntry => {
  const attributions = decisionCostAttributions(decision);
  const tokenUsage = attributions.reduce(
    (total, attribution) => ({
      input: total.input + Math.max(0, attribution.tokenUsage.input),
      output: total.output + Math.max(0, attribution.tokenUsage.output),
    }),
    { input: 0, output: 0 },
  );
  const costUsd = attributions.reduce(
    (total, attribution) => total + Math.max(0, attribution.costUsd),
    0,
  );
  return {
    // The decision sequence is deliberately not consumed: this is an audit
    // entry for discarded provider work, not a command-producing decision.
    id: `audit_stale_${String(planningState.nextDecisionSequence).padStart(6, "0")}_v${version}`,
    timestamp,
    agent: "commander",
    trigger: `${trigger}:stale_discarded`,
    input: {
      stateSnapshot: planningState.snapshot ?? null,
      events: planningState.memory.shortTerm.events.slice(-30),
      prompt: decision.prompt,
    },
    output: {
      rawResponse: decision.rawResponse,
      parsedCommands: [],
      summary: "Discarded stale commander provider result before issuing commands.",
    },
    commandsIssued: [],
    model: decision.model,
    latencyMs: decision.latencyMs,
    tokenUsage,
    costUsd,
  };
};

const repositoryFailure = (operation: string, cause: unknown): Error =>
  new Error(`Commander ${operation} failed`, { cause });

const sessionExportHeader = (
  state: CommanderSessionState,
  exportedAt: number,
): SessionExportHeader => {
  const mapName = state.snapshot?.mission.map;
  return {
    export_version: 1,
    session: {
      protocol_version: 1,
      session_id: state.sessionId,
      faction: state.faction,
      mission_epoch: state.missionEpoch,
      doctrine: state.doctrine,
      mode: state.mode,
      ...(mapName === undefined || mapName.length === 0 ? {} : { map_name: mapName }),
      exported_at: new Date(exportedAt).toISOString(),
    },
    cost_aggregates: state.costAggregates,
  };
};

const SeatProbeResponse = Schema.Struct({ ok: Schema.Boolean });

export const probeHttpSeat = (
  seat: Exclude<SeatRegistration, { readonly mode: "contributor" }>,
  env: Env,
): Effect.Effect<boolean> =>
  readConfigEffect(env).pipe(
    Effect.flatMap((config) => {
      const credential = config.seatKeys[seat.id];
      if (credential === undefined) return Effect.succeed(false);
      const headers: HeadersInit = { authorization: `Bearer ${credential}` };
      return Effect.tryPromise({
        try: (signal) => fetch(`${seat.endpoint.replace(/\/$/, "")}/healthz`, {
          headers,
          signal,
        }),
        catch: (cause) => cause,
      }).pipe(
        Effect.flatMap((response) => response.ok
          ? Effect.tryPromise({ try: () => response.json(), catch: (cause) => cause })
          : Effect.fail(new Error(`Seat health returned ${response.status}`))),
        Effect.flatMap(Schema.decodeUnknownEffect(SeatProbeResponse)),
        Effect.map((health) => health.ok),
        Effect.timeoutOrElse({ duration: "3 seconds", orElse: () => Effect.succeed(false) }),
        Effect.catch(() => Effect.succeed(false)),
      );
    }),
    Effect.catch(() => Effect.succeed(false)),
  );

export class OrchestratorAgent extends Agent<Env, CommanderSessionState> {
  override initialState = initialCommanderState();
  private readonly contributorJobs = new Map<string, PendingContributorJob>();

  override validateStateChange(nextState: CommanderSessionState): void {
    Schema.decodeUnknownSync(CommanderSessionStateSchema)(nextState);
  }

  override onStart(): Promise<void> {
    return Effect.runPromise(Effect.gen({ self: this }, function*() {
      yield* Effect.all([
        this.decisionLogs().initialize,
        this.sessionArchive().initialize,
      ]);
      if (this.name === SEAT_REGISTRY_NAME) return;
      const config = yield* readConfigEffect(this.env);
      yield* Effect.tryPromise({
        try: () => this.scheduleEvery(config.decisionIntervalSeconds, "scheduledDecision"),
        catch: (cause) => repositoryFailure("schedule initialization", cause),
      });
      if (this.state.connected && this.state.snapshot && this.state.decisionPending) {
        yield* this.enqueueDecisionRun(this.state.pendingDecisionVersion).pipe(
          Effect.catch((cause) => Effect.logWarning(cause.message)),
        );
      }
    }));
  }

  override shouldSendProtocolMessages(
    _connection: Connection,
    _context: ConnectionContext,
  ): boolean {
    return this.name !== SEAT_REGISTRY_NAME;
  }

  override onConnect(connection: Connection, context: ConnectionContext): Promise<void> {
    return Effect.runPromise(Effect.gen({ self: this }, function*() {
      if (this.name !== SEAT_REGISTRY_NAME) return;
      const principal = yield* authorizeSeatRequest(context.request, this.env);
      if (principal === undefined) {
        yield* Effect.sync(() => connection.close(1008, "Invalid seat bearer token"));
        return;
      }
      yield* Effect.sync(() => connection.setState({
        channel: "seat",
        authorizedSeatId: principal.seatId,
      } satisfies SeatConnectionState));
    }));
  }

  override onMessage(connection: Connection, raw: WSMessage): Promise<void> {
    return Effect.runPromise(this.handleSeatMessage(connection, raw).pipe(
      Effect.catch((cause) => Effect.sync(() => {
        connection.send(seatMessage({
          protocol_version: 1,
          type: "error",
          code: "INVALID_SEAT_MESSAGE",
          message: cause instanceof Error ? cause.message : "Invalid contributor message",
        }));
      })),
    ));
  }

  override onClose(
    connection: Connection,
    _code: number,
    _reason: string,
    _wasClean: boolean,
  ): Promise<void> {
    return Effect.runPromise(this.markConnectionUnavailable(connection));
  }

  connectSession(request: ConnectRequest): Promise<ConnectResponse> {
    return Effect.runPromise(Effect.gen({ self: this }, function*() {
      const config = yield* readConfigEffect(this.env);
      yield* Effect.sync(() => this.setState(withConnect(this.state, {
        sessionId: request.session_id,
        faction: request.faction,
        missionEpoch: request.mission_epoch,
        ...(request.doctrine === undefined ? {} : { doctrine: request.doctrine }),
      }, config)));
      return {
        protocol_version: 1 as const,
        accepted: true,
        request_full_snapshot: true,
        tick_rate_hint: config.tickIdleMs,
      };
    }));
  }

  disconnectSession(reason?: string): Promise<void> {
    return Effect.runPromise(Effect.sync(() => {
      const summary = reason ? `Disconnected: ${reason}` : "Disconnected";
      const timestamp = this.state.snapshot?.mission.time_elapsed_seconds ?? 0;
      this.setState({
        ...this.state,
        connected: false,
        disconnectedAt: Date.now() / 1_000,
        memory: {
          ...this.state.memory,
          shortTerm: {
            ...this.state.memory.shortTerm,
            decisions: [...this.state.memory.shortTerm.decisions, { timestamp, summary }].slice(-30),
          },
        },
      });
    }));
  }

  setMapBriefing(briefing: MapBriefing): Promise<void> {
    return Effect.runPromise(Effect.sync(() => {
      const missionMap = this.state.snapshot?.mission.map;
      if (missionMap !== undefined && missionMap !== briefing.map_name) {
        throw new Error(
          `Map briefing ${briefing.map_name} does not match active mission map ${missionMap}`,
        );
      }
      this.setState({ ...this.state, mapBriefing: briefing });
    }));
  }

  handleTick(request: TickRequest): Promise<TickResponse> {
    return Effect.runPromise(Effect.gen({ self: this }, function*() {
      const config = yield* readConfigEffect(this.env);
      const cached = cachedTickResponse(this.state, request);
      if (cached !== undefined) return cached;
      const applied = applyTick(this.state, request, config);
      if (!applied.accepted) {
        return this.response([], true, applied.state, config.tickIdleMs);
      }

      // Persist the tick transition before any RPC or child work. A detached
      // commander decision can finish while those awaits are in flight; every
      // later mutation below starts from this.state so it revision-merges with
      // that completion instead of restoring this stale pre-tick snapshot.
      yield* Effect.sync(() => this.setState(applied.state));
      let next = this.state;
      const sergeantGroupIds = [...new Set([
        ...next.sergeantGroupIds,
        ...request.sergeant_reports.map((report) => report.payload.group_id),
      ])].slice(-50);
      const drained = yield* Effect.forEach(
        sergeantGroupIds,
        (groupId) => Effect.result(Effect.tryPromise({
          try: async () => {
            const sergeant = await this.subAgent(SergeantAgent, groupId);
            return {
              groupId,
              completed: await sergeant.listCompletedAssessments(),
            };
          },
          catch: (cause) => repositoryFailure(`sergeant ${groupId} drain`, cause),
        })),
        { concurrency: 8 },
      );
      const completedByGroup = drained.flatMap((result) => {
        if (result._tag === "Success") return [result.success];
        return [];
      });
      yield* Effect.forEach(
        drained,
        (result) => result._tag === "Failure"
          ? Effect.logWarning(
              result.failure instanceof Error
                ? result.failure.message
                : "Could not drain sergeant assessments",
            )
          : Effect.void,
      );

      next = this.state;
      const processedAssessments = new Set(next.processedSergeantAssessmentIds);
      const assessments = completedByGroup
        .flatMap(({ completed }) => completed)
        .filter((assessment) => !processedAssessments.has(assessment.log.id));
      yield* Effect.forEach(assessments, (assessment) => this.decisionLogs().save(assessment.log));
      next = this.state;
      const sergeantCommands = assessments.flatMap((assessment) => assessment.commands);
      if (sergeantCommands.length > 0) {
        next = { ...next, pendingCommands: [...next.pendingCommands, ...sergeantCommands] };
      }
      if (assessments.length > 0) {
        next = {
          ...next,
          memory: {
            ...next.memory,
            shortTerm: {
              ...next.memory.shortTerm,
              decisions: [
                ...next.memory.shortTerm.decisions,
                ...assessments.map((assessment) => ({
                  timestamp: assessment.timestamp,
                  summary: assessment.summary,
                })),
              ].filter((item) =>
                item.timestamp >= request.timestamp - SHORT_TERM_WINDOW_SECONDS)
                .slice(-30),
            },
          },
        };
      }
      for (const assessment of assessments) {
        const costAttributions = assessment.costAttributions ?? [{
          model: assessment.log.model,
          tokenUsage: assessment.log.tokenUsage,
          costUsd: assessment.log.costUsd,
          ...(assessment.seatId === undefined ? {} : { seatId: assessment.seatId }),
        }];
        const accounted = accountCostAttributions(next, "sergeant", costAttributions);
        next = {
          ...next,
          seats: accounted.seats,
          costAggregates: accounted.costAggregates,
        };
      }
      next = {
        ...next,
        sergeantGroupIds,
        processedSergeantAssessmentIds: [
          ...next.processedSergeantAssessmentIds,
          ...assessments.map((assessment) => assessment.log.id),
        ].slice(-500),
      };
      yield* Effect.sync(() => this.setState(next));
      // Sergeant work reconciles its provider reservation in the registry.
      // Charge its per-session aggregates before this refresh so an outage
      // still leaves the local mirror correct, then replace the mirror with
      // registry truth. Refreshing first would make the attribution below
      // charge the same provider attempt a second time for this tick.
      const registrySeats = yield* Effect.tryPromise({
        try: () => this.env.ORCHESTRATOR.getByName(SEAT_REGISTRY_NAME).refreshSeats(),
        catch: (cause) => repositoryFailure("seat registry refresh", cause),
      }).pipe(Effect.catch(() => Effect.succeed(this.state.seats)));
      yield* Effect.sync(() => this.setState({ ...this.state, seats: registrySeats }));
      yield* Effect.forEach(
        request.sergeant_reports,
        (report) => Effect.tryPromise({
          try: async () => {
            const sergeant = await this.subAgent(SergeantAgent, report.payload.group_id);
            await sergeant.queueAssessment(
              report,
              scopedSergeantSnapshot(this.state.snapshot, report),
              this.state.seats,
            );
          },
          catch: (cause) => repositoryFailure(
            `sergeant ${report.payload.group_id} scheduling`,
            cause,
          ),
        }).pipe(Effect.catch((cause) => Effect.logWarning(cause.message))),
        { concurrency: 8 },
      );

      next = this.state;
      const urgent = request.events.find((item) => item.significance === "urgent");
      const strategicReport = request.sergeant_reports.find((report) =>
        report.payload.report_type !== "sitrep" ||
        (report.payload.request !== undefined && report.payload.request !== "none"));
      const commanderRoute = resolveLlmRoute(next.seats, config, config.commanderModel);
      const decisionInterval = stretchedInterval(
        commanderRoute,
        config.decisionIntervalSeconds,
        config.seatStretchMultiplier,
      );
      const due =
        (next.snapshot?.mission.time_elapsed_seconds ?? 0) - next.lastDecisionAt >=
        decisionInterval;
      let queueDecision = false;
      if (urgent || strategicReport || due || next.lastDecisionAt === 0) {
        const trigger = urgent
          ? `event:${urgent.type}`
          : strategicReport
          ? `report:${strategicReport.payload.report_type}`
          : "scheduled_tick";
        next = requestCommanderDecision(next, trigger);
        queueDecision = true;
      }

      next = {
        ...next,
        memory: {
          ...next.memory,
          working: {
            ...next.memory.working,
            pendingCommandIds: next.pendingCommands.map((command) => command.command_id),
          },
        },
      };
      const active = next.snapshot?.friendly_groups.some((group) => group.status === "engaged");
      const baseTickRate = urgent ? config.tickBurstMs : active ? config.tickActiveMs : config.tickIdleMs;
      const tickRate = stretchedInterval(
        commanderRoute,
        baseTickRate,
        config.seatStretchMultiplier,
      );
      yield* Effect.sync(() => this.setState(next));
      if (queueDecision) {
        const scheduled = yield* Effect.result(
          this.enqueueDecisionRun(next.pendingDecisionVersion),
        );
        if (scheduled._tag === "Failure") {
          yield* Effect.logWarning(
            scheduled.failure instanceof Error
              ? scheduled.failure.message
              : "Could not schedule commander decision",
          );
        }
      }
      // Re-read after schedule admission: a zero-delay callback may settle a
      // decision independently, and the response/cache write must preserve it.
      const responseState = this.state;
      const response = this.response(
        [...responseState.pendingCommands],
        applied.requestFullSnapshot,
        responseState,
        tickRate,
      );
      const archivedState = { ...this.state, lastTickResponse: response };
      yield* Effect.sync(() => this.setState(archivedState));
      yield* this.sessionArchive().saveTick(request, archivedState);
      yield* Effect.forEach(
        completedByGroup,
        ({ completed, groupId }) => {
          if (completed.length === 0) return Effect.void;
          return Effect.tryPromise({
            try: async () => {
              const sergeant = await this.subAgent(SergeantAgent, groupId);
              await sergeant.acknowledgeAssessments(
                completed.map((assessment) => assessment.log.id),
              );
            },
            catch: (cause) => repositoryFailure(`sergeant ${groupId} acknowledgement`, cause),
          }).pipe(Effect.catch((cause) => Effect.logWarning(cause.message)));
        },
        { concurrency: 8 },
      );
      return response;
    }));
  }

  scheduledDecision(): Promise<void> {
    return Effect.runPromise(Effect.gen({ self: this }, function*() {
      if (!this.state.connected || !this.state.snapshot) return;
      const requested = requestCommanderDecision(this.state, "scheduled_alarm");
      yield* Effect.sync(() => this.setState(requested));
      yield* this.enqueueDecisionRun(requested.pendingDecisionVersion);
    }));
  }

  runScheduledDecision(payload: {
    readonly kind: "commander";
    readonly version: number;
  }): Promise<void> {
    return Effect.runPromise(Effect.gen({ self: this }, function*() {
      if (
        !this.state.connected ||
        !this.state.snapshot ||
        !this.state.decisionPending ||
        this.state.pendingDecisionVersion !== payload.version
      ) return;
      const config = yield* readConfigEffect(this.env);
      const seats = yield* Effect.tryPromise({
        try: () => this.env.ORCHESTRATOR.getByName(SEAT_REGISTRY_NAME).refreshSeats(),
        catch: (cause) => repositoryFailure("seat registry refresh", cause),
      }).pipe(Effect.catch(() => Effect.succeed(this.state.seats)));
      const planningState = { ...this.state, seats };
      const trigger = planningState.pendingDecisionTrigger ?? "scheduled_alarm";
      const invocationId =
        `commander:${this.name}:${planningState.nextDecisionSequence}:${payload.version}`;
      const decision = yield* planDecision(planningState, config, trigger, (prompt) =>
        runRoutedAiDecision(
          this.env,
          planningState.seats,
          config,
          config.commanderModel,
          prompt,
          invocationId,
        ));
      const now = yield* Clock.currentTimeMillis;
      const latest = this.state;
      const stale =
        !latest.connected ||
        !latest.snapshot ||
        !latest.decisionPending ||
        latest.pendingDecisionVersion !== payload.version ||
        latest.sessionId !== planningState.sessionId ||
        latest.missionEpoch !== planningState.missionEpoch ||
        latest.lastTickId !== planningState.lastTickId;
      if (stale) {
        const staleLog = staleDecisionAuditLog(
          planningState,
          decision,
          trigger,
          new Date(now).toISOString(),
          payload.version,
        );
        const sameMission =
          latest.sessionId === planningState.sessionId &&
          latest.missionEpoch === planningState.missionEpoch;
        if (sameMission) {
          // Routing has already reconciled the provider reservation in the
          // registry. Refresh first so the session mirror does not charge it
          // twice, while still recording its real per-attempt aggregates.
          const refreshedSeats = yield* Effect.result(Effect.tryPromise({
            try: () => this.env.ORCHESTRATOR.getByName(SEAT_REGISTRY_NAME).refreshSeats(),
            catch: (cause) => repositoryFailure("stale decision seat refresh", cause),
          }));
          const accountingBase = refreshedSeats._tag === "Success"
            ? refreshedSeats.success
            : latest.seats;
          const accounted = accountCostAttributions(
            { seats: accountingBase, costAggregates: latest.costAggregates },
            "commander",
            decisionCostAttributions(decision),
          );
          const auditedState: CommanderSessionState = {
            ...latest,
            // On a refresh failure the local mirror has not seen this
            // provider attempt, so retain the charged fallback mirror.
            seats: refreshedSeats._tag === "Success" ? accountingBase : accounted.seats,
            costAggregates: accounted.costAggregates,
            recentLogs: [...latest.recentLogs, staleLog].slice(-100),
          };
          if (latest.connected && latest.snapshot && latest.decisionPending) {
            const followUp = requeueCommanderDecision(
              auditedState,
              latest.pendingDecisionTrigger ?? trigger,
            );
            yield* Effect.sync(() => this.setState(followUp));
            yield* this.decisionLogs().save(staleLog).pipe(
              Effect.catch((cause) => Effect.logWarning(
                cause instanceof Error ? cause.message : "Could not save stale commander audit log",
              )),
            );
            yield* this.enqueueDecisionRun(followUp.pendingDecisionVersion);
            return;
          }
          yield* Effect.sync(() => this.setState(auditedState));
        }
        // A disconnected/replaced mission must not inherit old spend into its
        // state, but the durable audit record still preserves the provider
        // call that was discarded.
        yield* this.decisionLogs().save(staleLog).pipe(
          Effect.catch((cause) => Effect.logWarning(
            cause instanceof Error ? cause.message : "Could not save stale commander audit log",
          )),
        );
        if (latest.connected && latest.snapshot && latest.decisionPending) {
          const followUp = requeueCommanderDecision(
            latest,
            latest.pendingDecisionTrigger ?? trigger,
          );
          yield* Effect.sync(() => this.setState(followUp));
          yield* this.enqueueDecisionRun(followUp.pendingDecisionVersion);
        }
        return;
      }
      const appended = appendDecision(
        latest,
        decision,
        trigger,
        new Date(now).toISOString(),
      );
      // Commit synchronously before the log write. This keeps the durable
      // game state authoritative if a tick arrives during repository I/O.
      yield* Effect.sync(() => this.setState(appended.state));
      yield* this.decisionLogs().save(appended.log).pipe(
        Effect.catch((cause) => Effect.logWarning(
          cause instanceof Error ? cause.message : "Could not save commander decision log",
        )),
      );
    }));
  }

  private enqueueDecisionRun(version: number): Effect.Effect<void, Error> {
    return Effect.tryPromise({
      try: () => this.schedule(
        0,
        "runScheduledDecision",
        { kind: "commander", version } as const,
        {
          idempotent: true,
          retry: { maxAttempts: 3, baseDelayMs: 250, maxDelayMs: 2_000 },
        },
      ),
      catch: (cause) => repositoryFailure("decision scheduling", cause),
    }).pipe(Effect.asVoid);
  }

  getSessionState(): Promise<CommanderSessionState> {
    return Effect.runPromise(Effect.succeed(this.state));
  }

  listDecisionLogs(limit = 100): Promise<DecisionLogEntry[]> {
    return Effect.runPromise(this.decisionLogs().list(limit));
  }

  registerSeat(input: LlmSeatRegistrationRequest): Promise<SeatRegistration[]> {
    return Effect.runPromise(Effect.gen({ self: this }, function*() {
      const now = yield* Clock.currentTimeMillis;
      const nowSeconds = now / 1_000;
      const budgetPeriod = utcBudgetPeriod(now);
      const config = yield* readConfigEffect(this.env);
      const previous = this.state.seats.find((item) => item.id === input.id);
      const unchecked: SeatRegistration = {
        ...input,
        healthy: false,
        exhausted: previous?.exhausted ?? false,
        registeredAt: previous?.registeredAt ?? new Date(now).toISOString(),
        spentUsd: previous?.spentUsd ?? 0,
        reservedUsd: previous?.reservedUsd ?? 0,
        budgetPeriod: previous?.budgetPeriod ?? budgetPeriod,
      };
      const current = rollSeatBudgetPeriod(unchecked, budgetPeriod);
      const healthy = current.mode === "contributor"
        ? false
        : yield* probeHttpSeat(current, this.env);
      const seat: SeatRegistration = {
        ...current,
        healthy,
        lastHealthAt: nowSeconds,
        healthExpiresAt: healthy ? nowSeconds + config.seatHeartbeatTtlSeconds : nowSeconds,
      };
      const seats = [...this.state.seats.filter((item) => item.id !== seat.id), seat]
        .sort((left, right) => right.priority - left.priority);
      yield* Effect.sync(() => this.setState({ ...this.state, seats }));
      return seats;
    }));
  }

  removeSeat(id: string): Promise<SeatRegistration[]> {
    return Effect.runPromise(Effect.sync(() => {
      const seats = this.state.seats.filter((item) => item.id !== id);
      this.setState({ ...this.state, seats });
      for (const connection of this.getConnections<SeatConnectionState>()) {
        if (connection.state?.seatId === id) connection.close(1008, "Seat registration revoked");
      }
      return seats;
    }));
  }

  refreshSeats(): Promise<SeatRegistration[]> {
    return Effect.runPromise(Effect.gen({ self: this }, function*() {
      const now = (yield* Clock.currentTimeMillis) / 1_000;
      const budgetPeriod = utcBudgetPeriod(now * 1_000);
      const config = yield* readConfigEffect(this.env);
      const reclaimed = this.reclaimStaleReservations(this.state, now);
      const contributorJobLedger = this.expireContributorJobs(this.state, now);
      const expiredJobIds = this.state.contributorJobLedger
        .filter((job) => job.status === "pending" && job.deadlineAt <= now)
        .map((job) => job.id);
      const seats = yield* Effect.forEach(reclaimed.seats, (candidate) => {
        const seat = rollSeatBudgetPeriod(candidate, budgetPeriod);
        if (seat.mode === "contributor") {
          return Effect.succeed<SeatRegistration>({
            ...seat,
            // An explicit unavailable heartbeat must remain unhealthy until a
            // healthy heartbeat arrives; a still-valid TTL only proves the
            // connection is alive, not that it can accept work.
            healthy:
              seat.healthy &&
              seat.healthExpiresAt !== undefined &&
              seat.healthExpiresAt > now,
          });
        }
        if (seat.healthExpiresAt !== undefined && seat.healthExpiresAt > now) {
          return Effect.succeed<SeatRegistration>(seat);
        }
        return probeHttpSeat(seat, this.env).pipe(
          Effect.map((healthy): SeatRegistration => ({
            ...seat,
            healthy,
            lastHealthAt: now,
            healthExpiresAt: healthy ? now + config.seatHeartbeatTtlSeconds : now,
          })),
        );
      }, { concurrency: 4 });
      yield* Effect.sync(() => this.setState({
        ...this.state,
        seats,
        seatBudgetReservations: reclaimed.reservations,
        contributorJobLedger,
      }));
      yield* Effect.sync(() => {
        for (const jobId of expiredJobIds) {
          const pending = this.contributorJobs.get(jobId);
          if (pending === undefined) continue;
          this.contributorJobs.delete(jobId);
          const timeout = timeoutContributorError(jobId);
          for (const resume of pending.resumes) resume(Effect.fail(timeout));
        }
      });
      return seats;
    }));
  }

  chargeSeatUsage(seatId: string, costUsd: number): Promise<SeatRegistration[]> {
    return Effect.runPromise(Effect.sync(() => {
      const seats = [...reconcileSeatBudgetState(
        this.state.seats,
        seatId,
        0,
        costUsd,
        utcBudgetPeriod(),
      )];
      this.setState({ ...this.state, seats });
      return seats;
    }));
  }

  reserveSeatBudget(
    seatId: string,
    amountUsd: number,
    reservationId?: string,
  ): Promise<{ readonly accepted: boolean; readonly seats: readonly SeatRegistration[] }> {
    return Effect.runPromise(Effect.sync(() => {
      const now = Date.now() / 1_000;
      const reclaimed = this.reclaimStaleReservations(this.state, now);
      const previous = reservationId === undefined
        ? undefined
        : reclaimed.reservations.find((item) => item.id === reservationId);
      if (previous !== undefined) {
        if (
          reclaimed.seats !== this.state.seats ||
          reclaimed.reservations !== this.state.seatBudgetReservations
        ) {
          this.setState({
            ...this.state,
            seats: reclaimed.seats,
            seatBudgetReservations: reclaimed.reservations,
          });
        }
        return {
          accepted:
            previous.status === "reserved" &&
            previous.seatId === seatId &&
            previous.amountUsd === amountUsd,
          seats: reclaimed.seats,
        };
      }
      const mutation = reserveSeatBudgetState(
        reclaimed.seats,
        seatId,
        amountUsd,
        utcBudgetPeriod(),
      );
      const reservations = reservationId === undefined || !mutation.accepted
        ? reclaimed.reservations
        : [
            ...reclaimed.reservations,
            {
              id: reservationId,
              seatId,
              amountUsd,
              actualCostUsd: 0,
              period: utcBudgetPeriod(),
              status: "reserved" as const,
              updatedAt: now,
            },
          ];
      this.setState({
        ...this.state,
        seats: mutation.seats,
        seatBudgetReservations: reservations,
      });
      return mutation;
    }));
  }

  reconcileSeatBudget(
    seatId: string,
    reservedAmountUsd: number,
    actualCostUsd: number,
    reservationId?: string,
  ): Promise<readonly SeatRegistration[]> {
    return Effect.runPromise(Effect.sync(() => {
      const now = Date.now() / 1_000;
      const reclaimed = this.reclaimStaleReservations(this.state, now);
      const previous = reservationId === undefined
        ? undefined
        : reclaimed.reservations.find((item) => item.id === reservationId);
      if (previous?.status === "settled") {
        if (
          reclaimed.seats !== this.state.seats ||
          reclaimed.reservations !== this.state.seatBudgetReservations
        ) {
          this.setState({
            ...this.state,
            seats: reclaimed.seats,
            seatBudgetReservations: reclaimed.reservations,
          });
        }
        return reclaimed.seats;
      }
      // A lease that was reclaimed has no live reservation to settle. Late
      // contributor usage is accounted separately when its result arrives;
      // never resurrect a timed-out reservation and charge it twice.
      if (reservationId !== undefined && previous === undefined) {
        this.setState({
          ...this.state,
          seats: reclaimed.seats,
          seatBudgetReservations: reclaimed.reservations,
        });
        return reclaimed.seats;
      }
      if (
        previous !== undefined &&
        (previous.seatId !== seatId || previous.amountUsd !== reservedAmountUsd)
      ) {
        if (
          reclaimed.seats !== this.state.seats ||
          reclaimed.reservations !== this.state.seatBudgetReservations
        ) {
          this.setState({
            ...this.state,
            seats: reclaimed.seats,
            seatBudgetReservations: reclaimed.reservations,
          });
        }
        return reclaimed.seats;
      }
      const seats = reconcileSeatBudgetState(
        reclaimed.seats,
        seatId,
        reservedAmountUsd,
        actualCostUsd,
        utcBudgetPeriod(),
      );
      const reservations = reservationId === undefined
        ? reclaimed.reservations
        : reclaimed.reservations.map((item) =>
            item.id === reservationId
              ? {
                  ...item,
                  actualCostUsd,
                  status: "settled" as const,
                  updatedAt: now,
                }
              : item);
      this.setState({ ...this.state, seats, seatBudgetReservations: reservations });
      return seats;
    }));
  }

  private reclaimStaleReservations(
    state: CommanderSessionState,
    nowSeconds: number,
  ): {
    readonly seats: readonly SeatRegistration[];
    readonly reservations: CommanderSessionState["seatBudgetReservations"];
  } {
    const stale = state.seatBudgetReservations.filter((reservation) =>
      reservation.status === "reserved" &&
      reservation.updatedAt + STALE_SEAT_RESERVATION_SECONDS <= nowSeconds);
    if (stale.length === 0) {
      return { seats: state.seats, reservations: state.seatBudgetReservations };
    }
    let seats = state.seats;
    for (const reservation of stale) {
      seats = reconcileSeatBudgetState(
        seats,
        reservation.seatId,
        reservation.amountUsd,
        0,
        utcBudgetPeriod(),
      );
    }
    const staleIds = new Set(stale.map((reservation) => reservation.id));
    return {
      seats,
      reservations: state.seatBudgetReservations.filter(
        (reservation) => !staleIds.has(reservation.id),
      ),
    };
  }

  private expireContributorJobs(
    state: CommanderSessionState,
    nowSeconds: number,
  ): CommanderSessionState["contributorJobLedger"] {
    return state.contributorJobLedger.map((job) =>
      job.status === "pending" && job.deadlineAt <= nowSeconds
        ? {
            ...job,
            status: "failed" as const,
            updatedAt: nowSeconds,
            error: `CONTRIBUTOR_TIMEOUT: Contributor job ${job.id} timed out`,
            retryable: true,
          }
        : job,
    );
  }

  private terminalizeContributorJob(
    jobId: string,
    failure: ContributorResultError,
    nowSeconds: number,
  ): void {
    const contributorJobLedger = this.state.contributorJobLedger.map((job) =>
      job.id === jobId && job.status === "pending"
        ? {
            ...job,
            status: "failed" as const,
            updatedAt: nowSeconds,
            error: `${failure.code}: ${failure.message}`,
            retryable: failure.retryable,
          }
        : job,
    );
    this.setState({ ...this.state, contributorJobLedger });
  }

  /**
   * A contributor can finish after its caller has timed out or disconnected.
   * Preserve that terminal fence, but bill the one late usage report exactly
   * once so reclaiming an abandoned reservation cannot erase real spend.
   */
  private accountLateContributorUsage(
    jobId: string,
    tokenUsage: { readonly input: number; readonly output: number },
    costUsd: number,
    resolvedModel: string | undefined,
    nowSeconds: number,
  ): void {
    const existing = this.state.contributorJobLedger.find((job) => job.id === jobId);
    if (
      existing === undefined ||
      existing.status !== "failed" ||
      existing.failureCostUsd !== undefined
    ) return;
    const normalizedCost = Math.max(0, costUsd);
    const seats = reconcileSeatBudgetState(
      this.state.seats,
      existing.seatId,
      0,
      normalizedCost,
      utcBudgetPeriod(),
    );
    const contributorJobLedger = this.state.contributorJobLedger.map((job) =>
      job.id !== jobId
        ? job
        : {
            ...job,
            status: "failed" as const,
            updatedAt: nowSeconds,
            error: job.error ?? "Late contributor result rejected after terminal failure",
            retryable: job.retryable ?? false,
            failureTokenUsage: tokenUsage,
            failureCostUsd: normalizedCost,
            ...(resolvedModel === undefined && job.resolvedModel === undefined
              ? {}
              : { resolvedModel: resolvedModel ?? job.resolvedModel }),
          });
    this.setState({ ...this.state, seats, contributorJobLedger });
  }

  markSeatUnhealthy(seatId: string): Promise<readonly SeatRegistration[]> {
    return Effect.runPromise(Effect.sync(() => {
      const seats = this.state.seats.map((seat): SeatRegistration =>
        seat.id === seatId
          ? { ...seat, healthy: false, healthExpiresAt: Date.now() / 1_000 }
          : seat);
      this.setState({ ...this.state, seats });
      return seats;
    }));
  }

  invokeContributor(
    seatId: string,
    tier: LlmTierAlias,
    prompt: string,
    timeoutSeconds: number,
    jobKey?: string,
    leaseId?: string,
  ): Promise<AiDecisionResult> {
    return Effect.runPromise(Effect.gen({ self: this }, function*() {
      const jobId = jobKey === undefined
        ? `job_${crypto.randomUUID()}`
        : contributorJobId(seatId, jobKey);
      const persisted = this.state.contributorJobLedger.find((item) => item.id === jobId);
      const durableLeaseId = leaseId ?? persisted?.leaseId ?? jobId;
      if (
        persisted !== undefined &&
        (
          persisted.seatId !== seatId ||
          persisted.tier !== tier ||
          persisted.prompt !== prompt ||
          (leaseId !== undefined && persisted.leaseId !== undefined &&
            persisted.leaseId !== leaseId)
        )
      ) {
        return yield* Effect.fail(new ContributorResultError({
          code: "CONTRIBUTOR_JOB_MISMATCH",
          message: `Contributor job ${jobId} does not match its original seat, tier, or prompt`,
          retryable: false,
        }));
      }
      if (persisted?.status === "succeeded" && persisted.result !== undefined) {
        return persisted.result;
      }
      if (persisted?.status === "failed") {
        return yield* Effect.fail(new ContributorResultError({
          code: "PERSISTED_CONTRIBUTOR_FAILURE",
          message: persisted.error ?? "Contributor job failed",
          retryable: persisted.retryable ?? false,
          ...(persisted.failureTokenUsage === undefined
            ? {}
            : { tokenUsage: persisted.failureTokenUsage }),
          ...(persisted.failureCostUsd === undefined
            ? {}
            : { costUsd: persisted.failureCostUsd }),
          ...(persisted.resolvedModel === undefined
            ? {}
            : { resolvedModel: persisted.resolvedModel }),
        }));
      }
      const now = yield* Clock.currentTimeMillis;
      const nowSeconds = now / 1_000;
      if (persisted?.status === "pending" && persisted.deadlineAt <= nowSeconds) {
        const timeout = timeoutContributorError(jobId);
        yield* Effect.sync(() => this.terminalizeContributorJob(jobId, timeout, nowSeconds));
        return yield* Effect.fail(timeout);
      }
      const seat = this.state.seats.find((item) =>
        item.id === seatId && item.mode === "contributor");
      if (seat === undefined || !seat.healthy || seat.exhausted) {
        return yield* Effect.fail(new Error(`Contributor seat ${seatId} is unavailable`));
      }
      if (seat.healthExpiresAt === undefined || seat.healthExpiresAt <= now / 1_000) {
        return yield* Effect.fail(new Error(`Contributor seat ${seatId} heartbeat expired`));
      }
      const connection = [...this.getConnections<SeatConnectionState>()]
        .find((candidate) =>
          candidate.id === seat.activeConnectionId &&
          candidate.state?.seatId === seatId);
      if (connection === undefined) {
        return yield* Effect.fail(new Error(`Contributor seat ${seatId} is disconnected`));
      }
      const deadlineAt = persisted?.deadlineAt ?? nowSeconds + timeoutSeconds;
      const jobPrompt = prompt;
      const remainingTimeoutSeconds = Math.max(1, Math.ceil(deadlineAt - nowSeconds));
      const pendingRecord = {
        id: jobId,
        leaseId: durableLeaseId,
        seatId,
        tier,
        prompt: jobPrompt,
        deadlineAt,
        status: "pending" as const,
        updatedAt: nowSeconds,
      };
      yield* Effect.sync(() => this.setState({
        ...this.state,
        contributorJobLedger: [
          ...this.state.contributorJobLedger.filter((item) => item.id !== jobId),
          pendingRecord,
        ],
        seatBudgetReservations: this.state.seatBudgetReservations.map((reservation) =>
          reservation.id === durableLeaseId
            ? { ...reservation, jobId }
            : reservation),
      }));
      const disposeKeepAlive = yield* Effect.tryPromise({
        try: () => this.keepAlive(),
        catch: (cause) => new Error("Could not retain contributor job", { cause }),
      });
      const awaiting = Effect.callback<AiDecisionResult, Error>((resume) => {
        const existing = this.contributorJobs.get(jobId);
        if (existing === undefined) {
          this.contributorJobs.set(jobId, {
            seatId,
            tier,
            leaseId: durableLeaseId,
            resumes: new Set([resume]),
          });
        } else {
          existing.resumes.add(resume);
        }
        return Effect.sync(() => {
          const current = this.contributorJobs.get(jobId);
          current?.resumes.delete(resume);
          if (current?.resumes.size === 0) this.contributorJobs.delete(jobId);
        });
      }).pipe(
        Effect.timeoutOrElse({
          duration: `${remainingTimeoutSeconds} seconds`,
          orElse: () => {
            const timeout = timeoutContributorError(jobId);
            return Effect.sync(() => this.terminalizeContributorJob(
              jobId,
              timeout,
              Date.now() / 1_000,
            )).pipe(Effect.andThen(Effect.fail(timeout)));
          },
        }),
        Effect.ensuring(Effect.sync(() => {
          disposeKeepAlive();
        })),
      );
      yield* Effect.sync(() => connection.send(seatMessage({
        protocol_version: 1,
        type: "invoke",
        job_id: jobId,
        seat_id: seatId,
        deadline_at: new Date(deadlineAt * 1_000).toISOString(),
        invocation: {
          tier,
          model: tier,
          dialect: seat.provider === "claude" ? "anthropic-messages" : "openai-responses",
          prompt: jobPrompt,
          response_format: "stavka-decision-v1",
        },
      })));
      return yield* awaiting;
    }));
  }

  /**
   * RPC-safe contributor boundary. Known provider failures cross the Durable
   * Object boundary as data, preserving retryability and measured usage rather
   * than relying on Error subclass serialization.
   */
  async invokeContributorOutcome(
    seatId: string,
    tier: LlmTierAlias,
    prompt: string,
    timeoutSeconds: number,
    jobKey?: string,
    leaseId?: string,
  ): Promise<ContributorInvocationOutcome> {
    try {
      return { ok: true, result: await this.invokeContributor(
        seatId,
        tier,
        prompt,
        timeoutSeconds,
        jobKey,
        leaseId,
      ) };
    } catch (cause) {
      return { ok: false, failure: contributorInvocationFailure(cause) };
    }
  }

  private handleSeatMessage(
    connection: Connection,
    raw: WSMessage,
  ): Effect.Effect<void, unknown> {
    return Effect.gen({ self: this }, function*() {
      if (this.name !== SEAT_REGISTRY_NAME) return;
      const message = yield* Schema.decodeUnknownEffect(
        Schema.fromJsonString(LlmContributorClientMessage),
      )(wsText(raw));
      const state = connection.state as SeatConnectionState | null;
      if (state?.channel !== "seat") {
        return yield* Effect.fail(new Error("Seat connection is not authenticated"));
      }
      const config = yield* readConfigEffect(this.env);
      const now = (yield* Clock.currentTimeMillis) / 1_000;
      const budgetPeriod = utcBudgetPeriod(now * 1_000);

      if (message.type === "register") {
        if (state.authorizedSeatId !== "*" && state.authorizedSeatId !== message.seat.id) {
          return yield* Effect.fail(new Error("Seat credential is not valid for this seat id"));
        }
        const previous = this.state.seats.find((item) => item.id === message.seat.id);
        const seat = rollSeatBudgetPeriod({
          ...message.seat,
          healthy: true,
          exhausted: false,
          registeredAt: previous?.registeredAt ?? new Date(now * 1_000).toISOString(),
          spentUsd: previous?.spentUsd ?? 0,
          reservedUsd: previous?.reservedUsd ?? 0,
          budgetPeriod: previous?.budgetPeriod ?? budgetPeriod,
          lastHealthAt: now,
          healthExpiresAt: now + config.seatHeartbeatTtlSeconds,
          activeConnectionId: connection.id,
        } satisfies SeatRegistration, budgetPeriod);
        const seats = [...this.state.seats.filter((item) => item.id !== seat.id), seat]
          .sort((left, right) => right.priority - left.priority);
        yield* Effect.sync(() => {
          connection.setState({ ...state, seatId: seat.id } satisfies SeatConnectionState);
          this.setState({ ...this.state, seats });
          for (const candidate of this.getConnections<SeatConnectionState>()) {
            if (
              candidate.id !== connection.id &&
              candidate.state?.seatId === seat.id
            ) candidate.close(1008, "Seat connection replaced");
          }
          connection.send(seatMessage({
            protocol_version: 1,
            type: "registered",
            seat_id: seat.id,
            heartbeat_ttl_seconds: config.seatHeartbeatTtlSeconds,
          }));
        });
        return;
      }

      if (state.seatId === undefined || state.seatId !== message.seat_id) {
        return yield* Effect.fail(new Error("Seat must register before sending messages"));
      }
      if (!isActiveSeatConnection(this.state.seats, state.seatId, connection.id)) {
        return yield* Effect.fail(new Error("Seat connection has been replaced"));
      }

      if (message.type === "heartbeat") {
        const seats = this.state.seats.map((seat): SeatRegistration =>
          seat.id !== message.seat_id
            ? seat
            : {
                ...seat,
                healthy: message.status === "healthy",
                exhausted:
                  // A healthy heartbeat says the connection is alive. It must
                  // not clear an exhaustion fence; only budget reconciliation
                  // or a new UTC period can make the seat eligible again.
                  seat.exhausted ||
                  seat.spentUsd + seat.reservedUsd >= seat.monthlyBudgetUsd ||
                  message.status === "exhausted",
                lastHealthAt: now,
                healthExpiresAt: now + config.seatHeartbeatTtlSeconds,
                ...(message.active === undefined ? {} : { active: message.active }),
                ...(message.queue_depth === undefined
                  ? {}
                  : { queueDepth: message.queue_depth }),
              });
        yield* Effect.sync(() => {
          this.setState({ ...this.state, seats });
          connection.send(seatMessage({
            protocol_version: 1,
            type: "heartbeat_ack",
            seat_id: message.seat_id,
            expires_at: new Date(
              (now + config.seatHeartbeatTtlSeconds) * 1_000,
            ).toISOString(),
          }));
        });
        return;
      }

      let liveJob = this.contributorJobs.get(message.job_id);
      let persistedJob = this.state.contributorJobLedger.find(
        (item) => item.id === message.job_id,
      );
      // A restart has no in-memory timer for jobs that were pending when the
      // object hibernated. Enforce the persisted deadline before accepting a
      // late result, then account for reported usage below without reviving it.
      if (persistedJob?.status === "pending" && persistedJob.deadlineAt <= now) {
        const timeout = timeoutContributorError(message.job_id);
        yield* Effect.sync(() => {
          this.terminalizeContributorJob(message.job_id, timeout, now);
          const pending = this.contributorJobs.get(message.job_id);
          this.contributorJobs.delete(message.job_id);
          for (const resume of pending?.resumes ?? []) resume(Effect.fail(timeout));
        });
        liveJob = undefined;
        persistedJob = this.state.contributorJobLedger.find(
          (item) => item.id === message.job_id,
        );
      }
      const jobSeatId = liveJob?.seatId ?? persistedJob?.seatId;
      const jobTier = liveJob?.tier ?? persistedJob?.tier;
      if (jobSeatId === undefined || jobTier === undefined) {
        yield* Effect.sync(() => connection.send(seatMessage({
          protocol_version: 1,
          type: "result_ack",
          job_id: message.job_id,
          accepted: false,
          duplicate: true,
        })));
        return;
      }
      if (jobSeatId !== message.seat_id) {
        return yield* Effect.fail(new Error("Contributor result seat does not match job"));
      }
      if (persistedJob !== undefined && persistedJob.status !== "pending") {
        if (liveJob !== undefined) {
          const terminal = persistedJob.status === "succeeded" && persistedJob.result !== undefined
            ? Effect.succeed(persistedJob.result)
            : Effect.fail(new ContributorResultError({
                code: "PERSISTED_CONTRIBUTOR_FAILURE",
                message: persistedJob.error ?? "Contributor job already terminated",
                retryable: persistedJob.retryable ?? false,
                ...(persistedJob.failureTokenUsage === undefined
                  ? {}
                  : { tokenUsage: persistedJob.failureTokenUsage }),
                ...(persistedJob.failureCostUsd === undefined
                  ? {}
                  : { costUsd: persistedJob.failureCostUsd }),
                ...(persistedJob.resolvedModel === undefined
                  ? {}
                  : { resolvedModel: persistedJob.resolvedModel }),
              }));
          yield* Effect.sync(() => {
            this.contributorJobs.delete(message.job_id);
            for (const resume of liveJob?.resumes ?? []) resume(terminal);
          });
          liveJob = undefined;
        }
        if (
          persistedJob.status === "failed" &&
          persistedJob.failureCostUsd === undefined &&
          message.usage !== undefined
        ) {
          const tokenUsage = {
            input: message.usage.input_tokens,
            output: message.usage.output_tokens,
          };
          const costUsd = message.usage.estimated_cost_usd ?? estimateCost(jobTier, tokenUsage);
          yield* Effect.sync(() => this.accountLateContributorUsage(
            message.job_id,
            tokenUsage,
            costUsd,
            message.resolved_model,
            now,
          ));
        }
        yield* Effect.sync(() => connection.send(seatMessage({
          protocol_version: 1,
          type: "result_ack",
          job_id: message.job_id,
          accepted: false,
          duplicate: true,
        })));
        return;
      }
      if (message.ok) {
        const tokenUsage = {
          input: message.usage.input_tokens,
          output: message.usage.output_tokens,
        };
        const costUsd = message.usage.estimated_cost_usd ?? estimateCost(
          jobTier,
          tokenUsage,
        );
        const decoded = yield* Effect.result(
          decodeContributorDecision(message.decision),
        );
        if (decoded._tag === "Failure") {
          const invalid = new ContributorResultError({
            code: "INVALID_DECISION",
            message: "Contributor returned an invalid decision",
            retryable: false,
            tokenUsage,
            costUsd,
            ...(message.resolved_model
              ? { resolvedModel: message.resolved_model }
              : {}),
          });
          yield* Effect.sync(() => {
            const updatedAt = Date.now() / 1_000;
            const contributorJobLedger = this.state.contributorJobLedger.map((item) =>
              item.id === message.job_id
                ? {
                    ...item,
                    status: "failed" as const,
                    updatedAt,
                    error: invalid.message,
                    retryable: false,
                    failureTokenUsage: tokenUsage,
                    failureCostUsd: costUsd,
                    ...(message.resolved_model
                      ? { resolvedModel: message.resolved_model }
                      : {}),
                  }
                : item);
            this.setState({ ...this.state, contributorJobLedger });
            this.contributorJobs.delete(message.job_id);
            for (const resume of liveJob?.resumes ?? []) resume(Effect.fail(invalid));
            connection.send(seatMessage({
              protocol_version: 1,
              type: "result_ack",
              job_id: message.job_id,
              accepted: false,
              duplicate: false,
            }));
          });
          return;
        }
        const decision = decoded.success;
        const result: AiDecisionResult = {
          decision,
          rawResponse: message.raw_response ?? JSON.stringify(message.decision),
          tokenUsage,
          costUsd,
          ...(message.resolved_model ? { resolvedModel: message.resolved_model } : {}),
        };
        yield* Effect.sync(() => {
          const updatedAt = Date.now() / 1_000;
          const contributorJobLedger = this.state.contributorJobLedger.map((item) =>
            item.id === message.job_id
              ? {
                  ...item,
                  status: "succeeded" as const,
                  updatedAt,
                  result,
                }
              : item);
          this.setState({ ...this.state, contributorJobLedger });
          this.contributorJobs.delete(message.job_id);
          for (const resume of liveJob?.resumes ?? []) resume(Effect.succeed(result));
        });
      } else {
        const tokenUsage = message.usage === undefined
          ? undefined
          : {
              input: message.usage.input_tokens,
              output: message.usage.output_tokens,
            };
        const costUsd = tokenUsage === undefined
          ? undefined
          : message.usage?.estimated_cost_usd ?? estimateCost(jobTier, tokenUsage);
        const failure = new ContributorResultError({
          code: message.code,
          message: message.message,
          retryable: message.retryable,
          ...(tokenUsage === undefined ? {} : { tokenUsage }),
          ...(costUsd === undefined ? {} : { costUsd }),
          ...(message.resolved_model === undefined
            ? {}
            : { resolvedModel: message.resolved_model }),
        });
        yield* Effect.sync(() => {
          const updatedAt = Date.now() / 1_000;
          const contributorJobLedger = this.state.contributorJobLedger.map((item) =>
            item.id === message.job_id
              ? {
                  ...item,
                  status: "failed" as const,
                  updatedAt,
                  error: `${message.code}: ${message.message}`,
                  retryable: message.retryable,
                  ...(tokenUsage === undefined ? {} : { failureTokenUsage: tokenUsage }),
                  ...(costUsd === undefined ? {} : { failureCostUsd: costUsd }),
                  ...(message.resolved_model === undefined
                    ? {}
                    : { resolvedModel: message.resolved_model }),
                }
              : item);
          const seats = message.exhausted
            ? this.state.seats.map((seat) =>
                seat.id === message.seat_id
                  ? { ...seat, healthy: false, exhausted: true }
                  : seat)
            : this.state.seats;
          this.setState({ ...this.state, seats, contributorJobLedger });
          this.contributorJobs.delete(message.job_id);
          for (const resume of liveJob?.resumes ?? []) resume(Effect.fail(failure));
        });
      }
      yield* Effect.sync(() => connection.send(seatMessage({
        protocol_version: 1,
        type: "result_ack",
        job_id: message.job_id,
        accepted: true,
        duplicate: false,
      })));
    });
  }

  private markConnectionUnavailable(connection: Connection): Effect.Effect<void> {
    return Effect.sync(() => {
      const state = connection.state as SeatConnectionState | null;
      if (this.name !== SEAT_REGISTRY_NAME || state?.seatId === undefined) return;
      if (!isActiveSeatConnection(this.state.seats, state.seatId, connection.id)) return;
      const seats = this.state.seats.map((seat): SeatRegistration => {
        if (seat.id !== state.seatId) return seat;
        const { activeConnectionId: _activeConnectionId, ...disconnected } = seat;
        return { ...disconnected, healthy: false };
      });
      const updatedAt = Date.now() / 1_000;
      const contributorJobLedger = this.state.contributorJobLedger.map((item) =>
        item.seatId === state.seatId && item.status === "pending"
          ? {
              ...item,
              status: "failed" as const,
              updatedAt,
              error: `Contributor seat ${state.seatId} disconnected`,
              retryable: true,
            }
          : item);
      this.setState({ ...this.state, seats, contributorJobLedger });
      for (const [jobId, job] of this.contributorJobs) {
        if (job.seatId !== state.seatId) continue;
        this.contributorJobs.delete(jobId);
        const failure = new ContributorResultError({
          code: "CONTRIBUTOR_DISCONNECTED",
          message: `Contributor seat ${state.seatId} disconnected`,
          retryable: true,
        });
        for (const resume of job.resumes) resume(Effect.fail(failure));
      }
    });
  }

  exportSession(): Promise<SessionExport> {
    return Effect.runPromise(Effect.all({
      logs: this.decisionLogs().list(500),
      archive: this.sessionArchive().export(10_000),
      exportedAt: Clock.currentTimeMillis,
    }).pipe(Effect.map(({ archive, exportedAt, logs }): SessionExport => {
      const state = this.state;
      const header = sessionExportHeader(state, exportedAt);
      return {
        ...header,
        logs: [...logs].reverse(),
        archive: {
          ticks: archive.ticks,
          events: archive.events,
          snapshots: archive.snapshots,
        },
      };
    })));
  }

  persistSessionExport(exportId?: string): Promise<SessionExportMetadata> {
    return Effect.runPromise(Effect.gen({ self: this }, function*() {
      const bucket = this.env.SESSION_EXPORTS;
      if (bucket === undefined) {
        return yield* Effect.fail(new Error("SESSION_EXPORTS R2 binding is not configured"));
      }
      const exportedAt = yield* Clock.currentTimeMillis;
      const state = this.state;
      const header = sessionExportHeader(state, exportedAt);
      const options = exportId === undefined
        ? { exportedAt }
        : { exportedAt, id: exportId };
      const decisionLogs = this.decisionLogs();
      const sessionArchive = this.sessionArchive();
      const repository = new R2SessionExportRepository(bucket);
      const pageSize = 25;
      const [logSnapshot, archiveSnapshot] = yield* Effect.all([
        decisionLogs.exportSnapshot,
        sessionArchive.exportSnapshot,
      ] as const);
      const pageCount = Math.ceil(Math.max(
        logSnapshot.count,
        archiveSnapshot.counts.ticks,
        archiveSnapshot.counts.events,
        archiveSnapshot.counts.snapshots,
      ) / pageSize);
      const begun = yield* repository.begin(header, options, pageCount);
      if (begun._tag === "published") return begun.metadata;
      if (pageCount === 0) return yield* repository.complete(begun.lease, []);

      let logCursor = initialDecisionLogExportCursor();
      let archiveCursor = initialSessionArchiveExportCursor();
      const descriptors: SessionExportPageDescriptor[] = [];
      for (
        let index = 0;
        !logCursor.done ||
        !archiveCursor.ticks.done ||
        !archiveCursor.events.done ||
        !archiveCursor.snapshots.done;
        index += 1
      ) {
        const loaded = yield* Effect.all({
          logs: decisionLogs.pageFromSnapshot(logSnapshot, logCursor, pageSize),
          archive: sessionArchive.pageFromSnapshot(archiveSnapshot, archiveCursor, pageSize),
        });
        logCursor = loaded.logs.cursor;
        archiveCursor = loaded.archive.cursor;
        descriptors.push(yield* repository.writePage(begun.lease, index, {
          logs: loaded.logs.entries,
          ticks: loaded.archive.archive.ticks,
          events: loaded.archive.archive.events,
          snapshots: loaded.archive.archive.snapshots,
        }));
      }
      return yield* repository.complete(begun.lease, descriptors);
    }));
  }

  private response(
    commands: readonly Command[],
    requestFullSnapshot: boolean,
    state: CommanderSessionState,
    tickRateHint: number,
  ): TickResponse {
    const lastDecision = state.recentLogs.at(-1);
    return {
      protocol_version: 1,
      tick_id: state.lastTickId,
      commands: [...commands],
      tick_rate_hint: tickRateHint,
      request_full_snapshot: requestFullSnapshot,
      config_updates: {},
      commander_status: {
        connected: state.connected,
        mode: state.mode,
        doctrine: state.doctrine,
        decision_pending: state.decisionPending,
        active_groups: state.snapshot?.friendly_groups.length ?? 0,
        cost_aggregates: [...state.costAggregates],
        ...(lastDecision === undefined
          ? {}
          : {
              last_decision: {
                id: lastDecision.id,
                timestamp: lastDecision.timestamp,
                summary: lastDecision.output.summary,
                model: lastDecision.model,
                latency_ms: lastDecision.latencyMs,
                cost_usd: lastDecision.costUsd,
              },
            }),
      },
    };
  }

  private decisionLogs(): SqlDecisionLogRepository {
    return new SqlDecisionLogRepository(this);
  }

  private sessionArchive(): SqlSessionArchiveRepository {
    return new SqlSessionArchiveRepository(this);
  }
}
