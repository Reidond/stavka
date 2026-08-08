import type { ModelReasoningEffort, ThreadOptions, TurnOptions, Usage } from "@openai/codex-sdk";
import { Effect } from "effect";

import { GatewayError, type SeatInvocation, type SeatResult } from "../domain/types";
import { estimateTokens, type SeatAdapter } from "./seat-adapter";

const codexSubscriptionCredentialKeys = new Set([
  "ANTHROPIC_API_KEY",
  "CODEX_API_KEY",
  "OPENAI_API_KEY",
]);

export const sanitizeCodexSubscriptionEnvironment = (
  environment: Readonly<Record<string, string | undefined>>,
): Record<string, string> =>
  Object.fromEntries(
    Object.entries(environment).filter(
      ([key, value]) => !codexSubscriptionCredentialKeys.has(key) && value !== undefined,
    ),
  ) as Record<string, string>;

interface CodexThreadPort {
  readonly run: (
    input: string,
    options?: TurnOptions,
  ) => Promise<{ readonly finalResponse: string; readonly usage: Usage | null }>;
}

export type CodexThreadFactory = (
  environment: Record<string, string>,
  options: ThreadOptions,
) => Promise<CodexThreadPort>;

const liveCodexThread: CodexThreadFactory = async (environment, options) => {
  const { Codex } = await import("@openai/codex-sdk");
  return new Codex({ env: environment }).startThread(options);
};

const reasoningEffort = (request: SeatInvocation): ModelReasoningEffort | undefined => {
  const reasoning = request.request.reasoning;
  if (reasoning === null || typeof reasoning !== "object" || Array.isArray(reasoning)) {
    return undefined;
  }
  const effort = (reasoning as Readonly<Record<string, unknown>>).effort;
  if (
    effort !== "minimal" &&
    effort !== "low" &&
    effort !== "medium" &&
    effort !== "high" &&
    effort !== "xhigh" &&
    effort !== "max"
  )
    return undefined;
  return effort === "max" ? "xhigh" : effort;
};

export class CodexSeat implements SeatAdapter {
  readonly id = "codex" as const;

  constructor(
    private readonly workingDirectory: string,
    private readonly createThread: CodexThreadFactory = liveCodexThread,
  ) {}

  invoke(request: SeatInvocation): Effect.Effect<SeatResult, GatewayError> {
    return Effect.tryPromise({
      try: async (signal) => {
        const effort = reasoningEffort(request);
        const thread = await this.createThread(sanitizeCodexSubscriptionEnvironment(process.env), {
          model: request.model,
          workingDirectory: this.workingDirectory,
          skipGitRepoCheck: true,
          approvalPolicy: "never",
          sandboxMode: "read-only",
          networkAccessEnabled: false,
          webSearchMode: "disabled",
          ...(effort ? { modelReasoningEffort: effort } : {}),
        });
        const prompt = [
          request.system ?? "Return only the requested answer.",
          "Do not use tools, inspect files, or perform actions. Answer only from the supplied request.",
          request.prompt,
        ].join("\n\n");
        const turn = await thread.run(prompt, {
          ...(request.outputSchema ? { outputSchema: request.outputSchema } : {}),
          signal,
        });
        let structured: unknown;
        if (request.outputSchema) {
          try {
            structured = JSON.parse(turn.finalResponse) as unknown;
          } catch {
            structured = undefined;
          }
        }
        return {
          text: turn.finalResponse,
          ...(structured !== undefined ? { structured } : {}),
          usage: {
            inputTokens: turn.usage?.input_tokens ?? estimateTokens(prompt),
            outputTokens: turn.usage?.output_tokens ?? estimateTokens(turn.finalResponse),
            cachedInputTokens: turn.usage?.cached_input_tokens ?? 0,
          },
        };
      },
      catch: (cause) =>
        new GatewayError(
          502,
          "CODEX_SEAT_FAILURE",
          cause instanceof Error ? cause.message : "Codex SDK invocation failed",
        ),
    });
  }
}
