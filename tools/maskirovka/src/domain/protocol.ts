import {
  GatewayError,
  tierAliases,
  type Dialect,
  type NormalizedRequest,
  type SeatResult,
  type TierAlias,
} from "./types";
import { decodeAnthropicMessagesRequest, decodeOpenAiResponsesRequest } from "@stavka/protocol";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const assertTier = (value: unknown): TierAlias => {
  if (typeof value === "string" && tierAliases.includes(value as TierAlias)) {
    return value as TierAlias;
  }
  throw new GatewayError(400, "UNKNOWN_TIER", `model must be one of ${tierAliases.join(", ")}`);
};

const textFromPart = (part: unknown): string => {
  if (typeof part === "string") return part;
  if (!isRecord(part)) return "";
  if (typeof part.text === "string") return part.text;
  if (typeof part.content === "string") return part.content;
  if (Array.isArray(part.content)) return part.content.map(textFromPart).filter(Boolean).join("\n");
  return "";
};

const textFromMessages = (messages: unknown): string => {
  if (!Array.isArray(messages)) return "";
  return messages
    .map((message) => {
      if (!isRecord(message)) return "";
      const text = textFromPart(message);
      return text ? `${String(message.role ?? "user")}: ${text}` : "";
    })
    .filter(Boolean)
    .join("\n");
};

const schemaFromOpenAi = (
  request: Record<string, unknown>,
): Readonly<Record<string, unknown>> | undefined => {
  if (!isRecord(request.text) || !isRecord(request.text.format)) return undefined;
  return isRecord(request.text.format.schema) ? request.text.format.schema : undefined;
};

const structuredOutputFromAnthropic = (
  request: Record<string, unknown>,
):
  | {
      readonly schema: Readonly<Record<string, unknown>>;
      readonly name?: string;
    }
  | undefined => {
  if (
    isRecord(request.output_config) &&
    isRecord(request.output_config.format) &&
    isRecord(request.output_config.format.schema)
  ) {
    return { schema: request.output_config.format.schema };
  }
  if (!Array.isArray(request.tools)) return undefined;
  const requestedName =
    isRecord(request.tool_choice) && typeof request.tool_choice.name === "string"
      ? request.tool_choice.name
      : undefined;
  const tool = request.tools.find(
    (candidate) => isRecord(candidate) && (!requestedName || candidate.name === requestedName),
  );
  if (!isRecord(tool) || !isRecord(tool.input_schema)) return undefined;
  return {
    schema: tool.input_schema,
    ...(typeof tool.name === "string" ? { name: tool.name } : {}),
  };
};

export const normalizeRequest = (dialect: Dialect, value: unknown): NormalizedRequest => {
  if (!isRecord(value))
    throw new GatewayError(400, "INVALID_REQUEST", "Request body must be an object");
  try {
    if (dialect === "openai-responses") decodeOpenAiResponsesRequest(value);
    else decodeAnthropicMessagesRequest(value);
  } catch (error) {
    throw new GatewayError(400, "INVALID_REQUEST", "Request failed Effect Schema validation", [
      error instanceof Error ? error.message : "Schema validation failed",
    ]);
  }
  if (value.stream === true) {
    throw new GatewayError(400, "UNSUPPORTED_PARAMETER", "Streaming is not supported", [
      "param=stream",
    ]);
  }
  if (Array.isArray(value.tools) && value.tools.length > 0) {
    throw new GatewayError(
      400,
      "UNSUPPORTED_PARAMETER",
      "Tools are disabled on language-model seats",
      ["param=tools"],
    );
  }
  if (dialect === "openai-responses") {
    if (value.max_output_tokens !== undefined) {
      throw new GatewayError(
        400,
        "UNSUPPORTED_PARAMETER",
        "The Codex Agent SDK does not expose max_output_tokens",
        ["param=max_output_tokens"],
      );
    }
    if (typeof value.previous_response_id === "string" && value.previous_response_id) {
      throw new GatewayError(
        400,
        "UNSUPPORTED_PARAMETER",
        "Persistent Responses conversations are not enabled",
        ["param=previous_response_id"],
      );
    }
  } else {
    if (!Number.isInteger(value.max_tokens) || (value.max_tokens as number) <= 0) {
      throw new GatewayError(400, "INVALID_REQUEST", "max_tokens must be a positive integer", [
        "param=max_tokens",
      ]);
    }
    if (value.temperature !== undefined) {
      throw new GatewayError(
        400,
        "UNSUPPORTED_PARAMETER",
        "The Claude Agent SDK does not expose temperature control",
        ["param=temperature"],
      );
    }
    if (Array.isArray(value.stop_sequences) && value.stop_sequences.length > 0) {
      throw new GatewayError(
        400,
        "UNSUPPORTED_PARAMETER",
        "The Claude Agent SDK does not expose stop_sequences",
        ["param=stop_sequences"],
      );
    }
  }
  const tier = assertTier(value.model);
  const input =
    dialect === "openai-responses"
      ? typeof value.input === "string"
        ? value.input
        : textFromMessages(value.input)
      : textFromMessages(value.messages);
  if (!input.trim())
    throw new GatewayError(400, "INVALID_REQUEST", "Request must contain textual input");
  const systemValue = dialect === "openai-responses" ? value.instructions : value.system;
  const system = typeof systemValue === "string" ? systemValue : textFromPart(systemValue);
  const anthropicOutput =
    dialect === "anthropic-messages" ? structuredOutputFromAnthropic(value) : undefined;
  const outputSchema =
    dialect === "openai-responses" ? schemaFromOpenAi(value) : anthropicOutput?.schema;
  return {
    dialect,
    tier,
    request: value,
    prompt: input,
    ...(system ? { system } : {}),
    ...(outputSchema ? { outputSchema } : {}),
    ...(anthropicOutput?.name ? { structuredOutputName: anthropicOutput.name } : {}),
  };
};

const nowSeconds = (): number => Math.floor(Date.now() / 1_000);

export const openAiResponse = (
  requestId: string,
  model: string,
  result: SeatResult,
): Readonly<Record<string, unknown>> => {
  const text = result.structured === undefined ? result.text : JSON.stringify(result.structured);
  const inputTokens = result.usage.inputTokens;
  const outputTokens = result.usage.outputTokens;
  return {
    id: `resp_${requestId.replaceAll("-", "")}`,
    object: "response",
    created_at: nowSeconds(),
    status: "completed",
    error: null,
    incomplete_details: null,
    instructions: null,
    model,
    output: [
      {
        id: `msg_${requestId.replaceAll("-", "")}`,
        type: "message",
        status: "completed",
        role: "assistant",
        content: [{ type: "output_text", text, annotations: [], logprobs: [] }],
      },
    ],
    output_text: text,
    parallel_tool_calls: true,
    tools: [],
    tool_choice: "auto",
    metadata: {},
    temperature: null,
    top_p: null,
    usage: {
      input_tokens: inputTokens,
      input_tokens_details: { cached_tokens: result.usage.cachedInputTokens ?? 0 },
      output_tokens: outputTokens,
      output_tokens_details: { reasoning_tokens: 0 },
      total_tokens: inputTokens + outputTokens,
    },
  };
};

export const anthropicMessage = (
  requestId: string,
  model: string,
  result: SeatResult,
  structuredOutputName?: string,
): Readonly<Record<string, unknown>> => {
  const text = result.structured === undefined ? result.text : JSON.stringify(result.structured);
  return {
    id: `msg_${requestId.replaceAll("-", "")}`,
    type: "message",
    role: "assistant",
    model,
    content:
      structuredOutputName && result.structured !== undefined
        ? [
            {
              type: "tool_use",
              id: `toolu_${requestId.replaceAll("-", "")}`,
              name: structuredOutputName,
              input: result.structured,
            },
          ]
        : [{ type: "text", text }],
    stop_reason: structuredOutputName && result.structured !== undefined ? "tool_use" : "end_turn",
    stop_sequence: null,
    container: null,
    usage: {
      cache_creation: null,
      input_tokens: result.usage.inputTokens,
      output_tokens: result.usage.outputTokens,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: result.usage.cachedInputTokens ?? 0,
      inference_geo: null,
      service_tier: null,
    },
  };
};
