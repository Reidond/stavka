import { Context, Effect, Layer, Schema } from "effect";
import {
  HttpEffect,
  HttpRouter,
  HttpServer,
  HttpServerRequest,
  HttpServerResponse,
} from "effect/unstable/http";
import { HttpApi, HttpApiBuilder, HttpApiEndpoint, HttpApiGroup } from "effect/unstable/httpapi";
import { authorizeMachine, verifyAccessRequest } from "@stavka/access-auth";
import { ConnectRequest, DisconnectRequest, MapUploadRequest, TickRequest } from "@stavka/protocol";
import handler from "@tanstack/react-start/server-entry";
import { routeAgentRequest } from "agents";

import { accessConfig, type Env } from "./config";

export { SimWorld } from "./sim-world";
export { WarbenchStudyStore } from "./durable-objects/warbench-study-store";

class WorkerBindings extends Context.Service<WorkerBindings, Env>()(
  "stavka/poligon/WorkerBindings",
) {}

class AgentRoutingError extends Schema.TaggedErrorClass<AgentRoutingError>(
  "stavka/poligon/AgentRoutingError",
)("AgentRoutingError", {
  cause: Schema.Defect(),
}) {}

const HealthResponse = Schema.Struct({
  ok: Schema.Literal(true),
  service: Schema.Literal("stavka-poligon"),
  scenarios: Schema.Tuple([
    Schema.Literal("movement"),
    Schema.Literal("engagement"),
    Schema.Literal("mechanized"),
  ]),
  fixed_step_ms: Schema.Literal(100),
});

const AccessRequiredResponse = Schema.Struct({
  error: Schema.Struct({
    code: Schema.Literal("ACCESS_REQUIRED"),
    message: Schema.Literal("Cloudflare Access identity required"),
  }),
});

const AgentNotFoundResponse = Schema.Struct({
  error: Schema.Struct({
    code: Schema.Literal("NOT_FOUND"),
    message: Schema.Literal("Agent not found"),
  }),
});

const healthEndpoint = HttpApiEndpoint.get("health", "/healthz", {
  success: HealthResponse,
});

const responsesEndpoint = HttpApiEndpoint.post("responses", "/v1/responses", {
  success: Schema.Unknown,
});

const messagesEndpoint = HttpApiEndpoint.post("messages", "/v1/messages", {
  success: Schema.Unknown,
});

const healthGroup = HttpApiGroup.make("health").add(healthEndpoint);
const inferenceGroup = HttpApiGroup.make("inference").add(responsesEndpoint, messagesEndpoint);
// The private Commander validates these exact protocol schemas. Raw handlers keep
// the original bytes intact for immutable tick retries and receipt hashing.
const gameGroup = HttpApiGroup.make("game").add(
  HttpApiEndpoint.post("connect", "/api/connect", {
    payload: ConnectRequest,
    success: Schema.Unknown,
  }),
  HttpApiEndpoint.post("tick", "/api/tick", { payload: TickRequest, success: Schema.Unknown }),
  HttpApiEndpoint.post("map", "/api/map", { payload: MapUploadRequest, success: Schema.Unknown }),
  HttpApiEndpoint.post("disconnect", "/api/disconnect", {
    payload: DisconnectRequest,
    success: Schema.Unknown,
  }),
);
const operationsGroup = HttpApiGroup.make("operations").add(
  HttpApiEndpoint.get("inferenceStatus", "/admin/status", { success: Schema.Unknown }),
  HttpApiEndpoint.get("commanderHealth", "/api/system/commander", { success: Schema.Unknown }),
  HttpApiEndpoint.get("sessionExport", "/api/commander/export", {
    query: {
      session_id: Schema.String,
      faction: Schema.String,
      epoch: Schema.optional(Schema.NumberFromString),
    },
    success: Schema.Unknown,
  }),
);
const poligonApi = HttpApi.make("poligon")
  .add(healthGroup)
  .add(inferenceGroup)
  .add(gameGroup)
  .add(operationsGroup);

const HealthHandlersLive = HttpApiBuilder.group(poligonApi, "health", (handlers) =>
  handlers.handle("health", () =>
    Effect.succeed({
      ok: true,
      service: "stavka-poligon",
      scenarios: ["movement", "engagement", "mechanized"],
      fixed_step_ms: 100,
    }),
  ),
);

const accessRequired = HttpServerResponse.schemaJson(AccessRequiredResponse)(
  {
    error: {
      code: "ACCESS_REQUIRED",
      message: "Cloudflare Access identity required",
    },
  },
  { status: 401, headers: { "cache-control": "no-store" } },
);

const agentNotFound = HttpServerResponse.schemaJson(AgentNotFoundResponse)(
  { error: { code: "NOT_FOUND", message: "Agent not found" } },
  { status: 404 },
);

const inferenceUnavailable = HttpServerResponse.jsonUnsafe(
  {
    error: {
      code: "INFERENCE_UNAVAILABLE",
      message: "Provider account service is unavailable",
    },
  },
  { status: 503, headers: { "cache-control": "no-store" } },
);

const withAccess = <E, R>(
  request: HttpServerRequest.HttpServerRequest,
  handle: (
    request: Request,
    env: Env,
  ) => Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>,
) =>
  Effect.gen(function* () {
    const env = yield* WorkerBindings;
    const webRequest = yield* HttpServerRequest.toWeb(request);
    const authorized = yield* verifyAccessRequest(webRequest, accessConfig(env)).pipe(
      Effect.match({
        onFailure: () => false,
        onSuccess: () => true,
      }),
    );

    if (!authorized) return yield* accessRequired;
    return yield* handle(webRequest, env);
  });

const AgentsRoute = HttpRouter.route("*", "/agents/*", (request) =>
  withAccess(request, (webRequest, env) =>
    Effect.gen(function* () {
      const response = yield* Effect.tryPromise({
        try: () => routeAgentRequest(webRequest, env),
        catch: (cause) => new AgentRoutingError({ cause }),
      });
      if (response === null) return yield* agentNotFound;
      // Preserve Cloudflare's non-standard `webSocket` attachment on 101 responses.
      return HttpServerResponse.raw(response, { status: response.status });
    }),
  ),
);

const inferenceAdmin = (request: HttpServerRequest.HttpServerRequest) =>
  withAccess(request, (webRequest, env) => {
    const service = env.INFERENCE_SERVICE;
    if (!service) return Effect.succeed(inferenceUnavailable);
    return Effect.tryPromise({
      try: () => service.fetch(webRequest),
      catch: () => undefined,
    }).pipe(
      Effect.match({
        onFailure: () => inferenceUnavailable,
        onSuccess: HttpServerResponse.fromWeb,
      }),
    );
  }).pipe(Effect.catch(() => Effect.succeed(inferenceUnavailable)));

const InferenceHandlersLive = HttpApiBuilder.group(poligonApi, "inference", (handlers) =>
  handlers
    .handleRaw("responses", ({ request }) => inferenceAdmin(request))
    .handleRaw("messages", ({ request }) => inferenceAdmin(request)),
);

const commanderUnavailable = HttpServerResponse.jsonUnsafe(
  { error: { code: "COMMANDER_UNAVAILABLE", message: "Commander service is unavailable" } },
  { status: 503, headers: { "cache-control": "no-store" } },
);

const gameUnauthorized = HttpServerResponse.jsonUnsafe(
  { error: { code: "MACHINE_AUTH_REQUIRED", message: "Game server authorization required" } },
  { status: 401, headers: { "cache-control": "no-store" } },
);

const gameIngress = (request: HttpServerRequest.HttpServerRequest) =>
  withAccess(request, (webRequest, env) =>
    Effect.gen(function* () {
      const authorized = yield* authorizeMachine(webRequest, env.COMMANDER_API_KEY ?? "").pipe(
        Effect.catch(() => Effect.succeed(false)),
      );
      if (!authorized) return gameUnauthorized;
      const service = env.COMMANDER_SERVICE;
      if (!service) return commanderUnavailable;
      // Forward the caller's machine bearer, epoch and body. Never turn an Access
      // identity into a machine credential or forward the Access client secret.
      const headers = new Headers(webRequest.headers);
      headers.delete("cf-access-client-id");
      headers.delete("cf-access-client-secret");
      return yield* Effect.tryPromise({
        try: (signal) => service.fetch(new Request(webRequest, { headers, signal })),
        catch: (cause) => new AgentRoutingError({ cause }),
      }).pipe(
        Effect.match({
          onFailure: () => commanderUnavailable,
          onSuccess: HttpServerResponse.fromWeb,
        }),
      );
    }),
  ).pipe(Effect.catch(() => Effect.succeed(commanderUnavailable)));

const GameHandlersLive = HttpApiBuilder.group(poligonApi, "game", (handlers) =>
  handlers
    .handleRaw("connect", ({ request }) => gameIngress(request))
    .handleRaw("tick", ({ request }) => gameIngress(request))
    .handleRaw("map", ({ request }) => gameIngress(request))
    .handleRaw("disconnect", ({ request }) => gameIngress(request)),
);

const commanderRead = (
  request: HttpServerRequest.HttpServerRequest,
  path: "/healthz" | "/admin/export",
) =>
  withAccess(request, (webRequest, env) => {
    const service = env.COMMANDER_SERVICE;
    if (!service) return Effect.succeed(commanderUnavailable);
    const url = new URL(webRequest.url);
    url.pathname = path;
    return Effect.tryPromise({
      try: (signal) => service.fetch(new Request(url, { headers: webRequest.headers, signal })),
      catch: () => undefined,
    }).pipe(
      Effect.match({
        onFailure: () => commanderUnavailable,
        onSuccess: HttpServerResponse.fromWeb,
      }),
    );
  }).pipe(Effect.catch(() => Effect.succeed(commanderUnavailable)));

const OperationsHandlersLive = HttpApiBuilder.group(poligonApi, "operations", (handlers) =>
  handlers
    .handleRaw("inferenceStatus", ({ request }) => inferenceAdmin(request))
    .handleRaw("commanderHealth", ({ request }) => commanderRead(request, "/healthz"))
    .handleRaw("sessionExport", ({ request }) => commanderRead(request, "/admin/export")),
);

const HttpApiLive = HttpApiBuilder.layer(poligonApi).pipe(
  Layer.provide(HealthHandlersLive),
  Layer.provide(InferenceHandlersLive),
  Layer.provide(OperationsHandlersLive),
  Layer.provide(GameHandlersLive),
);

const ProviderAccountsRootRoute = HttpRouter.route(
  "GET",
  "/admin/provider-accounts",
  inferenceAdmin,
);

const ExecutionAuthorizationRoute = HttpRouter.route("POST", "/admin/execution/*", inferenceAdmin);

const AccountSessionRoute = HttpRouter.route("GET", "/auth/session", inferenceAdmin);

const AccountSignUpRoute = HttpRouter.route("POST", "/auth/signup", inferenceAdmin);

const OrganizationUsersRoute = HttpRouter.route("GET", "/account/users", inferenceAdmin);

const PutProviderAccountRoute = HttpRouter.route(
  "PUT",
  "/admin/provider-accounts/*",
  inferenceAdmin,
);

const PostProviderAccountRoute = HttpRouter.route(
  "POST",
  "/admin/provider-accounts/*",
  inferenceAdmin,
);

const DeleteProviderAccountRoute = HttpRouter.route(
  "DELETE",
  "/admin/provider-accounts/*",
  inferenceAdmin,
);

const TanStackRoute = HttpRouter.route("*", "/*", (request) =>
  withAccess(request, () =>
    HttpEffect.fromWebHandler((webRequest) => Promise.resolve(handler.fetch(webRequest))),
  ),
);

const RawRoutesLive = HttpRouter.addAll([
  AgentsRoute,
  AccountSessionRoute,
  AccountSignUpRoute,
  OrganizationUsersRoute,
  ProviderAccountsRootRoute,
  ExecutionAuthorizationRoute,
  PutProviderAccountRoute,
  PostProviderAccountRoute,
  DeleteProviderAccountRoute,
  TanStackRoute,
]);

const PoligonLive = Layer.mergeAll(HttpApiLive, RawRoutesLive).pipe(
  Layer.provide(HttpServer.layerServices),
);

const webHandler = HttpRouter.toWebHandler(PoligonLive);

export const handleRequest = (request: Request, env: Env): Promise<Response> =>
  webHandler.handler(request, Context.make(WorkerBindings, env));

export default {
  fetch: handleRequest,
} satisfies ExportedHandler<Env>;
