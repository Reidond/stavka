import {
  Command,
  CommanderCostAggregate,
  CommandResult,
  GameEvent,
  GameSnapshot,
  LlmApiSeatRegistrationRequest,
  LlmContainerSeatRegistrationRequest,
  LlmContributorSeatRegistrationRequest,
  LlmSeatRegistrationRequest,
  MapBriefing,
  SergeantReport,
  TickResponse,
  DoctrineId,
  type DoctrineId as DoctrineIdType,
} from "@stavka/protocol";
import { Schema } from "effect";

import { AiDecisionResult } from "../brain/llm-client";
import { DecisionLogEntry } from "../logging/types";

const SeatHealthFields = {
  healthy: Schema.Boolean,
  exhausted: Schema.Boolean,
  registeredAt: Schema.String,
  spentUsd: Schema.Number,
  reservedUsd: Schema.Number,
  budgetPeriod: Schema.String,
  lastHealthAt: Schema.optional(Schema.Number),
  healthExpiresAt: Schema.optional(Schema.Number),
  active: Schema.optional(Schema.Number),
  queueDepth: Schema.optional(Schema.Number),
  activeConnectionId: Schema.optional(Schema.String),
};

export const SeatRegistrationSchema = Schema.Union([
  Schema.Struct({ ...LlmContainerSeatRegistrationRequest.fields, ...SeatHealthFields }),
  Schema.Struct({ ...LlmContributorSeatRegistrationRequest.fields, ...SeatHealthFields }),
  Schema.Struct({ ...LlmApiSeatRegistrationRequest.fields, ...SeatHealthFields }),
]);

export type SeatRegistration = LlmSeatRegistrationRequest & {
  readonly healthy: boolean;
  readonly exhausted: boolean;
  readonly registeredAt: string;
  readonly spentUsd: number;
  readonly reservedUsd: number;
  readonly budgetPeriod: string;
  readonly lastHealthAt?: number;
  readonly healthExpiresAt?: number;
  readonly active?: number;
  readonly queueDepth?: number;
  readonly activeConnectionId?: string;
};

export interface SeatBudgetReservationRecord {
  readonly id: string;
  /** Durable contributor job that owns this lease, when the reservation is remote work. */
  readonly jobId?: string;
  readonly seatId: string;
  readonly amountUsd: number;
  readonly actualCostUsd: number;
  readonly period: string;
  readonly status: "reserved" | "settled";
  readonly updatedAt: number;
}

export interface ContributorJobRecord {
  readonly id: string;
  /** The matching seat-budget reservation id; persisted across reconnect/retry. */
  readonly leaseId?: string;
  readonly seatId: string;
  readonly tier: "stavka/commander" | "stavka/sergeant" | "stavka/heavy";
  readonly prompt: string;
  readonly deadlineAt: number;
  readonly status: "pending" | "succeeded" | "failed";
  readonly updatedAt: number;
  readonly result?: typeof AiDecisionResult.Type;
  readonly error?: string;
  readonly retryable?: boolean;
  readonly failureTokenUsage?: { readonly input: number; readonly output: number };
  readonly failureCostUsd?: number;
  readonly resolvedModel?: string;
}

export interface ShortTermDecision {
  readonly timestamp: number;
  readonly summary: string;
}

export interface CommandOutcome {
  readonly timestamp: number;
  readonly result: CommandResult;
}

export interface ObservationSummary {
  readonly timestamp: number;
  readonly kind: "event" | "report";
  readonly key: string;
  readonly count: number;
  readonly summary: string;
}

export interface CommanderMemory {
  readonly working: {
    readonly snapshot?: GameSnapshot;
    readonly pendingCommandIds: readonly string[];
  };
  readonly shortTerm: {
    readonly events: readonly GameEvent[];
    readonly reports: readonly SergeantReport[];
    readonly summaries: readonly ObservationSummary[];
    readonly decisions: readonly ShortTermDecision[];
    readonly outcomes: readonly CommandOutcome[];
  };
  readonly longTerm: {
    readonly decisionCount: number;
    readonly eventCount: number;
    readonly snapshotCount: number;
  };
}

export interface DifficultyState {
  readonly configured: number;
  readonly effective: number;
  readonly playerPerformance: number;
  readonly objectiveMomentum: number;
}

export interface BudgetState {
  readonly manpower: number;
  readonly vehiclePool: number;
  readonly reinforcementReadyAt: number;
  readonly maxActiveUnits: number;
  readonly lastUpdatedAt: number;
  readonly reportedManpower?: number;
  readonly reportedVehiclePool?: number;
}

export interface CommanderSessionState {
  readonly version: 1;
  readonly connected: boolean;
  readonly sessionId: string;
  readonly faction: string;
  readonly missionEpoch: number;
  readonly lastTickId: number;
  readonly lastFullTickId: number;
  readonly lastDecisionAt: number;
  readonly decisionPending: boolean;
  readonly pendingDecisionTrigger?: string;
  readonly pendingDecisionVersion: number;
  readonly doctrine: DoctrineIdType;
  readonly mode: "rule" | "llm" | "degraded";
  readonly snapshot?: GameSnapshot;
  readonly mapBriefing?: MapBriefing;
  readonly pendingCommands: readonly Command[];
  readonly memory: CommanderMemory;
  readonly recentLogs: readonly DecisionLogEntry[];
  readonly nextDecisionSequence: number;
  readonly nextCommandSequence: number;
  readonly difficulty: DifficultyState;
  readonly budget: BudgetState;
  readonly seats: readonly SeatRegistration[];
  readonly sergeantGroupIds: readonly string[];
  readonly seatBudgetReservations: readonly SeatBudgetReservationRecord[];
  readonly contributorJobLedger: readonly ContributorJobRecord[];
  readonly processedSergeantAssessmentIds: readonly string[];
  readonly costAggregates: readonly typeof CommanderCostAggregate.Type[];
  readonly disconnectedAt?: number;
  readonly lastTickResponse?: TickResponse;
}

const ShortTermDecisionSchema = Schema.Struct({
  timestamp: Schema.Number,
  summary: Schema.String,
});

const CommandOutcomeSchema = Schema.Struct({
  timestamp: Schema.Number,
  result: CommandResult,
});

const ObservationSummarySchema = Schema.Struct({
  timestamp: Schema.Number,
  kind: Schema.Literals(["event", "report"]),
  key: Schema.String,
  count: Schema.Number,
  summary: Schema.String,
});

const SeatBudgetReservationRecordSchema = Schema.Struct({
  id: Schema.String,
  jobId: Schema.optional(Schema.String),
  seatId: Schema.String,
  amountUsd: Schema.Number,
  actualCostUsd: Schema.Number,
  period: Schema.String,
  status: Schema.Literals(["reserved", "settled"]),
  updatedAt: Schema.Number,
});

const ContributorJobRecordSchema = Schema.Struct({
  id: Schema.String,
  leaseId: Schema.optional(Schema.String),
  seatId: Schema.String,
  tier: Schema.Literals(["stavka/commander", "stavka/sergeant", "stavka/heavy"]),
  prompt: Schema.String,
  deadlineAt: Schema.Number,
  status: Schema.Literals(["pending", "succeeded", "failed"]),
  updatedAt: Schema.Number,
  result: Schema.optional(AiDecisionResult),
  error: Schema.optional(Schema.String),
  retryable: Schema.optional(Schema.Boolean),
  failureTokenUsage: Schema.optional(Schema.Struct({
    input: Schema.Number,
    output: Schema.Number,
  })),
  failureCostUsd: Schema.optional(Schema.Number),
  resolvedModel: Schema.optional(Schema.String),
});

export const CommanderSessionStateSchema = Schema.Struct({
  version: Schema.Literal(1),
  connected: Schema.Boolean,
  sessionId: Schema.String,
  faction: Schema.String,
  missionEpoch: Schema.Number,
  lastTickId: Schema.Number,
  lastFullTickId: Schema.Number,
  lastDecisionAt: Schema.Number,
  decisionPending: Schema.Boolean,
  pendingDecisionTrigger: Schema.optional(Schema.String),
  pendingDecisionVersion: Schema.Number,
  doctrine: DoctrineId,
  mode: Schema.Literals(["rule", "llm", "degraded"]),
  snapshot: Schema.optional(GameSnapshot),
  mapBriefing: Schema.optional(MapBriefing),
  pendingCommands: Schema.Array(Command),
  memory: Schema.Struct({
    working: Schema.Struct({
      snapshot: Schema.optional(GameSnapshot),
      pendingCommandIds: Schema.Array(Schema.String),
    }),
    shortTerm: Schema.Struct({
      events: Schema.Array(GameEvent),
      reports: Schema.Array(SergeantReport),
      summaries: Schema.Array(ObservationSummarySchema),
      decisions: Schema.Array(ShortTermDecisionSchema),
      outcomes: Schema.Array(CommandOutcomeSchema),
    }),
    longTerm: Schema.Struct({
      decisionCount: Schema.Number,
      eventCount: Schema.Number,
      snapshotCount: Schema.Number,
    }),
  }),
  recentLogs: Schema.Array(DecisionLogEntry),
  nextDecisionSequence: Schema.Number,
  nextCommandSequence: Schema.Number,
  difficulty: Schema.Struct({
    configured: Schema.Number,
    effective: Schema.Number,
    playerPerformance: Schema.Number,
    objectiveMomentum: Schema.Number,
  }),
  budget: Schema.Struct({
    manpower: Schema.Number,
    vehiclePool: Schema.Number,
    reinforcementReadyAt: Schema.Number,
    maxActiveUnits: Schema.Number,
    lastUpdatedAt: Schema.Number,
    reportedManpower: Schema.optional(Schema.Number),
    reportedVehiclePool: Schema.optional(Schema.Number),
  }),
  seats: Schema.Array(SeatRegistrationSchema),
  sergeantGroupIds: Schema.Array(Schema.String),
  seatBudgetReservations: Schema.Array(SeatBudgetReservationRecordSchema),
  contributorJobLedger: Schema.Array(ContributorJobRecordSchema),
  processedSergeantAssessmentIds: Schema.Array(Schema.String),
  costAggregates: Schema.Array(CommanderCostAggregate),
  disconnectedAt: Schema.optional(Schema.Number),
  lastTickResponse: Schema.optional(TickResponse),
});

export const initialCommanderState = (): CommanderSessionState => ({
  version: 1,
  connected: false,
  sessionId: "",
  faction: "",
  missionEpoch: 0,
  lastTickId: 0,
  lastFullTickId: 0,
  lastDecisionAt: 0,
  decisionPending: false,
  pendingDecisionVersion: 0,
  doctrine: "balanced",
  mode: "rule",
  pendingCommands: [],
  memory: {
    working: { pendingCommandIds: [] },
    shortTerm: { events: [], reports: [], summaries: [], decisions: [], outcomes: [] },
    longTerm: { decisionCount: 0, eventCount: 0, snapshotCount: 0 },
  },
  recentLogs: [],
  nextDecisionSequence: 1,
  nextCommandSequence: 1,
  difficulty: {
    configured: 0.5,
    effective: 0.5,
    playerPerformance: 0,
    objectiveMomentum: 0,
  },
  budget: {
    manpower: 150,
    vehiclePool: 5,
    reinforcementReadyAt: 0,
    maxActiveUnits: 50,
    lastUpdatedAt: 0,
  },
  seats: [],
  sergeantGroupIds: [],
  seatBudgetReservations: [],
  contributorJobLedger: [],
  processedSergeantAssessmentIds: [],
  costAggregates: [],
});
