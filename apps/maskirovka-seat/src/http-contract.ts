import { Schema } from "effect";
import {
  ProviderAccountNameSchema,
  ProvisionProviderAccountPayloadSchema,
} from "@stavka/provider-auth";
import {
  HttpApi,
  HttpApiEndpoint,
  HttpApiGroup,
  HttpApiMiddleware,
  HttpApiSchema,
  HttpApiSecurity,
} from "effect/unstable/httpapi";

import { AnthropicMessagesRequestSchema, OpenAIResponsesRequestSchema } from "./contracts";
import { HostedAccessRequest, HostedMachineCredential } from "./hosted-seat-runtime";

const ProviderSchema = Schema.Literals(["claude", "codex"]);
const AliasesSchema = Schema.Record(Schema.String, Schema.String);

const ApiErrorFields = {
  error: Schema.Struct({
    code: Schema.String,
    message: Schema.String,
    request_id: Schema.optional(Schema.String),
    param: Schema.optional(Schema.String),
    retryable: Schema.optional(Schema.Boolean),
    resolved_model: Schema.optional(Schema.String),
    usage: Schema.optional(
      Schema.Struct({
        input_tokens: Schema.Number,
        output_tokens: Schema.Number,
        cached_input_tokens: Schema.optional(Schema.Number),
        estimated_cost_usd: Schema.optional(Schema.Number),
      }),
    ),
  }),
};

export class BadRequestError extends Schema.ErrorClass<BadRequestError>(
  "stavka/maskirovka-seat/http/BadRequestError",
)(ApiErrorFields, { httpApiStatus: 400 }) {}

export class UnauthorizedError extends Schema.ErrorClass<UnauthorizedError>(
  "stavka/maskirovka-seat/http/UnauthorizedError",
)(ApiErrorFields, { httpApiStatus: 401 }) {}

export class ForbiddenError extends Schema.ErrorClass<ForbiddenError>(
  "stavka/maskirovka-seat/http/ForbiddenError",
)(ApiErrorFields, { httpApiStatus: 403 }) {}

export class NotFoundError extends Schema.ErrorClass<NotFoundError>(
  "stavka/maskirovka-seat/http/NotFoundError",
)(ApiErrorFields, { httpApiStatus: 404 }) {}

export class PayloadTooLargeError extends Schema.ErrorClass<PayloadTooLargeError>(
  "stavka/maskirovka-seat/http/PayloadTooLargeError",
)(ApiErrorFields, { httpApiStatus: 413 }) {}

export class UnsupportedMediaTypeError extends Schema.ErrorClass<UnsupportedMediaTypeError>(
  "stavka/maskirovka-seat/http/UnsupportedMediaTypeError",
)(ApiErrorFields, { httpApiStatus: 415 }) {}

export class BadGatewayError extends Schema.ErrorClass<BadGatewayError>(
  "stavka/maskirovka-seat/http/BadGatewayError",
)(ApiErrorFields, { httpApiStatus: 502 }) {}

export class ServiceUnavailableError extends Schema.ErrorClass<ServiceUnavailableError>(
  "stavka/maskirovka-seat/http/ServiceUnavailableError",
)(ApiErrorFields, { httpApiStatus: 503 }) {}

export class TooManyRequestsError extends Schema.ErrorClass<TooManyRequestsError>(
  "stavka/maskirovka-seat/http/TooManyRequestsError",
)(ApiErrorFields, { httpApiStatus: 429 }) {}

export class GatewayTimeoutError extends Schema.ErrorClass<GatewayTimeoutError>(
  "stavka/maskirovka-seat/http/GatewayTimeoutError",
)(ApiErrorFields, { httpApiStatus: 504 }) {}

const HostedSeatStatusFields = {
  ok: Schema.Boolean,
  service: Schema.Literal("stavka-maskirovka-seat"),
  seat_id: Schema.String,
  provider: ProviderSchema,
  aliases: AliasesSchema,
  container: Schema.Struct({
    status: Schema.String,
    last_change: Schema.Number,
  }),
  auth: Schema.Struct({
    configured: Schema.Boolean,
    persisted: Schema.Boolean,
    revision: Schema.Number,
    updated_at: Schema.optional(Schema.Number),
  }),
  controls: Schema.Struct({
    killed: Schema.Boolean,
    updated_at: Schema.Number,
  }),
};

export const HostedSeatStatusSchema = Schema.Struct(HostedSeatStatusFields);

const HostedSeatOperationsFields = {
  ...HostedSeatStatusFields,
  requests: Schema.Struct({
    retained: Schema.Number,
    limit: Schema.Literal(200),
    metadata_only: Schema.Literal(true),
  }),
  capabilities: Schema.Struct({
    scope: Schema.Literal("single-hosted-seat"),
    tier_remap: Schema.Literal("model-only"),
    kill_switch: Schema.Literal("this-seat-only"),
    unsupported: Schema.Array(Schema.String),
  }),
};

export const HostedSeatAdminStatusSchema = Schema.Struct({
  ...HostedSeatOperationsFields,
  access: Schema.Struct({
    role: Schema.Literals(["owner", "operator", "spectator", "automation"]),
    can_admin: Schema.Boolean,
    service_token: Schema.Boolean,
  }),
});

export const HostedSeatRequestLogSchema = Schema.Struct({
  request_id: Schema.String,
  timestamp: Schema.Number,
  dialect: Schema.Literals(["openai-responses", "anthropic-messages"]),
  alias: Schema.String,
  model: Schema.String,
  status: Schema.Number,
  latency_ms: Schema.Number,
  queue_depth: Schema.Number,
});

export const HostedSeatRequestsSchema = Schema.Struct({
  requests: Schema.Array(HostedSeatRequestLogSchema),
});

export const HostedModelsSchema = Schema.Struct({
  object: Schema.Literal("list"),
  data: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      object: Schema.Literal("model"),
      created: Schema.Number,
      owned_by: Schema.String,
      resolution: Schema.Struct({
        seat_id: Schema.String,
        provider: ProviderSchema,
        model: Schema.String,
      }),
    }),
  ),
});

export const ContainerHealthSchema = Schema.Struct({
  ok: Schema.Boolean,
  service: Schema.Literal("stavka-maskirovka-seat-container"),
  seat_id: Schema.String,
  provider: ProviderSchema,
  models: Schema.Array(Schema.String),
  now: Schema.Number,
});

export const ContainerModelsSchema = Schema.Struct({
  object: Schema.Literal("list"),
  data: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      object: Schema.Literal("model"),
      owned_by: Schema.String,
      resolution: Schema.Struct({ model: Schema.String }),
    }),
  ),
});

export const OpenAIResponsesResultSchema = Schema.Struct({
  id: Schema.String,
  object: Schema.Literal("response"),
  created_at: Schema.Number,
  status: Schema.Literal("completed"),
  error: Schema.Null,
  incomplete_details: Schema.Null,
  model: Schema.String,
  output: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      type: Schema.Literal("message"),
      status: Schema.Literal("completed"),
      role: Schema.Literal("assistant"),
      content: Schema.Array(
        Schema.Struct({
          type: Schema.Literal("output_text"),
          text: Schema.String,
          annotations: Schema.Array(Schema.Unknown),
        }),
      ),
    }),
  ),
  output_text: Schema.String,
  usage: Schema.Struct({
    input_tokens: Schema.Number,
    input_tokens_details: Schema.Struct({ cached_tokens: Schema.Number }),
    output_tokens: Schema.Number,
    output_tokens_details: Schema.Struct({ reasoning_tokens: Schema.Number }),
    total_tokens: Schema.Number,
  }),
});

export type OpenAIResponsesResult = Schema.Schema.Type<typeof OpenAIResponsesResultSchema>;

export const AnthropicMessagesResultSchema = Schema.Struct({
  id: Schema.String,
  type: Schema.Literal("message"),
  role: Schema.Literal("assistant"),
  model: Schema.String,
  content: Schema.Array(
    Schema.Struct({
      type: Schema.Literal("text"),
      text: Schema.String,
    }),
  ),
  stop_reason: Schema.String,
  stop_sequence: Schema.Null,
  usage: Schema.Struct({
    input_tokens: Schema.Number,
    output_tokens: Schema.Number,
  }),
});

export type AnthropicMessagesResult = Schema.Schema.Type<typeof AnthropicMessagesResultSchema>;

const AnthropicHeaders = Schema.Struct({
  "anthropic-version": Schema.optional(Schema.String),
});

const PublicErrors = [
  BadRequestError,
  UnauthorizedError,
  NotFoundError,
  PayloadTooLargeError,
  UnsupportedMediaTypeError,
  ServiceUnavailableError,
] as const;

const HumanErrors = [
  BadRequestError,
  UnauthorizedError,
  ForbiddenError,
  NotFoundError,
  ServiceUnavailableError,
] as const;

const ContainerErrors = [
  BadRequestError,
  NotFoundError,
  PayloadTooLargeError,
  UnsupportedMediaTypeError,
  BadGatewayError,
  ServiceUnavailableError,
  TooManyRequestsError,
  GatewayTimeoutError,
] as const;

export class MachineAuth extends HttpApiMiddleware.Service<
  MachineAuth,
  { provides: HostedMachineCredential }
>()("stavka/maskirovka-seat/http/MachineAuth", {
  security: { bearer: HttpApiSecurity.bearer },
  error: [UnauthorizedError, ServiceUnavailableError],
}) {}

export class HumanAccess extends HttpApiMiddleware.Service<
  HumanAccess,
  { provides: HostedAccessRequest }
>()("stavka/maskirovka-seat/http/HumanAccess", {
  error: [UnauthorizedError, ForbiddenError, ServiceUnavailableError],
}) {}

const HostedSeatGroup = HttpApiGroup.make("seat")
  .add(
    HttpApiEndpoint.get("health", "/healthz", {
      success: HostedSeatStatusSchema,
      error: PublicErrors,
    }),
    HttpApiEndpoint.get("models", "/v1/models", {
      success: HostedModelsSchema,
      error: PublicErrors,
    }),
    HttpApiEndpoint.post("responses", "/v1/responses", {
      payload: OpenAIResponsesRequestSchema,
      success: OpenAIResponsesResultSchema,
      error: PublicErrors,
    }),
    HttpApiEndpoint.post("messages", "/v1/messages", {
      headers: AnthropicHeaders,
      payload: AnthropicMessagesRequestSchema,
      success: AnthropicMessagesResultSchema,
      error: PublicErrors,
    }),
    HttpApiEndpoint.post("legacyChatCompletions", "/v1/chat/completions", {
      success: Schema.Unknown.pipe(HttpApiSchema.status(404)),
      error: PublicErrors,
    }),
    HttpApiEndpoint.get("notFoundGet", "/*", {
      success: Schema.Unknown.pipe(HttpApiSchema.status(404)),
      error: PublicErrors,
    }),
    HttpApiEndpoint.post("notFoundPost", "/*", {
      success: Schema.Unknown.pipe(HttpApiSchema.status(404)),
      error: PublicErrors,
    }),
    HttpApiEndpoint.put("notFoundPut", "/*", {
      success: Schema.Unknown.pipe(HttpApiSchema.status(404)),
      error: PublicErrors,
    }),
    HttpApiEndpoint.patch("notFoundPatch", "/*", {
      success: Schema.Unknown.pipe(HttpApiSchema.status(404)),
      error: PublicErrors,
    }),
    HttpApiEndpoint.delete("notFoundDelete", "/*", {
      success: Schema.Unknown.pipe(HttpApiSchema.status(404)),
      error: PublicErrors,
    }),
    HttpApiEndpoint.head("notFoundHead", "/*", {
      success: Schema.Unknown.pipe(HttpApiSchema.status(404)),
      error: PublicErrors,
    }),
    HttpApiEndpoint.options("notFoundOptions", "/*", {
      success: Schema.Unknown.pipe(HttpApiSchema.status(404)),
      error: PublicErrors,
    }),
    HttpApiEndpoint.make("TRACE")("notFoundTrace", "/*", {
      success: Schema.Unknown.pipe(HttpApiSchema.status(404)),
      error: PublicErrors,
    }),
  )
  .middleware(MachineAuth);

const RequestLimitSchema = Schema.NumberFromString.pipe(
  Schema.check(Schema.isFinite(), Schema.isInt(), Schema.isBetween({ minimum: 1, maximum: 200 })),
);
const ModelNameSchema = Schema.String.pipe(
  Schema.check(Schema.isTrimmed(), Schema.isNonEmpty(), Schema.isMaxLength(256)),
);
export const HostedAliasRemapRequestSchema = Schema.Struct({ model: ModelNameSchema });
export const HostedKillSwitchRequestSchema = Schema.Struct({ enabled: Schema.Boolean });

const HostedAdminGroup = HttpApiGroup.make("admin")
  .add(
    HttpApiEndpoint.get("status", "/admin/status", {
      success: HostedSeatAdminStatusSchema,
      error: HumanErrors,
    }),
    HttpApiEndpoint.get("requests", "/admin/requests", {
      query: { limit: Schema.optional(RequestLimitSchema) },
      success: HostedSeatRequestsSchema,
      error: HumanErrors,
    }),
    HttpApiEndpoint.put("remapAlias", "/admin/aliases/:alias", {
      params: { alias: Schema.String },
      payload: HostedAliasRemapRequestSchema,
      success: HostedSeatAdminStatusSchema,
      error: HumanErrors,
    }),
    HttpApiEndpoint.post("killSwitch", "/admin/kill-switch", {
      payload: HostedKillSwitchRequestSchema,
      success: HostedSeatAdminStatusSchema,
      error: HumanErrors,
    }),
    HttpApiEndpoint.get("providerAccounts", "/admin/provider-accounts", {
      success: Schema.Unknown,
      error: HumanErrors,
    }),
    HttpApiEndpoint.put("putProviderAccount", "/admin/provider-accounts/:provider/:name", {
      params: { provider: ProviderSchema, name: ProviderAccountNameSchema },
      payload: ProvisionProviderAccountPayloadSchema,
      success: Schema.Unknown,
      error: HumanErrors,
    }),
    HttpApiEndpoint.post("testProviderAccount", "/admin/provider-accounts/:provider/:name/test", {
      params: { provider: ProviderSchema, name: ProviderAccountNameSchema },
      success: Schema.Unknown,
      error: HumanErrors,
    }),
    HttpApiEndpoint.delete("deleteProviderAccount", "/admin/provider-accounts/:provider/:name", {
      params: { provider: ProviderSchema, name: ProviderAccountNameSchema },
      success: Schema.Unknown,
      error: HumanErrors,
    }),
  )
  .middleware(HumanAccess);

const HostedDashboardGroup = HttpApiGroup.make("dashboard")
  .add(
    HttpApiEndpoint.get("index", "/_", {
      success: Schema.String,
      error: HumanErrors,
    }),
    HttpApiEndpoint.get("asset", "/_/:head/*", {
      params: { head: Schema.String, "*": Schema.String },
      success: Schema.String,
      error: HumanErrors,
    }),
  )
  .middleware(HumanAccess);

export const HostedSeatApi = HttpApi.make("maskirovka-hosted-seat").add(
  HostedSeatGroup,
  HostedAdminGroup,
  HostedDashboardGroup,
);

const ContainerGroup = HttpApiGroup.make("container").add(
  HttpApiEndpoint.get("health", "/healthz", {
    success: ContainerHealthSchema,
    error: ContainerErrors,
  }),
  HttpApiEndpoint.get("models", "/v1/models", {
    success: ContainerModelsSchema,
    error: ContainerErrors,
  }),
  HttpApiEndpoint.post("responses", "/v1/responses", {
    payload: OpenAIResponsesRequestSchema,
    success: OpenAIResponsesResultSchema,
    error: ContainerErrors,
  }),
  HttpApiEndpoint.post("messages", "/v1/messages", {
    payload: AnthropicMessagesRequestSchema,
    success: AnthropicMessagesResultSchema,
    error: ContainerErrors,
  }),
  HttpApiEndpoint.post("legacyChatCompletions", "/v1/chat/completions", {
    success: Schema.Unknown.pipe(HttpApiSchema.status(404)),
    error: ContainerErrors,
  }),
);

export const ContainerApi = HttpApi.make("maskirovka-seat-container").add(ContainerGroup);
