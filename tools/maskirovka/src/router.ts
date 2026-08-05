import { authorizeMachine, can, verifyAccessRequest } from "@stavka/access-auth";
import {
  AnthropicMessagesRequest,
  decodeLlmAliasRemapRequest,
  decodeLlmKillSwitchRequest,
  LlmAliasRemapRequest,
  LlmKillSwitchRequest,
  OpenAiResponsesRequest,
} from "@stavka/protocol";
import { Cause, Effect, Layer, Schema, Stream } from "effect";
import {
  HttpRouter,
  HttpServer,
  HttpServerRequest,
  HttpServerResponse,
} from "effect/unstable/http";
import { HttpApi, HttpApiBuilder, HttpApiEndpoint, HttpApiGroup } from "effect/unstable/httpapi";

import { MaskirovkaConfiguration, type MaskirovkaConfig } from "./config";
import { normalizeRequest } from "./domain/protocol";
import { GatewayError, seatKinds, tierAliases, type Dialect, type TierAlias } from "./domain/types";
import {
  StaticAssetRepository,
  type StaticAssetRepositoryService,
} from "./repositories/static-asset-repository";
import { Gateway, type GatewayService } from "./services/gateway-service";

const Tier = Schema.Literals(tierAliases);
const Seat = Schema.Literals(seatKinds);
const AliasResolutionResponse = Schema.Struct({
  tier: Tier,
  seat: Seat,
  model: Schema.String,
});
const SeatHealthResponse = Schema.Struct({
  id: Seat,
  name: Schema.String,
  status: Schema.Literals(["healthy", "unavailable", "unchecked", "exhausted"]),
  active: Schema.Number,
  queueDepth: Schema.Number,
  callsInWindow: Schema.Number,
  tokensInWindow: Schema.Number,
  windowResetsAt: Schema.String,
  budgetKind: Schema.Literals(["plan-credit", "metered-cash", "none"]),
  budgetLimitUsd: Schema.Number,
  budgetUsedUsd: Schema.Number,
  headroom: Schema.Struct({
    kind: Schema.Literals([
      "monthly-plan-credit",
      "rolling-plan-window",
      "metered-cash",
      "unlimited",
    ]),
    durable: Schema.Boolean,
    estimated: Schema.Literal(true),
    resetsAt: Schema.String,
    creditLimitUsd: Schema.optional(Schema.Number),
    callLimit: Schema.optional(Schema.Number),
    tokenLimit: Schema.optional(Schema.Number),
    remainingCreditUsd: Schema.optional(Schema.Number),
    remainingCalls: Schema.optional(Schema.Number),
    remainingTokens: Schema.optional(Schema.Number),
  }),
});
const SavingsResponse = Schema.Struct({
  requests: Schema.Number,
  cacheHits: Schema.Number,
  inputTokens: Schema.Number,
  outputTokens: Schema.Number,
  actualCostUsd: Schema.Number,
  planCreditUsd: Schema.Number,
  apiListEquivalentUsd: Schema.Number,
  savedVsApiUsd: Schema.Number,
});
const AccountingResponse = Schema.Struct({
  kind: Schema.Literal("estimate"),
  durable: Schema.Boolean,
  trackedSince: Schema.String,
  note: Schema.String,
});
const GatewayHealthResponse = Schema.Struct({
  ok: Schema.Boolean,
  service: Schema.Literal("maskirovka"),
  mode: Schema.Literals(["live", "record", "replay"]),
  killed: Schema.Boolean,
  aliases: Schema.Array(AliasResolutionResponse),
  seats: Schema.Array(SeatHealthResponse),
  savings: SavingsResponse,
  accounting: AccountingResponse,
});
const ModelsResponse = Schema.Struct({
  object: Schema.Literal("list"),
  data: Schema.Array(
    Schema.Struct({
      id: Tier,
      object: Schema.Literal("model"),
      created: Schema.Number,
      owned_by: Schema.Literal("stavka"),
      resolution: Schema.Struct({ seat: Seat, model: Schema.String }),
    }),
  ),
});
const RequestMetadataResponse = Schema.Struct({
  requestId: Schema.String,
  timestamp: Schema.String,
  tier: Tier,
  seat: Seat,
  model: Schema.String,
  dialect: Schema.Literals(["openai-responses", "anthropic-messages"]),
  mode: Schema.Literals(["live", "record", "replay"]),
  cacheHit: Schema.Boolean,
  queueDepth: Schema.Number,
  latencyMs: Schema.Number,
  inputTokens: Schema.Number,
  outputTokens: Schema.Number,
  actualCostUsd: Schema.Number,
  planCreditUsd: Schema.Number,
  apiListCostUsd: Schema.Number,
  estimatedSavedUsd: Schema.Number,
  fallbackFromSeat: Schema.optional(Seat),
  routingReason: Schema.optional(
    Schema.Literals(["budget-fallback", "unavailable-fallback", "retry-fallback"]),
  ),
});
const RequestsResponse = Schema.Struct({ requests: Schema.Array(RequestMetadataResponse) });
const AliasesResponse = Schema.Struct({ aliases: Schema.Array(AliasResolutionResponse) });
const KillSwitchResponse = Schema.Struct({ killed: Schema.Boolean });
const ProviderResponse = Schema.Unknown;

const PublicApi = HttpApiGroup.make("public").add(
  HttpApiEndpoint.get("health", "/healthz", { success: GatewayHealthResponse }),
  HttpApiEndpoint.get("models", "/v1/models", { success: ModelsResponse }),
);

const ModelApi = HttpApiGroup.make("models").add(
  HttpApiEndpoint.post("responses", "/v1/responses", {
    payload: OpenAiResponsesRequest,
    success: ProviderResponse,
  }),
  HttpApiEndpoint.post("messages", "/v1/messages", {
    payload: AnthropicMessagesRequest,
    success: ProviderResponse,
  }),
);

const AdminApi = HttpApiGroup.make("admin").add(
  HttpApiEndpoint.get("status", "/admin/status", { success: GatewayHealthResponse }),
  HttpApiEndpoint.get("requests", "/admin/requests", {
    query: { limit: Schema.optional(Schema.String) },
    success: RequestsResponse,
  }),
  HttpApiEndpoint.get("aliases", "/admin/aliases", { success: AliasesResponse }),
  HttpApiEndpoint.put("remapAlias", "/admin/aliases/:tier", {
    params: { tier: Schema.String },
    payload: LlmAliasRemapRequest,
    success: AliasesResponse,
  }),
  HttpApiEndpoint.post("killSwitch", "/admin/kill-switch", {
    payload: LlmKillSwitchRequest,
    success: KillSwitchResponse,
  }),
);

const DashboardApi = HttpApiGroup.make("dashboard").add(
  HttpApiEndpoint.get("dashboardRedirect", "/_", { success: Schema.String }),
  HttpApiEndpoint.get("dashboardIndex", "/_/", { success: Schema.String }),
  HttpApiEndpoint.get("dashboardAsset", "/_/:head/*", {
    params: { head: Schema.String, "*": Schema.String },
    success: Schema.String,
  }),
);

export const MaskirovkaApi = HttpApi.make("maskirovka").add(
  PublicApi,
  ModelApi,
  AdminApi,
  DashboardApi,
);

const MAX_JSON_BYTES = 2_000_000;

const errorBody = (error: GatewayError, requestId: string) => ({
  error: {
    type: "maskirovka_error",
    code: error.code,
    message: error.message,
    details: [...error.details],
    request_id: requestId,
    ...(error.resolvedModel ? { resolved_model: error.resolvedModel } : {}),
    ...(error.providerUsage
      ? {
          usage: {
            input_tokens: error.providerUsage.inputTokens,
            output_tokens: error.providerUsage.outputTokens,
            ...(error.providerUsage.cachedInputTokens === undefined
              ? {}
              : { cached_input_tokens: error.providerUsage.cachedInputTokens }),
            ...(error.providerUsage.planCreditUsd === undefined &&
            error.providerUsage.actualCostUsd === undefined
              ? {}
              : {
                  estimated_cost_usd:
                    error.providerUsage.planCreditUsd ?? error.providerUsage.actualCostUsd ?? 0,
                }),
          },
        }
      : {}),
  },
});

const errorResponse = (
  error: GatewayError,
  requestId: string,
): HttpServerResponse.HttpServerResponse =>
  HttpServerResponse.jsonUnsafe(errorBody(error, requestId), {
    status: error.status >= 400 && error.status <= 599 ? error.status : 500,
    headers: { "x-request-id": requestId },
  });

const withErrorEnvelope = <R>(
  requestId: string,
  effect: Effect.Effect<HttpServerResponse.HttpServerResponse, GatewayError, R>,
): Effect.Effect<HttpServerResponse.HttpServerResponse, never, R> =>
  effect.pipe(
    Effect.catch((error) => Effect.succeed(errorResponse(error, requestId))),
    Effect.catchCause((cause) =>
      Cause.hasInterruptsOnly(cause)
        ? Effect.failCause(cause)
        : Effect.logError("Maskirovka request failed", Cause.pretty(cause)).pipe(
            Effect.as(
              errorResponse(
                new GatewayError(500, "INTERNAL_ERROR", "Internal gateway failure"),
                requestId,
              ),
            ),
          ),
    ),
  );

const withTypedErrorEnvelope = <A, R>(
  requestId: string,
  effect: Effect.Effect<A, GatewayError, R>,
): Effect.Effect<A | HttpServerResponse.HttpServerResponse, never, R> =>
  effect.pipe(
    Effect.catch((error) => Effect.succeed(errorResponse(error, requestId))),
    Effect.catchCause((cause) =>
      Cause.hasInterruptsOnly(cause)
        ? Effect.failCause(cause)
        : Effect.logError("Maskirovka request failed", Cause.pretty(cause)).pipe(
            Effect.as(
              errorResponse(
                new GatewayError(500, "INTERNAL_ERROR", "Internal gateway failure"),
                requestId,
              ),
            ),
          ),
    ),
  );

const requireMachine = (
  request: HttpServerRequest.HttpServerRequest,
): Effect.Effect<void, GatewayError, MaskirovkaConfiguration> =>
  Effect.gen(function* () {
    const config = yield* MaskirovkaConfiguration;
    if (!config.apiKey) return;
    const webRequest = yield* HttpServerRequest.toWeb(request).pipe(
      Effect.mapError(
        () =>
          new GatewayError(
            500,
            "AUTH_REQUEST_FAILURE",
            "Unable to reconstruct the original authentication request",
          ),
      ),
    );
    const authorized = yield* authorizeMachine(webRequest, config.apiKey).pipe(
      Effect.mapError((error) => new GatewayError(500, "AUTH_FAILURE", error.message)),
    );
    if (!authorized) {
      return yield* Effect.fail(new GatewayError(401, "UNAUTHORIZED", "Invalid seat bearer token"));
    }
  });

const requireHuman = (
  request: HttpServerRequest.HttpServerRequest,
): Effect.Effect<boolean, GatewayError, MaskirovkaConfiguration> =>
  Effect.gen(function* () {
    const config = yield* MaskirovkaConfiguration;
    if (!config.access) {
      return yield* Effect.fail(
        new GatewayError(401, "ACCESS_REQUIRED", "Cloudflare Access is required"),
      );
    }
    const webRequest = yield* HttpServerRequest.toWeb(request).pipe(
      Effect.mapError(
        () =>
          new GatewayError(
            500,
            "ACCESS_REQUEST_FAILURE",
            "Unable to reconstruct the original Access request",
          ),
      ),
    );
    const identity = yield* verifyAccessRequest(webRequest, config.access).pipe(
      Effect.mapError(
        () =>
          new GatewayError(
            401,
            "ACCESS_REQUIRED",
            "A valid Cloudflare Access identity is required",
          ),
      ),
    );
    if (!can(identity, "read")) {
      return yield* Effect.fail(
        new GatewayError(401, "ACCESS_REQUIRED", "A valid Cloudflare Access identity is required"),
      );
    }
    return can(identity, "admin");
  });

const requireAdminRoute = (
  request: HttpServerRequest.HttpServerRequest,
): Effect.Effect<boolean, GatewayError, MaskirovkaConfiguration> =>
  Effect.gen(function* () {
    const config = yield* MaskirovkaConfiguration;
    if (config.apiKey) {
      const webRequest = yield* HttpServerRequest.toWeb(request).pipe(
        Effect.mapError(
          () =>
            new GatewayError(
              500,
              "AUTH_REQUEST_FAILURE",
              "Unable to reconstruct the original authentication request",
            ),
        ),
      );
      const machine = yield* authorizeMachine(webRequest, config.apiKey).pipe(
        Effect.mapError((error) => new GatewayError(500, "AUTH_FAILURE", error.message)),
      );
      if (machine) return false;
    }
    return yield* requireHuman(request);
  });

interface BodyAccumulator {
  readonly chunks: readonly Uint8Array[];
  readonly length: number;
}

const parseJson = (
  request: HttpServerRequest.HttpServerRequest,
): Effect.Effect<unknown, GatewayError> =>
  Effect.gen(function* () {
    const declaredLength = Number(request.headers["content-length"] ?? "0");
    if (declaredLength > MAX_JSON_BYTES) {
      return yield* Effect.fail(new GatewayError(413, "PAYLOAD_TOO_LARGE", "Payload exceeds 2MB"));
    }

    const accumulated = yield* Stream.runFoldEffect(
      request.stream,
      (): BodyAccumulator => ({ chunks: [], length: 0 }),
      (state, chunk) => {
        const length = state.length + chunk.byteLength;
        return length > MAX_JSON_BYTES
          ? Effect.fail(new GatewayError(413, "PAYLOAD_TOO_LARGE", "Payload exceeds 2MB"))
          : Effect.succeed({ chunks: [...state.chunks, chunk], length });
      },
    ).pipe(
      Effect.mapError((error) =>
        error instanceof GatewayError
          ? error
          : new GatewayError(400, "INVALID_JSON", "Request body must be valid JSON", [
              error instanceof Error ? error.message : "Unable to read request body",
            ]),
      ),
    );

    const bytes = new Uint8Array(accumulated.length);
    let offset = 0;
    for (const chunk of accumulated.chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return yield* Effect.try({
      try: () => JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown,
      catch: (error) =>
        new GatewayError(400, "INVALID_JSON", "Request body must be valid JSON", [
          error instanceof Error ? error.message : "JSON parse error",
        ]),
    });
  });

const decodeBody = <A>(
  request: HttpServerRequest.HttpServerRequest,
  decode: (value: unknown) => A,
): Effect.Effect<A, GatewayError> =>
  parseJson(request).pipe(
    Effect.flatMap((body) =>
      Effect.try({
        try: () => decode(body),
        catch: (error) =>
          error instanceof GatewayError
            ? error
            : new GatewayError(
                400,
                "INVALID_REQUEST",
                "Admin request failed Effect Schema validation",
                [error instanceof Error ? error.message : "Schema validation failed"],
              ),
      }),
    ),
  );

const json = (body: unknown, status = 200): HttpServerResponse.HttpServerResponse =>
  HttpServerResponse.jsonUnsafe(body, { status });

const attachMetadata = (
  response: HttpServerResponse.HttpServerResponse,
  metadata: {
    readonly requestId: string;
    readonly seat: string;
    readonly cacheHit: boolean;
    readonly queueDepth: number;
  },
): HttpServerResponse.HttpServerResponse =>
  HttpServerResponse.setHeaders(response, {
    "x-request-id": metadata.requestId,
    "x-maskirovka-seat": metadata.seat,
    "x-maskirovka-cache": metadata.cacheHit ? "hit" : "miss",
    "x-maskirovka-queue-depth": String(metadata.queueDepth),
  });

const invoke = (
  request: HttpServerRequest.HttpServerRequest,
  dialect: Dialect,
): Effect.Effect<
  HttpServerResponse.HttpServerResponse,
  GatewayError,
  Gateway | MaskirovkaConfiguration
> =>
  Effect.gen(function* () {
    yield* requireMachine(request);
    const body = yield* parseJson(request);
    const normalized = yield* Effect.try({
      try: () => normalizeRequest(dialect, body),
      catch: (error) =>
        error instanceof GatewayError
          ? error
          : new GatewayError(400, "INVALID_REQUEST", "Unable to normalize request"),
    });
    const gateway = yield* Gateway;
    const response = yield* gateway.run(normalized);
    yield* Effect.logInfo(
      [
        response.metadata.tier,
        response.metadata.seat,
        `${response.metadata.inputTokens + response.metadata.outputTokens} tok`,
        `${response.metadata.latencyMs} ms`,
        `queue ${response.metadata.queueDepth}`,
        response.metadata.cacheHit ? "cache hit" : "cache miss",
      ].join(" · "),
    );
    return attachMetadata(json(response.body, response.status), response.metadata);
  });

const PublicHandlers = HttpApiBuilder.group(MaskirovkaApi, "public", (handlers) =>
  handlers
    .handle("health", () =>
      Effect.gen(function* () {
        const gateway = yield* Gateway;
        return yield* gateway.health();
      }),
    )
    .handle("models", () =>
      Effect.gen(function* () {
        const gateway = yield* Gateway;
        return {
          object: "list" as const,
          data: gateway.registry.listAliases().map((alias) => ({
            id: alias.tier,
            object: "model" as const,
            created: 0,
            owned_by: "stavka" as const,
            resolution: { seat: alias.seat, model: alias.model },
          })),
        };
      }),
    ),
);

const ModelHandlers = HttpApiBuilder.group(MaskirovkaApi, "models", (handlers) =>
  handlers
    .handleRaw("responses", ({ request }) => {
      const requestId = crypto.randomUUID();
      return withErrorEnvelope(requestId, invoke(request, "openai-responses"));
    })
    .handleRaw("messages", ({ request }) => {
      const requestId = crypto.randomUUID();
      return withErrorEnvelope(requestId, invoke(request, "anthropic-messages"));
    }),
);

const AdminHandlers = HttpApiBuilder.group(MaskirovkaApi, "admin", (handlers) =>
  handlers
    .handle("status", ({ request }) => {
      const requestId = crypto.randomUUID();
      return withTypedErrorEnvelope(
        requestId,
        Effect.gen(function* () {
          yield* requireAdminRoute(request);
          const gateway = yield* Gateway;
          return yield* gateway.health();
        }),
      );
    })
    .handle("requests", ({ request, query }) => {
      const requestId = crypto.randomUUID();
      return withTypedErrorEnvelope(
        requestId,
        Effect.gen(function* () {
          yield* requireAdminRoute(request);
          const gateway = yield* Gateway;
          return { requests: yield* gateway.latestRequests(Number(query.limit ?? "100")) };
        }),
      );
    })
    .handle("aliases", ({ request }) => {
      const requestId = crypto.randomUUID();
      return withTypedErrorEnvelope(
        requestId,
        Effect.gen(function* () {
          yield* requireAdminRoute(request);
          const gateway = yield* Gateway;
          return { aliases: gateway.registry.listAliases() };
        }),
      );
    })
    .handleRaw("remapAlias", ({ request, params }) => {
      const requestId = crypto.randomUUID();
      return withErrorEnvelope(
        requestId,
        Effect.gen(function* () {
          const admin = yield* requireAdminRoute(request);
          if (!admin) {
            return yield* Effect.fail(
              new GatewayError(403, "FORBIDDEN", "Admin permission required"),
            );
          }
          const tier = decodeURIComponent(params.tier) as TierAlias;
          if (!tierAliases.includes(tier)) {
            return yield* Effect.fail(new GatewayError(404, "UNKNOWN_TIER", "Unknown tier alias"));
          }
          const input = yield* decodeBody(request, decodeLlmAliasRemapRequest);
          const gateway = yield* Gateway;
          return json({
            aliases: yield* gateway.registry.remap(tier, input.seat, input.model),
          });
        }),
      );
    })
    .handleRaw("killSwitch", ({ request }) => {
      const requestId = crypto.randomUUID();
      return withErrorEnvelope(
        requestId,
        Effect.gen(function* () {
          const admin = yield* requireAdminRoute(request);
          if (!admin) {
            return yield* Effect.fail(
              new GatewayError(403, "FORBIDDEN", "Admin permission required"),
            );
          }
          const input = yield* decodeBody(request, decodeLlmKillSwitchRequest);
          const gateway = yield* Gateway;
          return json({ killed: yield* gateway.registry.setKilled(input.enabled) });
        }),
      );
    }),
);

const serveDashboard = (
  request: HttpServerRequest.HttpServerRequest,
  path: string,
): Effect.Effect<
  HttpServerResponse.HttpServerResponse,
  GatewayError,
  StaticAssetRepository | MaskirovkaConfiguration
> =>
  Effect.gen(function* () {
    yield* requireHuman(request);
    const assets = yield* StaticAssetRepository;
    const requested = yield* assets.read(path);
    const asset = requested ?? (yield* assets.read("index.html"));
    if (!asset) {
      return yield* Effect.fail(
        new GatewayError(503, "DASHBOARD_NOT_BUILT", "Run the Maskirovka dashboard build first"),
      );
    }
    return HttpServerResponse.uint8Array(asset.content, {
      contentType: asset.contentType,
      headers: {
        "cache-control":
          requested === undefined || path === "index.html"
            ? "no-cache"
            : "public, max-age=31536000, immutable",
      },
    });
  });

const DashboardHandlers = HttpApiBuilder.group(MaskirovkaApi, "dashboard", (handlers) =>
  handlers
    .handleRaw("dashboardRedirect", ({ request }) => {
      const requestId = crypto.randomUUID();
      return withErrorEnvelope(
        requestId,
        requireHuman(request).pipe(Effect.as(HttpServerResponse.redirect("/_/", { status: 308 }))),
      );
    })
    .handleRaw("dashboardIndex", ({ request }) => {
      const requestId = crypto.randomUUID();
      return withErrorEnvelope(requestId, serveDashboard(request, "index.html"));
    })
    .handleRaw("dashboardAsset", ({ request, params }) => {
      const requestId = crypto.randomUUID();
      return withErrorEnvelope(
        requestId,
        serveDashboard(
          request,
          [params.head, params["*"]].filter(Boolean).join("/") || "index.html",
        ),
      );
    }),
);

const ApiHandlers = Layer.mergeAll(PublicHandlers, ModelHandlers, AdminHandlers, DashboardHandlers);

const NotFoundRoute = HttpRouter.add("*", "*", () => {
  const requestId = crypto.randomUUID();
  return Effect.succeed(
    errorResponse(new GatewayError(404, "NOT_FOUND", "Route not found"), requestId),
  );
});

export interface RouterDependencies {
  readonly config: MaskirovkaConfig;
  readonly service: GatewayService;
  readonly assets: StaticAssetRepositoryService;
}

export const createMaskirovkaApp = ({
  config,
  service,
  assets,
}: RouterDependencies): Layer.Layer<never, never, HttpRouter.HttpRouter> => {
  const dependencies = Layer.mergeAll(
    Layer.succeed(MaskirovkaConfiguration, config),
    Layer.succeed(Gateway, service),
    Layer.succeed(StaticAssetRepository, assets),
  );
  const api = HttpApiBuilder.layer(MaskirovkaApi, {
    openapiPath: "/openapi.json",
  }).pipe(Layer.provide(ApiHandlers));
  return Layer.mergeAll(api, NotFoundRoute).pipe(
    HttpRouter.provideRequest(dependencies),
    Layer.provide(HttpServer.layerServices),
  );
};

export type MaskirovkaApp = ReturnType<typeof createMaskirovkaApp>;
