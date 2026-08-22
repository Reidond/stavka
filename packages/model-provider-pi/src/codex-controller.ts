import type { AssistantMessage, Context } from "@earendil-works/pi-ai";
import { openaiCodexProvider } from "@earendil-works/pi-ai/providers/openai-codex";
import { Effect } from "effect";
import type { UpstreamDiagnostic } from "@stavka/model-provider";
import type { CodexCredentials } from "./codex-auth";

/**
 * Pi-backed Codex JSON completion. This package owns only provider concerns:
 * the Pi model catalog, request identity headers, OAuth credential injection,
 * and sanitized upstream diagnostics. Prompt construction and decision
 * validation live in `@stavka/warbench-core`.
 */
import {
  ControllerError,
  type JsonCompleter,
  type JsonCompletionResult,
} from "@stavka/warbench-core";

const accountClaim = "https://api.openai.com/auth";

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
  (
    credentials: CodexCredentials & { readonly accountId: string },
    onResponse?: (response: Response) => void,
  ): typeof globalThis.fetch =>
  async (input, init) => {
    const headers = new Headers(init?.headers);
    headers.set("Authorization", `Bearer ${credentials.access}`);
    headers.set("ChatGPT-Account-ID", credentials.accountId);
    headers.set("originator", "Codex Warbench");
    headers.set("User-Agent", "Codex-Warbench/0.1.0 (Cloudflare-Workers)");

    // The Codex SSE endpoint does not require the WebSocket beta header. Pi
    // 0.84.2 adds an older responses=experimental value, so remove it here.
    headers.delete("OpenAI-Beta");

    const response = await globalThis.fetch(input, { ...init, headers });
    onResponse?.(response);
    return response;
  };

const safeFailureMessage = (message: string, fallback = "Codex request failed"): string =>
  (message.trim() || fallback).replace(/Bearer\s+[^\s,;]+/gi, "Bearer [redacted]").slice(0, 500);

export const codexFailureMessage = (
  error: Pick<AssistantMessage, "diagnostics" | "errorMessage" | "rawStopReason">,
  upstream: { readonly status?: number; readonly cfMitigated?: string } = {},
): string => {
  const diagnosticMessage = error.diagnostics
    ?.map((diagnostic) => diagnostic.error?.message.trim())
    .find((message): message is string => Boolean(message));
  const message = [error.errorMessage, error.rawStopReason, diagnosticMessage]
    .map((candidate) => candidate?.trim())
    .find((candidate): candidate is string => Boolean(candidate));
  const challengePage =
    upstream.cfMitigated === "challenge" ||
    (upstream.status === 403 &&
      message !== undefined &&
      /^\s*<(?:!doctype\s+)?html\b/i.test(message));
  if (challengePage) {
    return "ChatGPT blocked this Cloudflare Worker request with HTTP 403 before OAuth verification";
  }
  return safeFailureMessage(
    message ??
      (upstream.status === undefined
        ? "Codex request failed"
        : `Codex upstream returned HTTP ${upstream.status}`),
  );
};

const readDiagnostic = (response: Response): UpstreamDiagnostic => {
  const contentType = response.headers.get("content-type") ?? undefined;
  return {
    status: response.status,
    ...(contentType ? { contentType } : {}),
    ...(response.headers.get("cf-ray") ? { cfRay: response.headers.get("cf-ray") as string } : {}),
    ...(response.headers.get("cf-mitigated")
      ? { cfMitigated: response.headers.get("cf-mitigated") as string }
      : {}),
    ...(response.headers.get("x-request-id")
      ? { requestId: response.headers.get("x-request-id") as string }
      : {}),
    category: contentType?.includes("text/html") ? "challenge" : "response",
  };
};

const diagnosticOf = (upstream: UpstreamDiagnostic) => {
  if (Object.keys(upstream).length === 0) return {};
  return {
    diagnostic: {
      ...(upstream.status === undefined ? {} : { status: upstream.status }),
      ...(upstream.requestId === undefined ? {} : { requestId: upstream.requestId }),
      ...(upstream.cfRay === undefined ? {} : { cfRay: upstream.cfRay }),
      ...(upstream.cfMitigated === undefined ? {} : { cfMitigated: upstream.cfMitigated }),
    },
  };
};

export interface CodexCompleterOptions {
  readonly requestedModel?: string;
  /** Observes sanitized diagnostics for every upstream response (probes). */
  readonly onResponse?: (diagnostic: UpstreamDiagnostic) => void;
}

/**
 * A {@link JsonCompleter} that executes one pinned Pi/Codex request per call.
 * Failures surface as `ControllerError`s so the simulator accounting can
 * separate invalid model output from transport outages.
 */
export const codexJsonCompleter =
  (credentials: CodexCredentials, options: CodexCompleterOptions = {}): JsonCompleter =>
  (request): Effect.Effect<JsonCompletionResult, ControllerError> => {
    let upstream: UpstreamDiagnostic = {};
    return Effect.tryPromise({
      try: async () => {
        const provider = openaiCodexProvider();
        const models = provider.getModels();
        const model = options.requestedModel
          ? models.find((candidate) => candidate.id === options.requestedModel)
          : models[0];
        if (!model) {
          throw new ControllerError({
            reason: "model",
            message: options.requestedModel
              ? `Codex model ${options.requestedModel} is not in Pi's current catalog`
              : "Pi returned no Codex subscription models",
            ...(options.requestedModel ? { model: options.requestedModel } : {}),
          });
        }

        if (!credentials.accountId) {
          throw new ControllerError({
            reason: "request",
            message:
              "The Codex OAuth token does not contain a ChatGPT account id; reconnect ChatGPT",
            model: model.id,
          });
        }

        const context: Context = {
          systemPrompt: request.systemPrompt,
          messages: [
            {
              role: "user",
              content: request.userContent,
              timestamp: Date.now(),
            },
          ],
          tools: [],
        };

        const started = performance.now();
        const stream = provider.streamSimple(model, context, {
          apiKey: makePiAccountToken(credentials.accountId),
          fetch: makeCodexFetch(
            { ...credentials, accountId: credentials.accountId },
            (response) => {
              upstream = readDiagnostic(response);
              options.onResponse?.(upstream);
            },
          ),
          reasoning: "low",
          transport: "sse",
          timeoutMs: 30_000,
          maxRetries: 1,
        });
        let text = "";
        for await (const event of stream) {
          if (event.type === "text_delta") text += event.delta;
          if (event.type === "error") {
            throw new ControllerError({
              reason: "request",
              message: codexFailureMessage(event.error, upstream),
              latencyMs: performance.now() - started,
              model: model.id,
              ...diagnosticOf(upstream),
            });
          }
        }
        const latencyMs = performance.now() - started;
        return { text, model: model.id, latencyMs };
      },
      catch: (cause) =>
        cause instanceof ControllerError
          ? cause
          : new ControllerError({
              reason: "request",
              message: safeFailureMessage(cause instanceof Error ? cause.message : String(cause)),
              ...diagnosticOf(upstream),
            }),
    });
  };
