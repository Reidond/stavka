import { AnthropicClient, AnthropicLanguageModel } from "@effect/ai-anthropic";
import { OpenAiClient, OpenAiLanguageModel } from "@effect/ai-openai";
import {
  AttackGroupCommand,
  CommandPriority,
  DefendGroupCommand,
  DespawnGroupCommand,
  MoveGroupCommand,
  PatrolGroupCommand,
  SetObjectiveCommand,
  SpawnGroupCommand,
  SweepGroupCommand,
  type LlmTierAlias,
} from "@stavka/protocol";
import { Effect, Layer, Redacted, Schema } from "effect";
import { LanguageModel } from "effect/unstable/ai";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/unstable/http";

import type { CommanderConfig } from "../config";

const ProposalBase = { priority: Schema.optional(CommandPriority) };

export const AiCommandProposal = Schema.Union([
  Schema.Struct({
    ...ProposalBase,
    type: Schema.Literal("spawn_group"),
    params: SpawnGroupCommand.fields.params,
  }),
  Schema.Struct({
    ...ProposalBase,
    type: Schema.Literal("despawn_group"),
    params: DespawnGroupCommand.fields.params,
  }),
  Schema.Struct({
    ...ProposalBase,
    type: Schema.Literal("move_group"),
    params: MoveGroupCommand.fields.params,
  }),
  Schema.Struct({
    ...ProposalBase,
    type: Schema.Literal("attack_group"),
    params: AttackGroupCommand.fields.params,
  }),
  Schema.Struct({
    ...ProposalBase,
    type: Schema.Literal("defend_group"),
    params: DefendGroupCommand.fields.params,
  }),
  Schema.Struct({
    ...ProposalBase,
    type: Schema.Literal("patrol_group"),
    params: PatrolGroupCommand.fields.params,
  }),
  Schema.Struct({
    ...ProposalBase,
    type: Schema.Literal("sweep_group"),
    params: SweepGroupCommand.fields.params,
  }),
  Schema.Struct({
    ...ProposalBase,
    type: Schema.Literal("set_objective"),
    params: SetObjectiveCommand.fields.params,
  }),
]);
export type AiCommandProposal = typeof AiCommandProposal.Type;

export const AiDecision = Schema.Struct({
  summary: Schema.String,
  commands: Schema.Array(AiCommandProposal),
});
export type AiDecision = typeof AiDecision.Type;

export const AiDecisionResult = Schema.Struct({
  decision: AiDecision,
  rawResponse: Schema.String,
  tokenUsage: Schema.Struct({ input: Schema.Number, output: Schema.Number }),
  costUsd: Schema.Number,
  resolvedModel: Schema.optional(Schema.String),
});
export type AiDecisionResult = typeof AiDecisionResult.Type;

const openAiUrl = (baseUrl: string): string =>
  baseUrl.endsWith("/v1") ? baseUrl : `${baseUrl}/v1`;

const anthropicUrl = (baseUrl: string): string =>
  baseUrl.endsWith("/v1") ? baseUrl.slice(0, -3) : baseUrl;

// Effect uses the local model id to select Anthropic capabilities. Tier aliases
// are deliberately unknown to the SDK, so use a capability-equivalent model
// locally and restore the alias at the HTTP boundary for Maskirovka.
const ANTHROPIC_CAPABILITY_MODEL = "claude-sonnet-4-6";

export const rewriteAnthropicGatewayRequest = (
  request: HttpClientRequest.HttpClientRequest,
  model: LlmTierAlias,
  apiKey?: string,
): HttpClientRequest.HttpClientRequest => {
  let rewritten = request.pipe(HttpClientRequest.removeHeader("x-api-key"));
  if (request.body._tag === "Uint8Array") {
    const body = JSON.parse(new TextDecoder().decode(request.body.body)) as Record<string, unknown>;
    rewritten = HttpClientRequest.bodyJsonUnsafe(rewritten, { ...body, model });
  }
  return apiKey === undefined ? rewritten : HttpClientRequest.bearerToken(rewritten, apiKey);
};

const tierRates: Record<LlmTierAlias, { readonly input: number; readonly output: number }> = {
  "stavka/commander": { input: 5, output: 30 },
  "stavka/sergeant": { input: 1, output: 6 },
  "stavka/heavy": { input: 2.5, output: 15 },
};

export const estimateCost = (
  tier: LlmTierAlias,
  usage: { readonly input: number; readonly output: number },
): number => {
  const rates = tierRates[tier];
  return (usage.input * rates.input + usage.output * rates.output) / 1_000_000;
};

const generatedDecision = (
  prompt: string,
): Effect.Effect<
  LanguageModel.GenerateObjectResponse<Record<string, never>, AiDecision>,
  unknown,
  LanguageModel.LanguageModel
> =>
  LanguageModel.generateObject({
    prompt,
    schema: AiDecision,
    objectName: "stavka_decision",
  });

/**
 * When a private inference service binding is configured, all model traffic
 * flows through the binding and never touches a public inference origin.
 * Otherwise requests use platform fetch against the configured base URL
 * (local development).
 */
const httpClientLayer = (config: CommanderConfig): Layer.Layer<HttpClient.HttpClient> => {
  const service = config.inferenceService;
  if (service === undefined) return FetchHttpClient.layer;
  const bindingFetch = ((input: RequestInfo | URL, init?: RequestInit) =>
    service.fetch(input instanceof Request ? input : String(input), init)) as unknown as typeof globalThis.fetch;
  // The Fetch reference is read per request; the concrete binding wins over the default.
  return Layer.merge(FetchHttpClient.layer, Layer.succeed(FetchHttpClient.Fetch, bindingFetch));
};

const withOpenAi = (
  config: CommanderConfig,
  model: string,
  program: Effect.Effect<
    LanguageModel.GenerateObjectResponse<Record<string, never>, AiDecision>,
    unknown,
    LanguageModel.LanguageModel
  >,
) => {
  const client = OpenAiClient.layer({
    apiUrl: openAiUrl(config.aiBaseUrl),
    ...(config.aiKey ? { apiKey: Redacted.make(config.aiKey) } : {}),
  }).pipe(Layer.provide(httpClientLayer(config)));
  const languageModel = OpenAiLanguageModel.layer({ model }).pipe(Layer.provide(client));
  return program.pipe(Effect.provide(languageModel));
};

const withAnthropic = (
  config: CommanderConfig,
  model: LlmTierAlias,
  program: Effect.Effect<
    LanguageModel.GenerateObjectResponse<Record<string, never>, AiDecision>,
    unknown,
    LanguageModel.LanguageModel
  >,
) => {
  const transformClient = (client: HttpClient.HttpClient): HttpClient.HttpClient =>
    client.pipe(
      HttpClient.mapRequest((request) =>
        rewriteAnthropicGatewayRequest(request, model, config.aiKey),
      ),
    );
  const client = AnthropicClient.layer({
    apiUrl: anthropicUrl(config.aiBaseUrl),
    transformClient,
  }).pipe(Layer.provide(httpClientLayer(config)));
  const languageModel = AnthropicLanguageModel.layer({
    model: ANTHROPIC_CAPABILITY_MODEL,
  }).pipe(Layer.provide(client));
  return program.pipe(Effect.provide(languageModel));
};

export const runAiDecision = (
  config: CommanderConfig,
  options: { readonly model: LlmTierAlias; readonly prompt: string },
): Effect.Effect<AiDecisionResult, unknown> => {
  if (config.aiProvider === "mock") {
    return Effect.succeed({
      decision: { summary: "Mock provider selected.", commands: [] },
      rawResponse: "",
      tokenUsage: { input: 0, output: 0 },
      costUsd: 0,
    });
  }
  const program = generatedDecision(options.prompt);
  const provided =
    config.aiProvider === "openai"
      ? withOpenAi(config, options.model, program)
      : withAnthropic(config, options.model, program);
  return provided.pipe(
    Effect.map((response): AiDecisionResult => {
      const tokenUsage = {
        input: response.usage.inputTokens.total ?? 0,
        output: response.usage.outputTokens.total ?? 0,
      };
      return {
        decision: response.value,
        rawResponse: response.text,
        tokenUsage,
        costUsd: estimateCost(options.model, tokenUsage),
      };
    }),
  );
};
