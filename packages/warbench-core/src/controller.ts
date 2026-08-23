import { Data, Effect, Schema } from "effect";
import { Decision, type Observation, type Side } from "./domain";

/**
 * Provider-neutral failure taxonomy for candidate controllers. The simulator
 * accounting distinguishes broken model contracts (`invalid_decision`) and
 * unknown models (`model`) from transport failures (`request`).
 */
export class ControllerError extends Data.TaggedError("ControllerError")<{
  readonly reason: "model" | "request" | "invalid_decision";
  readonly message: string;
  readonly latencyMs?: number;
  readonly model?: string;
  /** Sanitized transport diagnostics; never tokens, account ids, or bodies. */
  readonly diagnostic?: {
    readonly status?: number;
    readonly requestId?: string;
    readonly cfRay?: string;
    readonly cfMitigated?: string;
  };
}> {}

export interface CandidateDecision {
  readonly decision: Decision;
  readonly latencyMs: number;
  readonly model: string;
}

export interface EvaluationController {
  readonly id: string;

  decide(observation: Observation): Effect.Effect<CandidateDecision, ControllerError>;
}

export const safeFailureMessage = (
  message: string,
  fallback = "Candidate request failed",
): string =>
  (message.trim() || fallback).replace(/Bearer\s+[^\s,;]+/gi, "Bearer [redacted]").slice(0, 500);

export const decisionSystemPrompt = (side: Side): string =>
  `You are a battlefield commander in a deterministic evaluation.
You command only ${side} units.
Return exactly one JSON object and no markdown or commentary.
Schema: {"orders":[{"unitId":"...","type":"move","target":{"x":0,"y":0}}|{"unitId":"...","type":"attack","targetId":"..."}|{"unitId":"...","type":"hold"}]}
Public simulator rules:
- The battlefield is a 100 x 100 plane.
- A move order advances a unit at most 7 distance units per simulation tick toward its target.
- An attack succeeds only when the target is within distance 22. A successful attack removes the attacker's attack value from target HP.
- Movement resolves first; all valid attacks then apply damage simultaneously from the same post-movement snapshot.
- An objective is controlled by the side with more living units within distance 12 of its center; ties preserve the previous owner.
- Each match lasts 40 simulation ticks.
- Strategic orders are refreshed every 5 simulation ticks and persist between decisions.
- Final score is friendly remaining HP minus enemy remaining HP plus 150 points per controlled objective.
Command rules:
- Issue at most one order per living ${side} unit.
- Never issue orders for the opposing side.
- Coordinates must remain between 0 and 100.
- Attack only known living enemy unit ids.
- Prefer capturing and retaining objectives while preserving combat power.`;

const validateSemantics = (
  observation: Observation,
  side: Side,
  decision: typeof Decision.Type,
): typeof Decision.Type => {
  const own = new Set(
    observation.units.filter((unit) => unit.side === side && unit.hp > 0).map((unit) => unit.id),
  );
  const enemies = new Set(
    observation.units.filter((unit) => unit.side !== side && unit.hp > 0).map((unit) => unit.id),
  );
  const ordered = new Set<string>();

  for (const order of decision.orders) {
    if (!own.has(order.unitId)) {
      throw new Error(`order references non-commandable unit ${order.unitId}`);
    }
    if (ordered.has(order.unitId)) throw new Error(`duplicate order for ${order.unitId}`);
    ordered.add(order.unitId);
    if (order.type === "attack" && !enemies.has(order.targetId)) {
      throw new Error(`attack references unknown enemy ${order.targetId}`);
    }
    if (
      order.type === "move" &&
      (order.target.x < 0 || order.target.x > 100 || order.target.y < 0 || order.target.y > 100)
    ) {
      throw new Error(`move target is outside the battlefield for ${order.unitId}`);
    }
  }
  return decision;
};

export interface JsonCompletionRequest {
  readonly systemPrompt: string;
  readonly userContent: string;
}

export interface JsonCompletionResult {
  readonly text: string;
  readonly model: string;
  readonly latencyMs: number;
}

/**
 * The narrow provider seam: anything that can return strict JSON text for a
 * prompt together with the resolved model id and latency. Providers such as
 * Pi/Codex implement this; warbench-core owns validation of their output.
 */
export type JsonCompleter = (
  request: JsonCompletionRequest,
) => Effect.Effect<JsonCompletionResult, ControllerError>;

/**
 * Build an {@link EvaluationController} from any JSON completer. Parsing,
 * schema validation, and semantic legality stay inside warbench-core so no
 * provider implementation can weaken decision checks.
 */
export const jsonEvaluationController = (
  id: string,
  complete: JsonCompleter,
  side: Side,
): EvaluationController => ({
  id,
  decide: (observation) =>
    complete({
      systemPrompt: decisionSystemPrompt(side),
      userContent: JSON.stringify(observation),
    }).pipe(Effect.flatMap((completion) => parseDecisionText(observation, side, completion))),
});

export const parseDecisionText = (
  observation: Observation,
  side: Side,
  completion: JsonCompletionResult,
): Effect.Effect<CandidateDecision, ControllerError> =>
  Effect.try({
    try: () => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(completion.text.trim());
      } catch {
        throw new ControllerError({
          reason: "invalid_decision",
          message: "Model response was not strict JSON",
          latencyMs: completion.latencyMs,
          model: completion.model,
        });
      }
      try {
        const decision = Schema.decodeUnknownSync(Decision, { onExcessProperty: "error" })(parsed);
        return {
          decision: validateSemantics(observation, side, decision),
          latencyMs: completion.latencyMs,
          model: completion.model,
        };
      } catch (cause) {
        if (cause instanceof ControllerError) throw cause;
        throw new ControllerError({
          reason: "invalid_decision",
          message: safeFailureMessage(
            cause instanceof Error ? cause.message : "Model decision failed validation",
          ),
          latencyMs: completion.latencyMs,
          model: completion.model,
        });
      }
    },
    catch: (cause) =>
      cause instanceof ControllerError
        ? cause
        : new ControllerError({
            reason: "invalid_decision",
            message: safeFailureMessage(
              cause instanceof Error ? cause.message : "Model decision failed validation",
            ),
            latencyMs: completion.latencyMs,
            model: completion.model,
          }),
  });
