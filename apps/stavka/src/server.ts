import { Context, Effect, Layer, Schema } from "effect";
import {
  HttpEffect,
  HttpRouter,
  HttpServer,
  HttpServerRequest,
  HttpServerResponse,
} from "effect/unstable/http";
import { HttpApi, HttpApiBuilder, HttpApiEndpoint, HttpApiGroup } from "effect/unstable/httpapi";
import { verifyAccessRequest } from "@stavka/access-auth";
import handler from "@tanstack/react-start/server-entry";
import { routeAgentRequest } from "agents";

import { accessConfig, type Env } from "./config";

export { SimWorld } from "./sim-world";
export { CredentialVault } from "./durable-objects/credential-vault";

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

const healthGroup = HttpApiGroup.make("health").add(healthEndpoint);
const poligonApi = HttpApi.make("poligon").add(healthGroup);

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

const HttpApiLive = HttpApiBuilder.layer(poligonApi).pipe(Layer.provide(HealthHandlersLive));

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

const TanStackRoute = HttpRouter.route("*", "/*", (request) =>
  withAccess(request, () =>
    HttpEffect.fromWebHandler((webRequest) => Promise.resolve(handler.fetch(webRequest))),
  ),
);

const RawRoutesLive = HttpRouter.addAll([AgentsRoute, TanStackRoute]);

const PoligonLive = Layer.mergeAll(HttpApiLive, RawRoutesLive).pipe(
  Layer.provide(HttpServer.layerServices),
);

const webHandler = HttpRouter.toWebHandler(PoligonLive);

export const handleRequest = (request: Request, env: Env): Promise<Response> =>
  webHandler.handler(request, Context.make(WorkerBindings, env));

export default {
  fetch: handleRequest,
} satisfies ExportedHandler<Env>;
