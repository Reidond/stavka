import { can, verifyAccessRequest, type AccessIdentity } from "@stavka/access-auth";
import { Context, Effect, Layer, Redacted, Schema } from "effect";
import {
  HttpRouter,
  HttpServer,
  HttpServerRequest,
  HttpServerResponse,
} from "effect/unstable/http";
import { HttpApiBuilder } from "effect/unstable/httpapi";

import { authorizeMachineCredential } from "./machine-auth";
import {
  decodeAnthropicMessagesRequest,
  decodeOpenAIResponsesRequest,
  type AnthropicMessagesRequest,
  type OpenAIResponsesRequest,
} from "./contracts";
import { hostedAccessConfig, readSeatConfig, type SeatEnv, type SeatProvider } from "./config";
import {
  BadRequestError,
  ForbiddenError,
  HostedAliasRemapRequestSchema,
  HostedSeatApi,
  HostedKillSwitchRequestSchema,
  HumanAccess,
  MachineAuth,
  NotFoundError,
  PayloadTooLargeError,
  ServiceUnavailableError,
  UnauthorizedError,
  UnsupportedMediaTypeError,
} from "./http-contract";
import {
  HostedAccessRequest,
  HostedMachineCredential,
  HostedSeatRuntime,
  type HostedSeatOperationsStatus,
  type HostedSeatStub,
  type HostedSeatRuntimeShape,
} from "./hosted-seat-runtime";
import { readBoundedJson, RequestBodyError } from "./request-body";

export type { HostedSeatStub } from "./hosted-seat-runtime";

export interface SeatRouterDependencies {
  readonly resolveSeat?: (env: SeatEnv) => HostedSeatStub;
}

const defaultSeatResolver = (env: SeatEnv): HostedSeatStub =>
  env.MASKIROVKA_SEAT.getByName(env.SEAT_ID);

const errorBody = (code: string, message: string, parameter?: string) => ({
  error: {
    code,
    message,
    request_id: crypto.randomUUID(),
    ...(parameter ? { param: parameter } : {}),
  },
});

const badRequest = (code: string, message: string, parameter?: string): BadRequestError =>
  new BadRequestError(errorBody(code, message, parameter));

const notFound = (code: string, message: string, parameter?: string): NotFoundError =>
  new NotFoundError(errorBody(code, message, parameter));

const forbidden = (code: string, message: string): ForbiddenError =>
  new ForbiddenError(errorBody(code, message));

const unavailable = (code: string, message: string): ServiceUnavailableError =>
  new ServiceUnavailableError(errorBody(code, message));

const authorizeRequest = (
  runtime: HostedSeatRuntimeShape,
  supplied: string,
): Effect.Effect<void, UnauthorizedError | ServiceUnavailableError> => {
  const secret = runtime.env.MASKIROVKA_SEAT_KEY;
  if (!secret) {
    return Effect.fail(unavailable("MISCONFIGURED", "MASKIROVKA_SEAT_KEY is not configured"));
  }
  return authorizeMachineCredential(supplied, secret).pipe(
    Effect.flatMap((authorized) =>
      authorized
        ? Effect.void
        : Effect.fail(
            new UnauthorizedError(errorBody("UNAUTHORIZED", "A valid seat bearer key is required")),
          ),
    ),
  );
};

const seatOperation = <A>(
  operation: string,
  evaluate: () => Promise<A>,
): Effect.Effect<A, ServiceUnavailableError> =>
  Effect.tryPromise({
    try: evaluate,
    catch: (cause) =>
      unavailable(
        "SEAT_UNAVAILABLE",
        cause instanceof Error ? cause.message : `Hosted seat ${operation} failed`,
      ),
  });

const adminStatus = (status: HostedSeatOperationsStatus, identity: AccessIdentity) => ({
  ...status,
  access: {
    role: identity.role,
    can_admin: can(identity, "admin"),
    service_token: identity.serviceToken,
  },
});

const requireMachine = Effect.gen(function* () {
  const runtime = yield* HostedSeatRuntime;
  const credential = yield* HostedMachineCredential;
  yield* authorizeRequest(runtime, credential.value);
});

const requireHuman = (permission: "read" | "admin") =>
  Effect.gen(function* () {
    const runtime = yield* HostedSeatRuntime;
    const accessRequest = yield* HostedAccessRequest;
    const identity = yield* verifyAccessRequest(
      accessRequest.request,
      hostedAccessConfig(runtime.env),
    ).pipe(
      Effect.mapError(
        () =>
          new UnauthorizedError(
            errorBody("ACCESS_REQUIRED", "A valid Cloudflare Access identity is required"),
          ),
      ),
    );
    if (!can(identity, permission)) {
      return yield* Effect.fail(
        forbidden(
          "FORBIDDEN",
          permission === "admin"
            ? "Admin permission is required"
            : "Read permission is required for hosted operations",
        ),
      );
    }
    return identity;
  });

const decodeBody = <T, E>(
  request: Parameters<typeof readBoundedJson>[0],
  decode: (input: unknown) => Effect.Effect<T, E>,
): Effect.Effect<T, BadRequestError | PayloadTooLargeError | UnsupportedMediaTypeError> =>
  readBoundedJson(request).pipe(
    Effect.flatMap(decode),
    Effect.mapError((error) => {
      if (error instanceof RequestBodyError) {
        if (error.code === "PAYLOAD_TOO_LARGE") {
          return new PayloadTooLargeError(errorBody(error.code, error.message));
        }
        if (error.code === "UNSUPPORTED_ENCODING") {
          return new UnsupportedMediaTypeError(errorBody(error.code, error.message));
        }
        return badRequest(error.code, error.message);
      }
      const dialectError = error as { readonly message?: unknown; readonly parameter?: unknown };
      return badRequest(
        "INVALID_REQUEST",
        typeof dialectError.message === "string" ? dialectError.message : "Invalid request",
        typeof dialectError.parameter === "string" ? dialectError.parameter : undefined,
      );
    }),
  );

const resolveModel = (
  provider: SeatProvider,
  aliases: Readonly<Record<string, string>>,
  requested: string,
): Effect.Effect<string, NotFoundError> => {
  const model = aliases[requested];
  return model
    ? Effect.succeed(model)
    : Effect.fail(
        notFound(
          "MODEL_NOT_FOUND",
          `Model alias ${requested} is not served by this ${provider} seat`,
          "model",
        ),
      );
};

const internalHeaders = (
  headers: Readonly<Record<string, string | undefined>>,
  alias: string,
  model: string,
  dialect: "openai-responses" | "anthropic-messages",
): Headers => {
  const forwarded = new Headers({
    "content-type": "application/json",
    // Never persist a caller-controlled correlation value in the hosted request log.
    "x-maskirovka-request-id": crypto.randomUUID(),
    "x-maskirovka-alias": alias,
    "x-maskirovka-model": model,
    "x-maskirovka-dialect": dialect,
  });
  for (const name of [
    "accept",
    "anthropic-beta",
    "anthropic-version",
    "traceparent",
    "tracestate",
  ]) {
    const value = headers[name];
    if (value) forwarded.set(name, value);
  }
  return forwarded;
};

const proxyResponse = (
  response: Response,
  seatId: string,
  provider: SeatProvider,
  model: string,
  requestId: string,
): HttpServerResponse.HttpServerResponse => {
  const headers = new Headers(response.headers);
  headers.set("x-maskirovka-seat-id", seatId);
  headers.set("x-maskirovka-seat-provider", provider);
  headers.set("x-maskirovka-model", model);
  headers.set("x-request-id", requestId);
  headers.set("cache-control", "no-store");
  return HttpServerResponse.fromWeb(
    new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    }),
  );
};

const invokeSeat = (
  stub: HostedSeatStub,
  path: "/v1/responses" | "/v1/messages",
  headers: Headers,
  body: OpenAIResponsesRequest | AnthropicMessagesRequest,
): Effect.Effect<Response, ServiceUnavailableError> =>
  Effect.tryPromise({
    try: (signal) =>
      stub.fetch(
        new Request(`http://maskirovka-container${path}`, {
          method: "POST",
          headers,
          body: JSON.stringify(body),
          signal,
        }),
      ),
    catch: (cause) => {
      const message = cause instanceof Error ? cause.message : "Seat container request failed";
      return unavailable("SEAT_UNAVAILABLE", message);
    },
  });

const machineNotFound = () =>
  Effect.gen(function* () {
    yield* requireMachine;
    return yield* Effect.fail(notFound("NOT_FOUND", "Route not found"));
  });

const HostedSeatGroupLive = HttpApiBuilder.group(HostedSeatApi, "seat", (handlers) =>
  handlers
    .handle("health", () =>
      Effect.gen(function* () {
        yield* requireMachine;
        const runtime = yield* HostedSeatRuntime;
        const status = yield* seatOperation("status", () =>
          runtime.resolveSeat(runtime.env).getSeatStatus(),
        );
        return HttpServerResponse.jsonUnsafe(status, {
          status: status.ok ? 200 : 503,
          headers: { "cache-control": "no-store" },
        });
      }),
    )
    .handle("models", () =>
      Effect.gen(function* () {
        yield* requireMachine;
        const runtime = yield* HostedSeatRuntime;
        const { env } = runtime;
        const config = readSeatConfig(env);
        const status = yield* seatOperation("status", () =>
          runtime.resolveSeat(env).getSeatStatus(),
        );
        return {
          object: "list" as const,
          data: Object.entries(status.aliases).map(([alias, model]) => ({
            id: alias,
            object: "model" as const,
            created: 0,
            owned_by: `maskirovka:${config.provider}`,
            resolution: {
              seat_id: config.seatId,
              provider: config.provider,
              model,
            },
          })),
        };
      }),
    )
    .handleRaw("responses", ({ request }) =>
      Effect.gen(function* () {
        yield* requireMachine;
        const runtime = yield* HostedSeatRuntime;
        const config = readSeatConfig(runtime.env);
        if (config.provider !== "codex") {
          return yield* Effect.fail(
            notFound("DIALECT_NOT_SERVED", "This seat does not serve the OpenAI Responses dialect"),
          );
        }
        const input = yield* decodeBody(request, decodeOpenAIResponsesRequest);
        const status = yield* seatOperation("status", () =>
          runtime.resolveSeat(runtime.env).getSeatStatus(),
        );
        if (status.controls.killed) {
          return yield* Effect.fail(
            unavailable("SEAT_KILLED", "Hosted seat traffic is disabled by the operator"),
          );
        }
        const model = yield* resolveModel(config.provider, status.aliases, input.model);
        const headers = internalHeaders(request.headers, input.model, model, "openai-responses");
        const response = yield* invokeSeat(
          runtime.resolveSeat(runtime.env),
          "/v1/responses",
          headers,
          { ...input, model },
        );
        return proxyResponse(
          response,
          config.seatId,
          config.provider,
          model,
          headers.get("x-maskirovka-request-id") ?? crypto.randomUUID(),
        );
      }),
    )
    .handleRaw("messages", ({ request, headers }) =>
      Effect.gen(function* () {
        yield* requireMachine;
        const runtime = yield* HostedSeatRuntime;
        const config = readSeatConfig(runtime.env);
        if (config.provider !== "claude") {
          return yield* Effect.fail(
            notFound(
              "DIALECT_NOT_SERVED",
              "This seat does not serve the Anthropic Messages dialect",
            ),
          );
        }
        if (!headers["anthropic-version"]) {
          return yield* Effect.fail(
            badRequest(
              "INVALID_REQUEST",
              "anthropic-version header is required",
              "anthropic-version",
            ),
          );
        }
        const input = yield* decodeBody(request, decodeAnthropicMessagesRequest);
        const status = yield* seatOperation("status", () =>
          runtime.resolveSeat(runtime.env).getSeatStatus(),
        );
        if (status.controls.killed) {
          return yield* Effect.fail(
            unavailable("SEAT_KILLED", "Hosted seat traffic is disabled by the operator"),
          );
        }
        const model = yield* resolveModel(config.provider, status.aliases, input.model);
        const requestHeaders = internalHeaders(
          request.headers,
          input.model,
          model,
          "anthropic-messages",
        );
        const response = yield* invokeSeat(
          runtime.resolveSeat(runtime.env),
          "/v1/messages",
          requestHeaders,
          { ...input, model },
        );
        return proxyResponse(
          response,
          config.seatId,
          config.provider,
          model,
          requestHeaders.get("x-maskirovka-request-id") ?? crypto.randomUUID(),
        );
      }),
    )
    .handle("legacyChatCompletions", () =>
      Effect.gen(function* () {
        yield* requireMachine;
        return yield* Effect.fail(
          notFound(
            "LEGACY_DIALECT_REMOVED",
            "Chat Completions is not available; use /v1/responses",
          ),
        );
      }),
    )
    .handle("notFoundGet", machineNotFound)
    .handle("notFoundPost", machineNotFound)
    .handle("notFoundPut", machineNotFound)
    .handle("notFoundPatch", machineNotFound)
    .handle("notFoundDelete", machineNotFound)
    .handle("notFoundHead", machineNotFound)
    .handle("notFoundOptions", machineNotFound)
    .handle("notFoundTrace", machineNotFound),
);

const HostedAdminGroupLive = HttpApiBuilder.group(HostedSeatApi, "admin", (handlers) =>
  handlers
    .handle("status", () =>
      Effect.gen(function* () {
        const runtime = yield* HostedSeatRuntime;
        const identity = yield* requireHuman("read");
        const status = yield* seatOperation("operations status", () =>
          runtime.resolveSeat(runtime.env).getOperationsStatus(),
        );
        return adminStatus(status, identity);
      }),
    )
    .handle("requests", ({ query }) =>
      Effect.gen(function* () {
        const runtime = yield* HostedSeatRuntime;
        yield* requireHuman("read");
        const requests = yield* seatOperation("request log", () =>
          runtime.resolveSeat(runtime.env).listRecentRequests(query.limit ?? 100),
        );
        return { requests };
      }),
    )
    .handleRaw("remapAlias", ({ params, request }) =>
      Effect.gen(function* () {
        const runtime = yield* HostedSeatRuntime;
        const identity = yield* requireHuman("admin");
        const payload = yield* decodeBody(
          request,
          Schema.decodeUnknownEffect(HostedAliasRemapRequestSchema),
        );
        const alias = yield* Effect.try({
          try: () => decodeURIComponent(params.alias),
          catch: () => badRequest("INVALID_ALIAS", "Alias path parameter is invalid", "alias"),
        });
        const current = yield* seatOperation("operations status", () =>
          runtime.resolveSeat(runtime.env).getOperationsStatus(),
        );
        if (!Object.hasOwn(current.aliases, alias)) {
          return yield* Effect.fail(
            notFound("MODEL_NOT_FOUND", `Alias ${alias} is not configured on this hosted seat`),
          );
        }
        const status = yield* seatOperation("alias remap", () =>
          runtime.resolveSeat(runtime.env).remapAlias(alias, payload.model),
        );
        return adminStatus(status, identity);
      }),
    )
    .handleRaw("killSwitch", ({ request }) =>
      Effect.gen(function* () {
        const runtime = yield* HostedSeatRuntime;
        const identity = yield* requireHuman("admin");
        const payload = yield* decodeBody(
          request,
          Schema.decodeUnknownEffect(HostedKillSwitchRequestSchema),
        );
        const status = yield* seatOperation("kill switch update", () =>
          runtime.resolveSeat(runtime.env).setKillSwitch(payload.enabled),
        );
        return adminStatus(status, identity);
      }),
    ),
);

const dashboardAsset = (
  runtime: HostedSeatRuntimeShape,
  path: string,
): Effect.Effect<HttpServerResponse.HttpServerResponse, ServiceUnavailableError> =>
  Effect.gen(function* () {
    const assets = runtime.env.ASSETS;
    if (!assets) {
      return yield* Effect.fail(
        unavailable("DASHBOARD_NOT_BUILT", "Hosted dashboard assets are not configured"),
      );
    }
    const read = (assetPath: string) =>
      Effect.tryPromise({
        try: () => assets.fetch(new Request(`https://maskirovka-assets.invalid/${assetPath}`)),
        catch: (cause) =>
          unavailable(
            "DASHBOARD_UNAVAILABLE",
            cause instanceof Error ? cause.message : "Hosted dashboard asset lookup failed",
          ),
      });
    const requested = yield* read(path);
    const fallback = requested.status === 404;
    const asset = fallback ? yield* read("index.html") : requested;
    if (!asset.ok) {
      return yield* Effect.fail(
        unavailable("DASHBOARD_NOT_BUILT", "Hosted dashboard assets have not been built"),
      );
    }
    const headers = new Headers(asset.headers);
    headers.set(
      "cache-control",
      fallback || path === "index.html" ? "no-cache" : "public, max-age=31536000, immutable",
    );
    return HttpServerResponse.fromWeb(
      new Response(asset.body, {
        status: asset.status,
        statusText: asset.statusText,
        headers,
      }),
    );
  });

const HostedDashboardGroupLive = HttpApiBuilder.group(HostedSeatApi, "dashboard", (handlers) =>
  handlers
    .handleRaw("index", () =>
      Effect.gen(function* () {
        const runtime = yield* HostedSeatRuntime;
        yield* requireHuman("read");
        return yield* dashboardAsset(runtime, "index.html");
      }),
    )
    .handleRaw("asset", ({ params }) =>
      Effect.gen(function* () {
        const runtime = yield* HostedSeatRuntime;
        yield* requireHuman("read");
        const path = [params.head, params["*"]].filter(Boolean).join("/");
        return yield* dashboardAsset(runtime, path || "index.html");
      }),
    ),
);

const MachineAuthLive = Layer.succeed(MachineAuth)({
  bearer: (httpEffect, { credential }) =>
    Effect.provideService(httpEffect, HostedMachineCredential, {
      value: Redacted.value(credential),
    }),
});

const HumanAccessLive = Layer.succeed(HumanAccess)((httpEffect) =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const webRequest = yield* HttpServerRequest.toWeb(request).pipe(
      Effect.mapError(() =>
        unavailable("ACCESS_REQUEST_UNAVAILABLE", "Unable to verify the original Access request"),
      ),
    );
    return yield* Effect.provideService(httpEffect, HostedAccessRequest, {
      request: webRequest,
    });
  }),
);

const HostedSeatRoutes = HttpApiBuilder.layer(HostedSeatApi).pipe(
  Layer.provide(HostedSeatGroupLive),
  Layer.provide(HostedAdminGroupLive),
  Layer.provide(HostedDashboardGroupLive),
  Layer.provide(MachineAuthLive),
  Layer.provide(HumanAccessLive),
  Layer.provide(HttpServer.layerServices),
);

const productionWebHandler = HttpRouter.toWebHandler(HostedSeatRoutes, { disableLogger: true });

const runtimeContext = (
  env: SeatEnv,
  dependencies: SeatRouterDependencies = {},
): Context.Context<HostedSeatRuntime> =>
  Context.make(HostedSeatRuntime, {
    env,
    resolveSeat: dependencies.resolveSeat ?? defaultSeatResolver,
  });

export const createSeatTestHandler = () =>
  HttpRouter.toWebHandler(HostedSeatRoutes, { disableLogger: true });

export const handleRequest = (
  request: Request,
  env: SeatEnv,
  dependencies: SeatRouterDependencies = {},
): Promise<Response> => productionWebHandler.handler(request, runtimeContext(env, dependencies));

export const handleTestRequest = (
  handler: ReturnType<typeof createSeatTestHandler>["handler"],
  request: Request,
  env: SeatEnv,
  dependencies: SeatRouterDependencies = {},
): Promise<Response> => handler(request, runtimeContext(env, dependencies));
