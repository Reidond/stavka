import type { Context } from "@earendil-works/pi-ai";
import { openaiCodexProvider } from "@earendil-works/pi-ai/providers/openai-codex";
import { Data, Effect, Schema } from "effect";
import type { CodexCredentials } from "./codex-auth";
import { Decision, type Observation, type Side } from "./domain";
import type { Controller } from "./sim";

export class CodexControllerError extends Data.TaggedError("CodexControllerError")<{
  readonly reason: "model" | "request" | "invalid_decision";
  readonly message: string;
}> {}

export interface CodexDecisionResult {
  readonly decision: typeof Decision.Type;
  readonly latencyMs: number;
  readonly model: string;
}

const accountClaim = "https://api.openai.com/auth";

const systemPrompt = (side: Side) => `You are a battlefield commander in a deterministic evaluation.
You command only ${side} units.
Return exactly one JSON object and no markdown or commentary.
Schema: {"orders":[{"unitId":"...","type":"move","target":{"x":0,"y":0}}|{"unitId":"...","type":"attack","targetId":"..."}|{"unitId":"...","type":"hold"}]}
Public simulator rules:
- The battlefield is a 100 x 100 plane.
- A move order advances a unit at most 7 distance units per simulation tick toward its target.
- An attack succeeds only when the target is within distance 22. A successful attack removes the attacker's attack value from target HP.
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

/**
 * Pi 0.84.2 extracts the ChatGPT account id by applying atob() directly to
 * the JWT payload. OAuth JWTs use base64url, so that extraction can fail in a
 * Worker before any HTTP request is made. Give Pi a decode-only token whose
 * claim is standard base64, then restore the real OAuth bearer token in the
 * injected fetch implementation.
 */
export const makePiAccountToken = (accountId: string): string => {
  const payload = btoa(
    JSON.stringify({
      [accountClaim]: { chatgpt_account_id: accountId },
    }),
  );
  return `e30.${payload}.e30`;
};

export const makeCodexFetch =
  (credentials: CodexCredentials & { readonly accountId: string }): typeof globalThis.fetch =>
  async (input, init) => {
    const headers = new Headers(init?.headers);
    headers.set("Authorization", `Bearer ${credentials.access}`);
    headers.set("ChatGPT-Account-ID", credentials.accountId);
    headers.set("originator", "Codex Warbench");

    // The Codex SSE endpoint does not require the WebSocket beta header. Pi
    // 0.84.2 adds an older responses=experimental value, so remove it here.
    headers.delete("OpenAI-Beta");

    return globalThis.fetch(input, { ...init, headers });
  };

export const decideWithCodex = (
  observation: Observation,
  side: Side,
  credentials: CodexCredentials,
  requestedModel?: string,
): Effect.Effect<CodexDecisionResult, CodexControllerError> =>
  Effect.tryPromise({
    try: async () => {
      const provider = openaiCodexProvider();
      const models = provider.getModels();
      const model = requestedModel
        ? models.find((candidate) => candidate.id === requestedModel)
        : models[0];
      if (!model) {
        throw new CodexControllerError({
          reason: "model",
          message: requestedModel
            ? `Codex model ${requestedModel} is not in Pi's current catalog`
            : "Pi returned no Codex subscription models",
        });
      }

      if (!credentials.accountId) {
        throw new CodexControllerError({
          reason: "request",
          message: "The Codex OAuth token does not contain a ChatGPT account id; reconnect ChatGPT",
        });
      }

      const context: Context = {
        systemPrompt: systemPrompt(side),
        messages: [
          {
            role: "user",
            content: JSON.stringify(observation),
            timestamp: Date.now(),
          },
        ],
        tools: [],
      };

      const started = performance.now();
      const accountCredentials = {
        ...credentials,
        accountId: credentials.accountId,
      };
      const stream = provider.streamSimple(model, context, {
        apiKey: makePiAccountToken(credentials.accountId),
        fetch: makeCodexFetch(accountCredentials),
        reasoning: "low",
        transport: "sse",
        timeoutMs: 30_000,
        maxRetries: 1,
      });
      let text = "";
      for await (const event of stream) {
        if (event.type === "text_delta") text += event.delta;
        if (event.type === "error") {
          throw new CodexControllerError({
            reason: "request",
            message: event.error.errorMessage ?? "Codex request failed",
          });
        }
      }
      const latencyMs = performance.now() - started;

      let parsed: unknown;
      try {
        parsed = JSON.parse(text.trim());
      } catch {
        throw new CodexControllerError({
          reason: "invalid_decision",
          message: "Codex response was not strict JSON",
        });
      }

      try {
        const decision = Schema.decodeUnknownSync(Decision, { onExcessProperty: "error" })(parsed);
        return {
          decision: validateSemantics(observation, side, decision),
          latencyMs,
          model: model.id,
        };
      } catch (cause) {
        if (cause instanceof CodexControllerError) throw cause;
        throw new CodexControllerError({
          reason: "invalid_decision",
          message: cause instanceof Error ? cause.message : "Codex decision failed validation",
        });
      }
    },
    catch: (cause) =>
      cause instanceof CodexControllerError
        ? cause
        : new CodexControllerError({
            reason: "request",
            message: cause instanceof Error ? cause.message : String(cause),
          }),
  });

export const codexController =
  (side: Side, credentials: CodexCredentials, requestedModel?: string): Controller =>
  (observation) =>
    decideWithCodex(observation, side, credentials, requestedModel).pipe(
      Effect.map((result) => result.decision),
    );
