import { Agent, type FiberRecoveryContext } from "agents";
import type { Command, GameSnapshot, SergeantReport } from "@stavka/protocol";
import { Clock, Effect } from "effect";

import {
  materializeCommandProposals,
  reassignCommandIds,
} from "../brain/command-validator";
import type { AiCommandProposal } from "../brain/llm-client";
import { sergeantPrompt } from "../brain/prompts";
import { planSergeantRules } from "../brain/rule-commander";
import {
  reportedSeatFailureUsage,
  resolveLlmRoute,
  routedFailureCostAttributions,
  runRoutedAiDecision,
  type RoutedAiCostAttribution,
} from "../brain/seat-router";
import { readConfigEffect, type CommanderConfig, type Env } from "../config";
import { SqlDecisionLogRepository } from "../logging/decision-log-repository";
import type { DecisionLogEntry } from "../logging/types";
import type { SeatRegistration } from "../state/types";

const MAX_COMMANDS_PER_ASSESSMENT = 3;

interface SergeantWork {
  readonly version: number;
  readonly decisionSequence: number;
  readonly commandStartSequence: number;
  readonly attempt: number;
  readonly report: SergeantReport;
  readonly snapshot: GameSnapshot | null;
  readonly seats: readonly SeatRegistration[];
  /** Retained until the parent durably archives and acknowledges this result. */
  readonly completedAssessment?: SergeantAssessment;
}

interface SergeantState {
  readonly groupId: string;
  readonly reportsHandled: number;
  readonly nextDecisionSequence: number;
  readonly nextCommandSequence: number;
  readonly lastReportAt: number;
  readonly lastDecision: readonly Command[];
  readonly nextWorkSequence: number;
  readonly pendingWorkQueue: readonly SergeantWork[];
  readonly completedAssessments: readonly SergeantAssessment[];
}

export interface SergeantAssessment {
  readonly commands: readonly Command[];
  readonly log: DecisionLogEntry;
  readonly seatId?: string;
  readonly costAttributions?: readonly RoutedAiCostAttribution[];
  readonly summary: string;
  readonly timestamp: number;
}

export const scopedSergeantSnapshot = (
  snapshot: GameSnapshot | undefined,
  report: SergeantReport,
): GameSnapshot | undefined => {
  if (snapshot === undefined) return undefined;
  const [x, , z] = report.payload.position;
  const objectives = [...snapshot.objectives]
    .sort((left, right) => {
      const leftDistance = (left.position[0] - x) ** 2 + (left.position[2] - z) ** 2;
      const rightDistance = (right.position[0] - x) ** 2 + (right.position[2] - z) ** 2;
      return leftDistance - rightDistance;
    })
    .slice(0, 3);
  return {
    ...snapshot,
    friendly_groups: snapshot.friendly_groups.filter(
      (group) => group.id === report.payload.group_id,
    ),
    known_enemies: snapshot.known_enemies.filter(
      (enemy) => enemy.reported_by === report.payload.group_id,
    ),
    objectives,
  };
};

const tacticalCommand = (
  command: Command,
  groupId: string,
  snapshot: GameSnapshot | undefined,
): boolean => {
  if (
    command.type === "spawn_group" ||
    command.type === "despawn_group" ||
    command.type === "set_objective"
  ) return false;
  if (command.params.group_id !== groupId) return false;
  return snapshot === undefined || snapshot.friendly_groups.some((group) => group.id === groupId);
};

const normalizedCommands = (
  commands: readonly AiCommandProposal[],
  report: SergeantReport,
  snapshot: GameSnapshot | undefined,
  startSequence: number,
): Command[] => materializeCommandProposals(
  commands,
  startSequence,
  `sgt_${report.payload.group_id}_`,
)
  .filter((command) => tacticalCommand(command, report.payload.group_id, snapshot))
  .slice(0, 3);

const assessWithModel = (
  report: SergeantReport,
  snapshot: GameSnapshot | undefined,
  config: CommanderConfig,
  seats: readonly SeatRegistration[],
  env: Env,
  startSequence: number,
): Effect.Effect<{
  readonly commands: readonly Command[];
  readonly summary: string;
  readonly rawResponse: string;
  readonly mode: "rule" | "llm" | "degraded";
  readonly latencyMs: number;
  readonly tokenUsage: { readonly input: number; readonly output: number };
  readonly costUsd: number;
  readonly commandSequenceAdvance: number;
  readonly fallback: boolean;
  readonly stretched: boolean;
  readonly seatId?: string;
  readonly resolvedModel?: string;
  readonly costAttributions?: readonly RoutedAiCostAttribution[];
}> => Effect.gen(function*() {
  const rawRules = planSergeantRules(report, snapshot);
  const rules = reassignCommandIds(
    rawRules,
    startSequence,
    `sgt_${report.payload.group_id}_`,
  );
  const route = resolveLlmRoute(seats, config, config.sergeantModel);
  if (route.stretched) {
    return {
      commands: rules,
      summary: "Seat budget exhausted; retained tactical rules at stretched cadence.",
      rawResponse: "",
      mode: "degraded" as const,
      latencyMs: 0,
      tokenUsage: { input: 0, output: 0 },
      costUsd: 0,
      commandSequenceAdvance: rules.length,
      fallback: false,
      stretched: true,
    };
  }
  if (route.config.aiProvider === "mock") {
    return {
      commands: rules,
      summary: `Rule sergeant assessed ${report.payload.report_type}.`,
      rawResponse: JSON.stringify({ commands: rules }),
      mode: "rule" as const,
      latencyMs: 0,
      tokenUsage: { input: 0, output: 0 },
      costUsd: 0,
      commandSequenceAdvance: rules.length,
      fallback: route.fallback,
      stretched: false,
    };
  }
  const prompt = sergeantPrompt(report.payload.group_id, report, snapshot);
  const started = yield* Clock.currentTimeMillis;
  const result = yield* Effect.result(
    runRoutedAiDecision(
      env,
      seats,
      config,
      config.sergeantModel,
      prompt,
      `sergeant:${report.payload.group_id}:${startSequence}:${report.timestamp}`,
    ),
  );
  const finished = yield* Clock.currentTimeMillis;
  if (result._tag === "Success") {
    const commands = normalizedCommands(
      result.success.decision.commands,
      report,
      snapshot,
      startSequence,
    );
    return {
      commands,
      summary: result.success.decision.summary,
      rawResponse: result.success.rawResponse || JSON.stringify(result.success.decision),
      mode: "llm" as const,
      latencyMs: finished - started,
      tokenUsage: result.success.tokenUsage,
      costUsd: result.success.costUsd,
      commandSequenceAdvance: commands.length,
      fallback: result.success.fallback,
      stretched: false,
      ...(result.success.seatId ? { seatId: result.success.seatId } : {}),
      ...(result.success.resolvedModel
        ? { resolvedModel: result.success.resolvedModel }
        : {}),
      ...(result.success.costAttributions === undefined
        ? {}
        : { costAttributions: result.success.costAttributions }),
    };
  }
  const reported = reportedSeatFailureUsage(result.failure);
  const failureAttributions = routedFailureCostAttributions(result.failure);
  return {
    commands: rules,
    summary: `Degraded to tactical rules: ${
      result.failure instanceof Error ? result.failure.message : "LLM failure"
    }`,
    rawResponse: "",
    mode: "degraded" as const,
    latencyMs: finished - started,
    tokenUsage: reported.tokenUsage,
    costUsd: reported.costUsd,
    commandSequenceAdvance: rules.length,
    fallback: route.fallback,
    stretched: false,
    ...(reported.resolvedModel ? { resolvedModel: reported.resolvedModel } : {}),
    ...(failureAttributions.length === 0
      ? {}
      : { costAttributions: failureAttributions }),
  };
});

export class SergeantAgent extends Agent<Env, SergeantState> {
  override initialState: SergeantState = {
    groupId: "",
    reportsHandled: 0,
    nextDecisionSequence: 1,
    nextCommandSequence: 1,
    lastReportAt: 0,
    lastDecision: [],
    nextWorkSequence: 1,
    pendingWorkQueue: [],
    completedAssessments: [],
  };

  override onStart(): Promise<void> {
    return Effect.runPromise(this.decisionLogs().initialize.pipe(
      Effect.andThen(this.recoverPendingWork()),
    ));
  }

  override onFiberRecovered(context: FiberRecoveryContext): Promise<void> {
    if (context.name !== "sergeant-assessment") return Promise.resolve();
    const snapshot = context.snapshot;
    const version = typeof snapshot === "object" && snapshot !== null &&
      typeof (snapshot as Record<string, unknown>).version === "number"
      ? (snapshot as { readonly version: number }).version
      : undefined;
    if (version === undefined) return Promise.resolve();
    return Effect.runPromise(Effect.gen({ self: this }, function*() {
      const work = this.state.pendingWorkQueue.find((candidate) =>
        candidate.version === version && candidate.completedAssessment === undefined);
      if (work === undefined) return;
      const retry = yield* Effect.sync(() => this.retryWork(work));
      if (retry !== undefined) yield* this.launchWork(retry);
    }));
  }

  assess(
    report: SergeantReport,
    snapshot?: GameSnapshot,
    seats: readonly SeatRegistration[] = [],
  ): Promise<SergeantAssessment> {
    return Effect.runPromise(this.assessmentEffect(report, snapshot, seats));
  }

  queueAssessment(
    report: SergeantReport,
    snapshot?: GameSnapshot,
    seats: readonly SeatRegistration[] = [],
  ): Promise<void> {
    return Effect.runPromise(Effect.gen({ self: this }, function*() {
      const state = this.state;
      const version = state.nextWorkSequence;
      const work: SergeantWork = {
        version,
        decisionSequence: state.nextDecisionSequence,
        commandStartSequence: state.nextCommandSequence,
        attempt: 1,
        report,
        snapshot: snapshot ?? null,
        seats,
      };
      yield* Effect.sync(() => this.setState({
        ...state,
        nextWorkSequence: version + 1,
        // Each durable task gets its own id range before it starts. Fibers can
        // run concurrently, so allocating sequences only after an LLM await
        // would duplicate decision/command ids.
        nextDecisionSequence: state.nextDecisionSequence + 1,
        nextCommandSequence: state.nextCommandSequence + MAX_COMMANDS_PER_ASSESSMENT,
        pendingWorkQueue: [
          ...state.pendingWorkQueue,
          work,
        ],
      }));
      // startFiber returns after durable acceptance, while the actual LLM
      // work runs independently of the parent alarm. If acceptance itself
      // fails, the persisted work remains for onStart/fiber recovery.
      yield* this.launchWork(work);
    }));
  }

  runScheduledAssessment(payload: { readonly version: number }): Promise<void> {
    // Compatibility for pre-fiber schedule rows. Do not perform the model
    // work inline behind the parent alarm; hand it to the child fiber instead.
    return Effect.runPromise(Effect.gen({ self: this }, function*() {
      const work = this.state.pendingWorkQueue.find(
        (candidate) => candidate.version === payload.version &&
          candidate.completedAssessment === undefined,
      );
      if (work === undefined) return;
      yield* this.launchWork(work);
    }));
  }

  listCompletedAssessments(): Promise<readonly SergeantAssessment[]> {
    return Effect.runPromise(Effect.succeed(this.state.completedAssessments));
  }

  acknowledgeAssessments(ids: readonly string[]): Promise<void> {
    return Effect.runPromise(Effect.sync(() => {
      const acknowledged = new Set(ids);
      this.setState({
        ...this.state,
        completedAssessments: this.state.completedAssessments.filter(
          (assessment) => !acknowledged.has(assessment.log.id),
        ),
        pendingWorkQueue: this.state.pendingWorkQueue.filter((work) =>
          work.completedAssessment === undefined ||
          !acknowledged.has(work.completedAssessment.log.id)),
      });
    }));
  }

  private recoverPendingWork(): Effect.Effect<void, Error> {
    return Effect.forEach(
      this.state.pendingWorkQueue.filter((work) => work.completedAssessment === undefined),
      (work) => this.launchWork(work).pipe(
        Effect.catch((cause) => Effect.logWarning(
          `Could not resume sergeant assessment ${work.version}: ${cause.message}`,
        )),
      ),
      { concurrency: 8 },
    ).pipe(Effect.asVoid);
  }

  private workKey(work: SergeantWork): string {
    return `sergeant:${this.name}:${work.version}:${work.attempt}`;
  }

  private launchWork(work: SergeantWork): Effect.Effect<void, Error> {
    return Effect.tryPromise({
      try: async () => {
        const receipt = await this.startFiber(
          "sergeant-assessment",
          async (fiber) => {
            fiber.stash({ version: work.version, attempt: work.attempt });
            await this.completeQueuedAssessment(work.version, work.attempt);
          },
          {
            idempotencyKey: this.workKey(work),
            metadata: { version: work.version, attempt: work.attempt },
          },
        );
        if (
          receipt.status !== "error" &&
          receipt.status !== "aborted" &&
          receipt.status !== "interrupted"
        ) return;
        const retry = this.retryWork(work);
        if (retry === undefined) return;
        await this.startFiber(
          "sergeant-assessment",
          async (fiber) => {
            fiber.stash({ version: retry.version, attempt: retry.attempt });
            await this.completeQueuedAssessment(retry.version, retry.attempt);
          },
          {
            idempotencyKey: this.workKey(retry),
            metadata: { version: retry.version, attempt: retry.attempt },
          },
        );
      },
      catch: (cause) => new Error("Could not durably start sergeant assessment", { cause }),
    }).pipe(Effect.asVoid);
  }

  private retryWork(work: SergeantWork): SergeantWork | undefined {
    const current = this.state.pendingWorkQueue.find((candidate) =>
      candidate.version === work.version &&
      candidate.attempt === work.attempt &&
      candidate.completedAssessment === undefined);
    if (current === undefined) return undefined;
    const retry = { ...current, attempt: current.attempt + 1 };
    this.setState({
      ...this.state,
      pendingWorkQueue: this.state.pendingWorkQueue.map((candidate) =>
        candidate.version === current.version ? retry : candidate),
    });
    return retry;
  }

  private completeQueuedAssessment(version: number, attempt: number): Promise<void> {
    return Effect.runPromise(Effect.gen({ self: this }, function*() {
      const work = this.state.pendingWorkQueue.find((candidate) =>
        candidate.version === version &&
        candidate.attempt === attempt &&
        candidate.completedAssessment === undefined);
      if (work === undefined) return;
      const assessment = yield* this.assessmentEffect(
        work.report,
        work.snapshot ?? undefined,
        work.seats,
        {
          decisionSequence: work.decisionSequence,
          commandStartSequence: work.commandStartSequence,
        },
      );
      yield* Effect.sync(() => {
        const latest = this.state;
        if (!latest.pendingWorkQueue.some((candidate) =>
          candidate.version === version &&
          candidate.attempt === attempt &&
          candidate.completedAssessment === undefined)) return;
        this.setState({
          ...latest,
          // A completed child is still delivery-pending. Keep its exact work
          // record until the parent has written its log/archive and sends a
          // named acknowledgement back to this sergeant.
          pendingWorkQueue: latest.pendingWorkQueue.map(
            (candidate) => candidate.version === version && candidate.attempt === attempt
              ? { ...candidate, completedAssessment: assessment }
              : candidate,
          ),
          completedAssessments: [
            ...latest.completedAssessments,
            assessment,
          ],
        });
      });
    }));
  }

  private assessmentEffect(
    report: SergeantReport,
    snapshot: GameSnapshot | undefined,
    seats: readonly SeatRegistration[],
    assigned?: {
      readonly decisionSequence: number;
      readonly commandStartSequence: number;
    },
  ): Effect.Effect<SergeantAssessment, unknown> {
    return Effect.gen({ self: this }, function*() {
      const config = yield* readConfigEffect(this.env);
      const decisionSequence = assigned?.decisionSequence ?? this.state.nextDecisionSequence;
      const commandStartSequence = assigned?.commandStartSequence ?? this.state.nextCommandSequence;
      const decision = yield* assessWithModel(
        report,
        snapshot,
        config,
        seats,
        this.env,
        commandStartSequence,
      );
      const prompt = sergeantPrompt(report.payload.group_id, report, snapshot);
      const log: DecisionLogEntry = {
        id: `sgt_${report.payload.group_id}_${String(decisionSequence).padStart(6, "0")}`,
        timestamp: new Date(report.timestamp * 1_000).toISOString(),
        agent: `sergeant:${report.payload.group_id}`,
        trigger: `report:${report.payload.report_type}`,
        input: {
          stateSnapshot: snapshot ?? null,
          events: [report],
          prompt,
        },
        output: {
          rawResponse: decision.rawResponse,
          parsedCommands: decision.commands,
          summary: decision.summary,
        },
        commandsIssued: decision.commands.map((command) => command.command_id),
        model: decision.resolvedModel ?? (decision.seatId
          ? `${config.sergeantModel}@${decision.seatId}`
          : decision.fallback
          ? `${config.sergeantModel}:api-fallback`
          : decision.stretched
          ? `${config.sergeantModel}:stretched`
          : config.sergeantModel),
        latencyMs: decision.latencyMs,
        tokenUsage: decision.tokenUsage,
        costUsd: decision.costUsd,
      };
      yield* this.decisionLogs().save(log);
      yield* Effect.sync(() => this.setState({
        ...this.state,
        groupId: report.payload.group_id,
        reportsHandled: this.state.reportsHandled + 1,
        nextDecisionSequence: assigned === undefined
          ? this.state.nextDecisionSequence + 1
          : this.state.nextDecisionSequence,
        nextCommandSequence: assigned === undefined
          ? this.state.nextCommandSequence + decision.commandSequenceAdvance
          : this.state.nextCommandSequence,
        lastReportAt: report.timestamp,
        lastDecision: decision.commands,
      }));
      return {
        commands: decision.commands,
        log,
        summary: decision.summary,
        timestamp: report.timestamp,
        ...(decision.seatId ? { seatId: decision.seatId } : {}),
        ...(decision.costAttributions === undefined
          ? {}
          : { costAttributions: decision.costAttributions }),
      };
    });
  }

  private decisionLogs(): SqlDecisionLogRepository {
    return new SqlDecisionLogRepository(this);
  }
}
