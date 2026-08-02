import type { Command } from "@stavka/protocol";
import { Clock, Effect } from "effect";

import type { CommanderConfig } from "../config";
import type { CommanderSessionState } from "../state/types";
import {
  materializeCommandProposals,
  reassignCommandIds,
  validateCommands,
} from "./command-validator";
import { runAiDecision } from "./llm-client";
import { commanderPrompt } from "./prompts";
import { planRuleCommander } from "./rule-commander";
import {
  reportedSeatFailureUsage,
  resolveLlmRoute,
  routedFailureCostAttributions,
  type RoutedAiCostAttribution,
  type RoutedAiDecision,
} from "./seat-router";

export interface PlannedDecision {
  readonly summary: string;
  readonly commands: readonly Command[];
  readonly prompt: string;
  readonly rawResponse: string;
  readonly model: string;
  readonly mode: "rule" | "llm" | "degraded";
  readonly latencyMs: number;
  readonly manpowerSpent: number;
  readonly vehiclesReserved: number;
  readonly commandSequenceAdvance: number;
  readonly tokenUsage: { readonly input: number; readonly output: number };
  readonly costUsd: number;
  readonly seatId?: string;
  /** Every settled provider attempt, including any failed-over attempt. */
  readonly costAttributions?: readonly RoutedAiCostAttribution[];
  readonly fallback: boolean;
  readonly stretched: boolean;
}

export const planDecision = (
  state: CommanderSessionState,
  config: CommanderConfig,
  trigger: string,
  invokeDecision?: (prompt: string) => Effect.Effect<RoutedAiDecision, unknown>,
): Effect.Effect<PlannedDecision> => Effect.gen(function*() {
  const prompt = commanderPrompt(state, trigger);
  const rulePlan = planRuleCommander(state, trigger);
  const rules = {
    ...rulePlan,
    commands: reassignCommandIds(rulePlan.commands, state.nextCommandSequence),
    commandSequenceAdvance: rulePlan.commands.length,
  };
  const route = resolveLlmRoute(state.seats, config, config.commanderModel);
  if (route.stretched) {
    return {
      ...rules,
      summary: "Seat budget exhausted; stretched cadence and retained rule control.",
      prompt,
      rawResponse: "",
      model: `${config.commanderModel}:stretched`,
      mode: "degraded",
      latencyMs: 0,
      tokenUsage: { input: 0, output: 0 },
      costUsd: 0,
      fallback: false,
      stretched: true,
    };
  }
  if (route.config.aiProvider === "mock") {
    return {
      ...rules,
      prompt,
      rawResponse: JSON.stringify({ summary: rules.summary, commands: rules.commands }),
      model: "mock:commander",
      mode: "rule",
      latencyMs: 0,
      tokenUsage: { input: 0, output: 0 },
      costUsd: 0,
      fallback: route.fallback,
      stretched: false,
    };
  }
  const started = yield* Clock.currentTimeMillis;
  const attempted = yield* Effect.result(
    invokeDecision === undefined
      ? runAiDecision(route.config, { model: config.commanderModel, prompt }).pipe(
          Effect.map((result): RoutedAiDecision => ({
            ...result,
            fallback: route.fallback,
            ...(route.seatId ? { seatId: route.seatId } : {}),
          })),
        )
      : invokeDecision(prompt),
  );
  const finished = yield* Clock.currentTimeMillis;
  if (attempted._tag === "Success") {
    const generated = attempted.success;
    const proposed = materializeCommandProposals(
      generated.decision.commands,
      state.nextCommandSequence,
    );
    const validated = validateCommands(proposed, state);
    return {
        summary: validated.rejected.length === 0
          ? generated.decision.summary
          : `${generated.decision.summary} Rejected ${validated.rejected.length} unsafe command(s).`,
        commands: validated.commands,
        prompt,
        rawResponse: generated.rawResponse || JSON.stringify(generated.decision),
        model: generated.resolvedModel ?? (generated.seatId
          ? `${config.commanderModel}@${generated.seatId}`
          : generated.fallback
          ? `${config.commanderModel}:api-fallback`
          : config.commanderModel),
        mode: "llm",
        latencyMs: finished - started,
        manpowerSpent: validated.manpowerSpent,
        vehiclesReserved: validated.vehiclesReserved,
        commandSequenceAdvance: proposed.length,
        tokenUsage: generated.tokenUsage,
        costUsd: generated.costUsd,
        ...(generated.seatId ? { seatId: generated.seatId } : {}),
        ...(generated.costAttributions === undefined
          ? {}
          : { costAttributions: generated.costAttributions }),
        fallback: generated.fallback,
        stretched: false,
      };
  }
  const failure = attempted.failure;
  const reported = reportedSeatFailureUsage(failure);
  const failureAttributions = routedFailureCostAttributions(failure);
  return {
    ...rules,
    summary: `Degraded to rules: ${failure instanceof Error ? failure.message : "LLM failure"}`,
    prompt,
    rawResponse: "",
    model: reported.resolvedModel ?? config.commanderModel,
    mode: "degraded",
    latencyMs: finished - started,
    tokenUsage: reported.tokenUsage,
    costUsd: reported.costUsd,
    ...(route.seatId ? { seatId: route.seatId } : {}),
    ...(failureAttributions.length === 0
      ? {}
      : { costAttributions: failureAttributions }),
    fallback: route.fallback,
    stretched: false,
  };
});
