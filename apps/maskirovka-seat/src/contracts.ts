import { Effect, Schema } from "effect";

const TextContentBlock = Schema.Struct({
  type: Schema.Literals(["input_text", "output_text", "text"]),
  text: Schema.String,
});

const ResponsesInputMessage = Schema.Struct({
  role: Schema.Literals(["developer", "system", "user", "assistant"]),
  content: Schema.Union([Schema.String, Schema.Array(TextContentBlock)]),
});

const JsonSchemaFormat = Schema.Struct({
  type: Schema.Literal("json_schema"),
  name: Schema.optional(Schema.String),
  schema: Schema.Unknown,
  strict: Schema.optional(Schema.Boolean),
});

const ResponsesText = Schema.Struct({
  format: Schema.optional(
    Schema.Union([Schema.Struct({ type: Schema.Literal("text") }), JsonSchemaFormat]),
  ),
  verbosity: Schema.optional(Schema.Literals(["low", "medium", "high"])),
});

const ResponsesReasoning = Schema.Struct({
  effort: Schema.optional(Schema.Literals(["minimal", "low", "medium", "high", "xhigh", "max"])),
});

export const OpenAIResponsesRequestSchema = Schema.Struct({
  model: Schema.String,
  input: Schema.Union([Schema.String, Schema.Array(ResponsesInputMessage)]),
  instructions: Schema.optional(Schema.String),
  max_output_tokens: Schema.optional(Schema.Number),
  stream: Schema.optional(Schema.Boolean),
  tools: Schema.optional(Schema.Array(Schema.Unknown)),
  text: Schema.optional(ResponsesText),
  reasoning: Schema.optional(ResponsesReasoning),
  previous_response_id: Schema.optional(Schema.String),
});

export type OpenAIResponsesRequest = Schema.Schema.Type<typeof OpenAIResponsesRequestSchema>;

const AnthropicTextBlock = Schema.Struct({
  type: Schema.Literal("text"),
  text: Schema.String,
});

const AnthropicMessage = Schema.Struct({
  role: Schema.Literals(["user", "assistant"]),
  content: Schema.Union([Schema.String, Schema.Array(AnthropicTextBlock)]),
});

const AnthropicJsonOutputFormat = Schema.Struct({
  type: Schema.Literal("json_schema"),
  schema: Schema.Record(Schema.String, Schema.Unknown),
});

const AnthropicOutputConfig = Schema.Struct({
  format: Schema.optional(AnthropicJsonOutputFormat),
});

export const AnthropicMessagesRequestSchema = Schema.Struct({
  model: Schema.String,
  max_tokens: Schema.Number,
  messages: Schema.Array(AnthropicMessage),
  system: Schema.optional(Schema.Union([Schema.String, Schema.Array(AnthropicTextBlock)])),
  stream: Schema.optional(Schema.Boolean),
  tools: Schema.optional(Schema.Array(Schema.Unknown)),
  temperature: Schema.optional(Schema.Number),
  stop_sequences: Schema.optional(Schema.Array(Schema.String)),
  output_config: Schema.optional(AnthropicOutputConfig),
});

export type AnthropicMessagesRequest = Schema.Schema.Type<typeof AnthropicMessagesRequestSchema>;

export class DialectValidationError extends Schema.TaggedErrorClass<DialectValidationError>(
  "stavka/maskirovka-seat/DialectValidationError",
)("DialectValidationError", {
  parameter: Schema.optional(Schema.String),
  message: Schema.String,
}) {}

const invalidDialect = (message: string, parameter?: string): DialectValidationError =>
  new DialectValidationError({ message, ...(parameter ? { parameter } : {}) });

const decodeResponses = Schema.decodeUnknownEffect(OpenAIResponsesRequestSchema);
const decodeMessages = Schema.decodeUnknownEffect(AnthropicMessagesRequestSchema);

export const decodeOpenAIResponsesRequest = (
  input: unknown,
): Effect.Effect<OpenAIResponsesRequest, DialectValidationError> =>
  decodeResponses(input).pipe(
    Effect.mapError((error) => invalidDialect(String(error))),
    Effect.flatMap((request) => {
      if (request.stream) {
        return Effect.fail(
          invalidDialect("Streaming is not supported by subscription seats", "stream"),
        );
      }
      if (request.tools && request.tools.length > 0) {
        return Effect.fail(
          invalidDialect("Tools are disabled on Maskirovka language-model seats", "tools"),
        );
      }
      if (request.max_output_tokens !== undefined && request.max_output_tokens <= 0) {
        return Effect.fail(
          invalidDialect("max_output_tokens must be positive", "max_output_tokens"),
        );
      }
      if (request.max_output_tokens !== undefined) {
        return Effect.fail(
          invalidDialect(
            "The Codex Agent SDK does not expose max_output_tokens",
            "max_output_tokens",
          ),
        );
      }
      if (request.previous_response_id) {
        return Effect.fail(
          invalidDialect(
            "Persistent Responses conversations are not enabled on this seat",
            "previous_response_id",
          ),
        );
      }
      return Effect.succeed(request);
    }),
  );

export const decodeAnthropicMessagesRequest = (
  input: unknown,
): Effect.Effect<AnthropicMessagesRequest, DialectValidationError> =>
  decodeMessages(input).pipe(
    Effect.mapError((error) => invalidDialect(String(error))),
    Effect.flatMap((request) => {
      if (request.stream) {
        return Effect.fail(
          invalidDialect("Streaming is not supported by subscription seats", "stream"),
        );
      }
      if (request.tools && request.tools.length > 0) {
        return Effect.fail(
          invalidDialect("Tools are disabled on Maskirovka language-model seats", "tools"),
        );
      }
      if (!Number.isInteger(request.max_tokens) || request.max_tokens <= 0) {
        return Effect.fail(invalidDialect("max_tokens must be a positive integer", "max_tokens"));
      }
      if (request.messages.length === 0) {
        return Effect.fail(invalidDialect("messages must not be empty", "messages"));
      }
      if (request.temperature !== undefined) {
        return Effect.fail(
          invalidDialect("The Claude Agent SDK does not expose temperature control", "temperature"),
        );
      }
      if (request.stop_sequences && request.stop_sequences.length > 0) {
        return Effect.fail(
          invalidDialect("The Claude Agent SDK does not expose stop_sequences", "stop_sequences"),
        );
      }
      return Effect.succeed(request);
    }),
  );

const contentText = (content: string | ReadonlyArray<{ readonly text: string }>): string =>
  typeof content === "string" ? content : content.map((block) => block.text).join("\n");

export const responsesPrompt = (request: OpenAIResponsesRequest): string => {
  const input =
    typeof request.input === "string"
      ? request.input
      : request.input
          .map((message) => `${message.role.toUpperCase()}: ${contentText(message.content)}`)
          .join("\n\n");
  return [
    "Act as a language model endpoint. Answer the supplied prompt directly. Do not use tools or inspect files.",
    request.instructions ? `INSTRUCTIONS:\n${request.instructions}` : undefined,
    `INPUT:\n${input}`,
  ]
    .filter((part): part is string => part !== undefined)
    .join("\n\n");
};

export const anthropicPrompt = (request: AnthropicMessagesRequest): string =>
  request.messages
    .map((message) => `${message.role.toUpperCase()}: ${contentText(message.content)}`)
    .join("\n\n");

export const anthropicSystem = (request: AnthropicMessagesRequest): string | undefined =>
  request.system === undefined ? undefined : contentText(request.system);

export const outputJsonSchema = (request: OpenAIResponsesRequest): unknown | undefined =>
  request.text?.format?.type === "json_schema" ? request.text.format.schema : undefined;
