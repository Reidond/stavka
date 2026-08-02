import { Schema } from "effect";

import { PROTOCOL_VERSION } from "./messages";

export const LlmTierAlias = Schema.Literals([
  "stavka/commander",
  "stavka/sergeant",
  "stavka/heavy",
]);
export type LlmTierAlias = typeof LlmTierAlias.Type;

export const OpenAiResponsesRequest = Schema.Struct({
  model: LlmTierAlias,
  input: Schema.Unknown,
  instructions: Schema.optional(Schema.Unknown),
  max_output_tokens: Schema.optional(Schema.Number),
  stream: Schema.optional(Schema.Boolean),
  tools: Schema.optional(Schema.Array(Schema.Unknown)),
  text: Schema.optional(Schema.Unknown),
  reasoning: Schema.optional(
    Schema.Struct({
      effort: Schema.optional(
        Schema.Literals(["minimal", "low", "medium", "high", "xhigh", "max"]),
      ),
    }),
  ),
  previous_response_id: Schema.optional(Schema.String),
});
export type OpenAiResponsesRequest = typeof OpenAiResponsesRequest.Type;

export const AnthropicMessagesRequest = Schema.Struct({
  model: LlmTierAlias,
  messages: Schema.Unknown,
  system: Schema.optional(Schema.Unknown),
  max_tokens: Schema.Number,
  stream: Schema.optional(Schema.Boolean),
  tools: Schema.optional(Schema.Array(Schema.Unknown)),
  temperature: Schema.optional(Schema.Number),
  stop_sequences: Schema.optional(Schema.Array(Schema.String)),
  output_config: Schema.optional(Schema.Unknown),
});
export type AnthropicMessagesRequest = typeof AnthropicMessagesRequest.Type;

export const LlmSeatKind = Schema.Literals(["mock", "claude", "codex", "api"]);
export type LlmSeatKind = typeof LlmSeatKind.Type;

export const LlmAliasRemapRequest = Schema.Struct({
  seat: LlmSeatKind,
  model: Schema.String,
});
export type LlmAliasRemapRequest = typeof LlmAliasRemapRequest.Type;

export const LlmKillSwitchRequest = Schema.Struct({ enabled: Schema.Boolean });
export type LlmKillSwitchRequest = typeof LlmKillSwitchRequest.Type;

export const LlmSeatProvider = Schema.Literals(["claude", "codex", "api"]);
export type LlmSeatProvider = typeof LlmSeatProvider.Type;

export const LlmSeatMode = Schema.Literals(["container", "contributor", "api"]);
export type LlmSeatMode = typeof LlmSeatMode.Type;

const NonEmptyTrimmedString = Schema.String.pipe(
  Schema.check(Schema.isTrimmed(), Schema.isNonEmpty()),
);
const SeatId = Schema.String.pipe(
  Schema.check(
    Schema.isTrimmed(),
    Schema.isNonEmpty(),
    Schema.isMaxLength(128),
    Schema.isPattern(/^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/),
  ),
);
const SeatName = Schema.String.pipe(
  Schema.check(Schema.isTrimmed(), Schema.isNonEmpty(), Schema.isMaxLength(160)),
);
const SeatModels = Schema.Array(LlmTierAlias).pipe(
  Schema.check(Schema.isMinLength(1), Schema.isMaxLength(3)),
);
const SeatBudget = Schema.Number.pipe(
  Schema.check(Schema.isFinite(), Schema.isGreaterThanOrEqualTo(0)),
);
const SeatPriority = Schema.Number.pipe(
  Schema.check(
    Schema.isFinite(),
    Schema.isInt(),
    Schema.isBetween({ minimum: -1_000, maximum: 1_000 }),
  ),
);
const MaskirovkaEndpoint = Schema.String.pipe(
  Schema.check(
    Schema.isTrimmed(),
    Schema.isNonEmpty(),
    Schema.isMaxLength(2_048),
    Schema.makeFilter(
      (value) => {
        try {
          const url = new URL(value);
          return (
            (url.protocol === "http:" || url.protocol === "https:") &&
            url.hostname !== "api.openai.com" &&
            url.hostname !== "api.anthropic.com"
          );
        } catch {
          return false;
        }
      },
      { message: "endpoint must be an HTTP(S) Maskirovka URL, not a provider API" },
    ),
  ),
);

const SeatRegistrationFields = {
  id: SeatId,
  name: SeatName,
  models: SeatModels,
  monthlyBudgetUsd: SeatBudget,
  priority: SeatPriority,
};

export const LlmContainerSeatRegistrationRequest = Schema.Struct({
  ...SeatRegistrationFields,
  mode: Schema.Literal("container"),
  provider: LlmSeatProvider,
  endpoint: MaskirovkaEndpoint,
});
export type LlmContainerSeatRegistrationRequest = typeof LlmContainerSeatRegistrationRequest.Type;

export const LlmContributorSeatRegistrationRequest = Schema.Struct({
  ...SeatRegistrationFields,
  mode: Schema.Literal("contributor"),
  provider: Schema.Literals(["claude", "codex"]),
});
export type LlmContributorSeatRegistrationRequest =
  typeof LlmContributorSeatRegistrationRequest.Type;

export const LlmApiSeatRegistrationRequest = Schema.Struct({
  ...SeatRegistrationFields,
  mode: Schema.Literal("api"),
  provider: Schema.Literal("api"),
  endpoint: MaskirovkaEndpoint,
});
export type LlmApiSeatRegistrationRequest = typeof LlmApiSeatRegistrationRequest.Type;

/** Admin-facing registration input. Health, credentials, and timestamps are server-owned. */
export const LlmSeatRegistrationRequest = Schema.Union([
  LlmContainerSeatRegistrationRequest,
  LlmContributorSeatRegistrationRequest,
  LlmApiSeatRegistrationRequest,
]);
export type LlmSeatRegistrationRequest = typeof LlmSeatRegistrationRequest.Type;

export const LlmSeatUsage = Schema.Struct({
  input_tokens: Schema.Number.pipe(
    Schema.check(Schema.isFinite(), Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)),
  ),
  output_tokens: Schema.Number.pipe(
    Schema.check(Schema.isFinite(), Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)),
  ),
  cached_input_tokens: Schema.optional(
    Schema.Number.pipe(
      Schema.check(Schema.isFinite(), Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)),
    ),
  ),
  estimated_cost_usd: Schema.optional(
    Schema.Number.pipe(Schema.check(Schema.isFinite(), Schema.isGreaterThanOrEqualTo(0))),
  ),
});
export type LlmSeatUsage = typeof LlmSeatUsage.Type;

const ContributorMessageBase = {
  protocol_version: Schema.Literal(PROTOCOL_VERSION),
};

export const LlmSeatRegisterMessage = Schema.Struct({
  ...ContributorMessageBase,
  type: Schema.Literal("register"),
  seat: LlmContributorSeatRegistrationRequest,
});
export type LlmSeatRegisterMessage = typeof LlmSeatRegisterMessage.Type;

export const LlmSeatHeartbeatMessage = Schema.Struct({
  ...ContributorMessageBase,
  type: Schema.Literal("heartbeat"),
  seat_id: SeatId,
  status: Schema.Literals(["healthy", "unavailable", "exhausted"]),
  active: Schema.optional(
    Schema.Number.pipe(
      Schema.check(Schema.isFinite(), Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)),
    ),
  ),
  queue_depth: Schema.optional(
    Schema.Number.pipe(
      Schema.check(Schema.isFinite(), Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)),
    ),
  ),
});
export type LlmSeatHeartbeatMessage = typeof LlmSeatHeartbeatMessage.Type;

export const LlmSeatResultSuccessMessage = Schema.Struct({
  ...ContributorMessageBase,
  type: Schema.Literal("result"),
  job_id: SeatId,
  seat_id: SeatId,
  ok: Schema.Literal(true),
  decision: Schema.Unknown,
  raw_response: Schema.optional(Schema.String),
  resolved_model: Schema.optional(NonEmptyTrimmedString),
  usage: LlmSeatUsage,
});
export type LlmSeatResultSuccessMessage = typeof LlmSeatResultSuccessMessage.Type;

export const LlmSeatResultFailureMessage = Schema.Struct({
  ...ContributorMessageBase,
  type: Schema.Literal("result"),
  job_id: SeatId,
  seat_id: SeatId,
  ok: Schema.Literal(false),
  code: Schema.String.pipe(
    Schema.check(Schema.isTrimmed(), Schema.isNonEmpty(), Schema.isMaxLength(128)),
  ),
  message: Schema.String.pipe(
    Schema.check(Schema.isTrimmed(), Schema.isNonEmpty(), Schema.isMaxLength(2_048)),
  ),
  retryable: Schema.Boolean,
  exhausted: Schema.optional(Schema.Boolean),
  resolved_model: Schema.optional(NonEmptyTrimmedString),
  usage: Schema.optional(LlmSeatUsage),
});
export type LlmSeatResultFailureMessage = typeof LlmSeatResultFailureMessage.Type;

export const LlmSeatResultMessage = Schema.Union([
  LlmSeatResultSuccessMessage,
  LlmSeatResultFailureMessage,
]);
export type LlmSeatResultMessage = typeof LlmSeatResultMessage.Type;

export const LlmSeatInvokeMessage = Schema.Struct({
  ...ContributorMessageBase,
  type: Schema.Literal("invoke"),
  job_id: SeatId,
  seat_id: SeatId,
  deadline_at: Schema.String,
  invocation: Schema.Struct({
    tier: LlmTierAlias,
    model: LlmTierAlias,
    dialect: Schema.Literals(["openai-responses", "anthropic-messages"]),
    prompt: Schema.String,
    response_format: Schema.Literal("stavka-decision-v1"),
  }),
});
export type LlmSeatInvokeMessage = typeof LlmSeatInvokeMessage.Type;

export const LlmSeatRegisteredMessage = Schema.Struct({
  ...ContributorMessageBase,
  type: Schema.Literal("registered"),
  seat_id: SeatId,
  heartbeat_ttl_seconds: Schema.Number.pipe(
    Schema.check(Schema.isFinite(), Schema.isInt(), Schema.isGreaterThan(0)),
  ),
});
export type LlmSeatRegisteredMessage = typeof LlmSeatRegisteredMessage.Type;

export const LlmSeatHeartbeatAckMessage = Schema.Struct({
  ...ContributorMessageBase,
  type: Schema.Literal("heartbeat_ack"),
  seat_id: SeatId,
  expires_at: Schema.String,
});
export type LlmSeatHeartbeatAckMessage = typeof LlmSeatHeartbeatAckMessage.Type;

export const LlmSeatResultAckMessage = Schema.Struct({
  ...ContributorMessageBase,
  type: Schema.Literal("result_ack"),
  job_id: SeatId,
  accepted: Schema.Boolean,
  duplicate: Schema.Boolean,
});
export type LlmSeatResultAckMessage = typeof LlmSeatResultAckMessage.Type;

export const LlmSeatChannelErrorMessage = Schema.Struct({
  ...ContributorMessageBase,
  type: Schema.Literal("error"),
  code: NonEmptyTrimmedString,
  message: NonEmptyTrimmedString,
});
export type LlmSeatChannelErrorMessage = typeof LlmSeatChannelErrorMessage.Type;

export const LlmContributorClientMessage = Schema.Union([
  LlmSeatRegisterMessage,
  LlmSeatHeartbeatMessage,
  LlmSeatResultMessage,
]);
export type LlmContributorClientMessage = typeof LlmContributorClientMessage.Type;

export const LlmContributorServerMessage = Schema.Union([
  LlmSeatInvokeMessage,
  LlmSeatRegisteredMessage,
  LlmSeatHeartbeatAckMessage,
  LlmSeatResultAckMessage,
  LlmSeatChannelErrorMessage,
]);
export type LlmContributorServerMessage = typeof LlmContributorServerMessage.Type;

export const decodeOpenAiResponsesRequest = Schema.decodeUnknownSync(OpenAiResponsesRequest, {
  onExcessProperty: "error",
});
export const decodeAnthropicMessagesRequest = Schema.decodeUnknownSync(AnthropicMessagesRequest, {
  onExcessProperty: "error",
});
export const decodeLlmAliasRemapRequest = Schema.decodeUnknownSync(LlmAliasRemapRequest, {
  onExcessProperty: "error",
});
export const decodeLlmKillSwitchRequest = Schema.decodeUnknownSync(LlmKillSwitchRequest, {
  onExcessProperty: "error",
});
export const decodeLlmSeatRegistrationRequest = Schema.decodeUnknownSync(
  LlmSeatRegistrationRequest,
  { onExcessProperty: "error" },
);
export const decodeLlmContributorClientMessage = Schema.decodeUnknownSync(
  LlmContributorClientMessage,
  { onExcessProperty: "error" },
);
export const decodeLlmContributorServerMessage = Schema.decodeUnknownSync(
  LlmContributorServerMessage,
  { onExcessProperty: "error" },
);
