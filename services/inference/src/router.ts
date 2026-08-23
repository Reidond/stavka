import {
  authorizeMachine,
  accountScope,
  can,
  verifyAccessRequest,
  type AccountAccessPrincipal,
  type AccountScope,
  type AccountSession,
  type ActiveAccountSession,
  type AccessIdentity,
  type OrganizationUser,
  type SignUpPayload,
} from "@stavka/access-auth";
import { Cause, Context, Effect, Layer, Schema } from "effect";
import {
  HttpRouter,
  HttpServer,
  HttpServerRequest,
  HttpServerResponse,
} from "effect/unstable/http";
import { HttpApiBuilder } from "effect/unstable/httpapi";

import {
  AccountNameSchema,
  AliasPayloadSchema,
  KillSwitchPayloadSchema,
  MaskirovkaGatewayApi,
  ProvisionProviderAccountPayloadSchema,
  ProviderSchema,
  SignUpPayloadSchema,
  TierSchema,
} from "./http-contract";
import {
  gatewaySeats,
  hostedAccessConfig,
  type GatewayEnv,
  type GatewaySeat,
  type GatewayTier,
} from "./config";
import type { GatewayModelsResponse, GatewayStatus } from "./gateway-container";
import type {
  OwnedProviderAccountPublic,
  ProviderId,
  ProvisionProviderAccountPayload,
} from "@stavka/provider-auth";

export interface GatewayStub {
  readonly fetch: (request: Request) => Promise<Response>;
  readonly getGatewayStatus: (scope?: AccountScope) => Promise<GatewayStatus>;
  readonly getAccountSession: (principal: AccountAccessPrincipal) => Promise<AccountSession>;
  readonly signUpAccount: (
    principal: AccountAccessPrincipal,
    payload: SignUpPayload,
  ) => Promise<ActiveAccountSession>;
  readonly listOrganizationUsers: (scope: AccountScope) => Promise<readonly OrganizationUser[]>;
  readonly getModels: () => Promise<GatewayModelsResponse>;
  readonly listRecentRequests: (limit: number) => Promise<readonly unknown[]>;
  readonly remapAlias: (
    tier: GatewayTier,
    seat: (typeof gatewaySeats)[number],
    model: string,
  ) => Promise<GatewayStatus>;
  readonly setKillSwitch: (enabled: boolean) => Promise<GatewayStatus>;
  readonly listProviderAccounts: (
    scope: AccountScope,
  ) => Promise<readonly OwnedProviderAccountPublic[]>;
  readonly putProviderAccount: (
    scope: AccountScope,
    provider: ProviderId,
    name: string,
    payload: ProvisionProviderAccountPayload,
  ) => Promise<OwnedProviderAccountPublic>;
  readonly activateProviderAccount: (
    scope: AccountScope,
    provider: ProviderId,
    name: string,
  ) => Promise<OwnedProviderAccountPublic>;
  readonly deleteProviderAccount: (
    scope: AccountScope,
    provider: ProviderId,
    name: string,
  ) => Promise<void>;
  readonly testProviderAccount: (
    scope: AccountScope,
    provider: ProviderId,
    name: string,
  ) => Promise<OwnedProviderAccountPublic>;
}

export interface GatewayRouterDependencies {
  readonly resolveGateway?: (env: GatewayEnv) => GatewayStub;
}

export interface GatewayRuntimeShape {
  readonly env: GatewayEnv;
  readonly resolveGateway: (env: GatewayEnv) => GatewayStub;
}

export class GatewayRuntime extends Context.Service<GatewayRuntime, GatewayRuntimeShape>()(
  "stavka/maskirovka-gateway/GatewayRuntime",
) {}

class WorkerHttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

const json = (body: unknown, status = 200): HttpServerResponse.HttpServerResponse =>
  HttpServerResponse.jsonUnsafe(body, {
    status,
    headers: { "cache-control": "no-store" },
  });

const errorResponse = (error: WorkerHttpError): HttpServerResponse.HttpServerResponse =>
  json(
    {
      error: {
        code: error.code,
        message: error.message,
        request_id: crypto.randomUUID(),
      },
    },
    error.status,
  );

const safe = <A, R = never>(
  effect: Effect.Effect<A | HttpServerResponse.HttpServerResponse, WorkerHttpError, R>,
): Effect.Effect<A | HttpServerResponse.HttpServerResponse, never, R> =>
  effect.pipe(
    Effect.catch((error) => Effect.succeed(errorResponse(error))),
    Effect.catchCause((cause) =>
      Cause.hasInterruptsOnly(cause)
        ? Effect.failCause(cause)
        : Effect.succeed(
            errorResponse(new WorkerHttpError(500, "INTERNAL_ERROR", "Gateway request failed")),
          ),
    ),
  );

const toWebRequest = (
  request: HttpServerRequest.HttpServerRequest,
): Effect.Effect<Request, WorkerHttpError> =>
  HttpServerRequest.toWeb(request).pipe(
    Effect.mapError(
      () => new WorkerHttpError(400, "REQUEST_UNAVAILABLE", "Unable to read request"),
    ),
  );

const requireMachine = (
  request: Request,
  env: GatewayEnv,
): Effect.Effect<void, WorkerHttpError> => {
  const key = env.MASKIROVKA_GATEWAY_KEY;
  if (!key)
    return Effect.fail(
      new WorkerHttpError(503, "MISCONFIGURED", "Gateway machine auth is not configured"),
    );
  return authorizeMachine(request, key).pipe(
    Effect.mapError(
      () => new WorkerHttpError(503, "AUTH_FAILURE", "Unable to verify gateway credentials"),
    ),
    Effect.flatMap((authorized) =>
      authorized
        ? Effect.void
        : Effect.fail(
            new WorkerHttpError(401, "UNAUTHORIZED", "A valid gateway bearer token is required"),
          ),
    ),
  );
};

const requireAccess = (
  request: Request,
  env: GatewayEnv,
  permission: "read" | "admin",
): Effect.Effect<AccessIdentity, WorkerHttpError> =>
  verifyAccessRequest(request, hostedAccessConfig(env)).pipe(
    Effect.mapError(
      () =>
        new WorkerHttpError(
          401,
          "ACCESS_REQUIRED",
          "A valid Cloudflare Access identity is required",
        ),
    ),
    Effect.flatMap((identity) =>
      can(identity, permission)
        ? Effect.succeed(identity)
        : Effect.fail(
            new WorkerHttpError(
              403,
              "FORBIDDEN",
              permission === "admin"
                ? "Admin permission is required"
                : "Read permission is required",
            ),
          ),
    ),
  );

export const accountPrincipal = (
  identity: AccessIdentity,
): Effect.Effect<AccountAccessPrincipal, WorkerHttpError> =>
  identity.serviceToken
    ? Effect.fail(
        new WorkerHttpError(
          403,
          "HUMAN_ACCOUNT_REQUIRED",
          "A human Cloudflare Access identity is required",
        ),
      )
    : Effect.succeed({
        subject: identity.subject,
        ...(identity.email ? { email: identity.email } : {}),
        accessRole: identity.role === "automation" ? ("spectator" as const) : identity.role,
      });

const activeAccountSession = (
  runtime: GatewayRuntimeShape,
  identity: AccessIdentity,
): Effect.Effect<ActiveAccountSession, WorkerHttpError> =>
  Effect.gen(function* () {
    const principal = yield* accountPrincipal(identity);
    const session = yield* Effect.tryPromise({
      try: () => gatewayFor(runtime).getAccountSession(principal),
      catch: () =>
        new WorkerHttpError(503, "ACCOUNT_UNAVAILABLE", "Stavka account service is unavailable"),
    });
    if (session.status === "active") return session;
    return yield* Effect.fail(
      new WorkerHttpError(409, "SETUP_REQUIRED", "Complete first-time Stavka setup"),
    );
  });

const requireOrganizationAdmin = (
  session: ActiveAccountSession,
): Effect.Effect<void, WorkerHttpError> =>
  session.membership.role === "owner" || session.membership.role === "admin"
    ? Effect.void
    : Effect.fail(
        new WorkerHttpError(
          403,
          "ORGANIZATION_ADMIN_REQUIRED",
          "Organization owner or admin membership is required",
        ),
      );

const decodeJson = <A>(
  request: Request,
  decode: (input: unknown) => Effect.Effect<A, unknown>,
): Effect.Effect<A, WorkerHttpError> =>
  Effect.tryPromise({
    try: () => request.json() as Promise<unknown>,
    catch: () => new WorkerHttpError(400, "INVALID_JSON", "Request body must be valid JSON"),
  }).pipe(
    Effect.flatMap((body) =>
      decode(body).pipe(
        Effect.mapError(
          () => new WorkerHttpError(400, "INVALID_REQUEST", "Request body failed validation"),
        ),
      ),
    ),
  );

const gatewayFor = (runtime: GatewayRuntimeShape): GatewayStub =>
  runtime.resolveGateway(runtime.env);

const decodeProviderAccountParams = (params: {
  readonly provider: string;
  readonly name: string;
}): Effect.Effect<{ readonly provider: ProviderId; readonly name: string }, WorkerHttpError> =>
  Effect.all({
    provider: Schema.decodeUnknownEffect(ProviderSchema)(params.provider).pipe(
      Effect.mapError(
        () => new WorkerHttpError(404, "UNKNOWN_PROVIDER", "Provider must be claude or codex"),
      ),
    ),
    name: Schema.decodeUnknownEffect(AccountNameSchema)(params.name).pipe(
      Effect.mapError(
        () => new WorkerHttpError(400, "INVALID_ACCOUNT_NAME", "Provider account name is invalid"),
      ),
    ),
  });

const validateProvision = (
  provider: ProviderId,
  payload: ProvisionProviderAccountPayload,
): Effect.Effect<ProvisionProviderAccountPayload, WorkerHttpError> => {
  const valid =
    provider === "codex"
      ? payload.authKind === "chatgpt-oauth" && payload.credential.kind === "codex-chatgpt-oauth"
      : (payload.authKind === "claude-subscription" &&
          payload.credential.kind === "claude-subscription") ||
        (payload.authKind === "anthropic-api-key" && payload.credential.kind === "api-key");
  return valid
    ? Effect.succeed(payload)
    : Effect.fail(
        new WorkerHttpError(
          400,
          "CREDENTIAL_KIND_MISMATCH",
          `Credential kind does not match the ${provider} account`,
        ),
      );
};

const proxy = (
  request: HttpServerRequest.HttpServerRequest,
  dialect: "openai-responses" | "anthropic-messages",
): Effect.Effect<HttpServerResponse.HttpServerResponse, WorkerHttpError, GatewayRuntime> =>
  Effect.gen(function* () {
    const runtime = yield* GatewayRuntime;
    const webRequest = yield* toWebRequest(request);
    yield* requireMachine(webRequest, runtime.env);
    const headers = new Headers(webRequest.headers);
    headers.delete("authorization");
    headers.delete("cf-access-jwt-assertion");
    headers.set("x-maskirovka-dialect", dialect);
    headers.set("x-maskirovka-provider", dialect === "anthropic-messages" ? "claude" : "codex");
    headers.set("x-maskirovka-request-id", crypto.randomUUID());
    const upstream = yield* Effect.tryPromise({
      try: () => gatewayFor(runtime).fetch(new Request(webRequest, { headers })),
      catch: () =>
        new WorkerHttpError(503, "GATEWAY_UNAVAILABLE", "Gateway container is unavailable"),
    });
    return HttpServerResponse.fromWeb(upstream);
  });

const GatewayHandlers = HttpApiBuilder.group(MaskirovkaGatewayApi, "gateway", (handlers) =>
  handlers
    .handleRaw("health", ({ request }) =>
      safe(
        Effect.gen(function* () {
          const runtime = yield* GatewayRuntime;
          const webRequest = yield* toWebRequest(request);
          yield* requireMachine(webRequest, runtime.env);
          const status = yield* Effect.tryPromise({
            try: () => gatewayFor(runtime).getGatewayStatus(),
            catch: () =>
              new WorkerHttpError(503, "GATEWAY_UNAVAILABLE", "Gateway status is unavailable"),
          });
          // Health validates every active alias against its seat's provider
          // credential — never merely "some credential exists".
          const configuredProviders = new Set(
            Object.values(status.auth)
              .filter((meta) => meta.configured)
              .map((meta) => meta.provider),
          );
          const seatNeedsProvider = (seat: GatewaySeat): seat is "claude" | "codex" =>
            seat === "claude" || seat === "codex";
          const aliasesReady =
            status.aliases.length > 0 &&
            status.aliases.every((alias) => {
              if (alias.model.trim().length === 0) return false;
              return !seatNeedsProvider(alias.seat) || configuredProviders.has(alias.seat);
            });
          const health =
            !status.ok || status.killed
              ? ("not_ready" as const)
              : aliasesReady
                ? ("live" as const)
                : ("degraded" as const);
          return json(
            { ...status, health, aliases_ready: aliasesReady },
            health === "not_ready" ? 503 : 200,
          );
        }),
      ),
    )
    .handleRaw("models", ({ request }) =>
      safe(
        Effect.gen(function* () {
          const runtime = yield* GatewayRuntime;
          const webRequest = yield* toWebRequest(request);
          yield* requireMachine(webRequest, runtime.env);
          const models = yield* Effect.tryPromise({
            try: () => gatewayFor(runtime).getModels(),
            catch: () =>
              new WorkerHttpError(503, "GATEWAY_UNAVAILABLE", "Gateway models are unavailable"),
          });
          return json(models);
        }),
      ),
    )
    .handleRaw("responses", ({ request }) => safe(proxy(request, "openai-responses")))
    .handleRaw("messages", ({ request }) => safe(proxy(request, "anthropic-messages")))
    .handleRaw("accountSession", ({ request }) =>
      safe(
        Effect.gen(function* () {
          const runtime = yield* GatewayRuntime;
          const webRequest = yield* toWebRequest(request);
          const identity = yield* requireAccess(webRequest, runtime.env, "read");
          const principal = yield* accountPrincipal(identity);
          const session = yield* Effect.tryPromise({
            try: () => gatewayFor(runtime).getAccountSession(principal),
            catch: () =>
              new WorkerHttpError(
                503,
                "ACCOUNT_UNAVAILABLE",
                "Stavka account service is unavailable",
              ),
          });
          return json(session);
        }),
      ),
    )
    .handleRaw("signUpAccount", ({ request }) =>
      safe(
        Effect.gen(function* () {
          const runtime = yield* GatewayRuntime;
          const webRequest = yield* toWebRequest(request);
          const identity = yield* requireAccess(webRequest, runtime.env, "admin");
          const principal = yield* accountPrincipal(identity);
          const payload = yield* decodeJson(
            webRequest,
            Schema.decodeUnknownEffect(SignUpPayloadSchema),
          );
          const session = yield* Effect.tryPromise({
            try: () => gatewayFor(runtime).signUpAccount(principal, payload),
            catch: (cause) =>
              new WorkerHttpError(
                409,
                "REGISTRATION_CLOSED",
                cause instanceof Error ? cause.message : "Stavka registration is unavailable",
              ),
          });
          return json(session);
        }),
      ),
    )
    .handleRaw("organizationUsers", ({ request }) =>
      safe(
        Effect.gen(function* () {
          const runtime = yield* GatewayRuntime;
          const webRequest = yield* toWebRequest(request);
          const identity = yield* requireAccess(webRequest, runtime.env, "read");
          const session = yield* activeAccountSession(runtime, identity);
          const users = yield* Effect.tryPromise({
            try: () => gatewayFor(runtime).listOrganizationUsers(accountScope(session)),
            catch: () =>
              new WorkerHttpError(503, "ACCOUNT_UNAVAILABLE", "Organization users are unavailable"),
          });
          return json({ users });
        }),
      ),
    )
    .handleRaw("adminStatus", ({ request }) =>
      safe(
        Effect.gen(function* () {
          const runtime = yield* GatewayRuntime;
          const webRequest = yield* toWebRequest(request);
          const identity = yield* requireAccess(webRequest, runtime.env, "read");
          const session = yield* activeAccountSession(runtime, identity);
          const status = yield* Effect.tryPromise({
            try: () => gatewayFor(runtime).getGatewayStatus(accountScope(session)),
            catch: () =>
              new WorkerHttpError(503, "GATEWAY_UNAVAILABLE", "Gateway status is unavailable"),
          });
          return json({
            ...status,
            access: {
              role: identity.role,
              can_admin:
                can(identity, "admin") &&
                (session.membership.role === "owner" || session.membership.role === "admin"),
              service_token: identity.serviceToken,
            },
          });
        }),
      ),
    )
    .handleRaw("adminRequests", ({ request, query }) =>
      safe(
        Effect.gen(function* () {
          const runtime = yield* GatewayRuntime;
          const webRequest = yield* toWebRequest(request);
          const identity = yield* requireAccess(webRequest, runtime.env, "read");
          yield* activeAccountSession(runtime, identity);
          const limit = Math.max(1, Math.min(500, Number(query.limit ?? "100") || 100));
          const requests = yield* Effect.tryPromise({
            try: () => gatewayFor(runtime).listRecentRequests(limit),
            catch: () =>
              new WorkerHttpError(
                503,
                "GATEWAY_UNAVAILABLE",
                "Gateway request feed is unavailable",
              ),
          });
          return json({ requests });
        }),
      ),
    )
    .handleRaw("adminAliases", ({ request }) =>
      safe(
        Effect.gen(function* () {
          const runtime = yield* GatewayRuntime;
          const webRequest = yield* toWebRequest(request);
          const identity = yield* requireAccess(webRequest, runtime.env, "read");
          yield* activeAccountSession(runtime, identity);
          const status = yield* Effect.tryPromise({
            try: () => gatewayFor(runtime).getGatewayStatus(),
            catch: () =>
              new WorkerHttpError(503, "GATEWAY_UNAVAILABLE", "Gateway aliases are unavailable"),
          });
          return json({ aliases: status.aliases });
        }),
      ),
    )
    .handleRaw("remapAlias", ({ request, params }) =>
      safe(
        Effect.gen(function* () {
          const runtime = yield* GatewayRuntime;
          const webRequest = yield* toWebRequest(request);
          const identity = yield* requireAccess(webRequest, runtime.env, "admin");
          const session = yield* activeAccountSession(runtime, identity);
          yield* requireOrganizationAdmin(session);
          const tier = yield* Schema.decodeUnknownEffect(TierSchema)(params.tier).pipe(
            Effect.mapError(() => new WorkerHttpError(404, "UNKNOWN_TIER", "Unknown tier alias")),
          );
          const payload = yield* decodeJson(
            webRequest,
            Schema.decodeUnknownEffect(AliasPayloadSchema),
          );
          const status = yield* Effect.tryPromise({
            try: () => gatewayFor(runtime).remapAlias(tier, payload.seat, payload.model),
            catch: () =>
              new WorkerHttpError(
                503,
                "GATEWAY_UNAVAILABLE",
                "Gateway configuration is unavailable",
              ),
          });
          return json({ aliases: status.aliases });
        }),
      ),
    )
    .handleRaw("killSwitch", ({ request }) =>
      safe(
        Effect.gen(function* () {
          const runtime = yield* GatewayRuntime;
          const webRequest = yield* toWebRequest(request);
          const identity = yield* requireAccess(webRequest, runtime.env, "admin");
          const session = yield* activeAccountSession(runtime, identity);
          yield* requireOrganizationAdmin(session);
          const payload = yield* decodeJson(
            webRequest,
            Schema.decodeUnknownEffect(KillSwitchPayloadSchema),
          );
          const status = yield* Effect.tryPromise({
            try: () => gatewayFor(runtime).setKillSwitch(payload.enabled),
            catch: () =>
              new WorkerHttpError(503, "GATEWAY_UNAVAILABLE", "Gateway controls are unavailable"),
          });
          return json({ killed: status.killed });
        }),
      ),
    )
    .handleRaw("providerAccounts", ({ request }) =>
      safe(
        Effect.gen(function* () {
          const runtime = yield* GatewayRuntime;
          const webRequest = yield* toWebRequest(request);
          const identity = yield* requireAccess(webRequest, runtime.env, "read");
          const session = yield* activeAccountSession(runtime, identity);
          const accounts = yield* Effect.tryPromise({
            try: () => gatewayFor(runtime).listProviderAccounts(accountScope(session)),
            catch: () =>
              new WorkerHttpError(503, "GATEWAY_UNAVAILABLE", "Provider accounts are unavailable"),
          });
          return json({ account: session, accounts });
        }),
      ),
    )
    .handleRaw("putProviderAccount", ({ request, params }) =>
      safe(
        Effect.gen(function* () {
          const runtime = yield* GatewayRuntime;
          const webRequest = yield* toWebRequest(request);
          const identity = yield* requireAccess(webRequest, runtime.env, "admin");
          const session = yield* activeAccountSession(runtime, identity);
          yield* requireOrganizationAdmin(session);
          const { provider, name } = yield* decodeProviderAccountParams(params);
          const decoded = yield* decodeJson(
            webRequest,
            Schema.decodeUnknownEffect(ProvisionProviderAccountPayloadSchema),
          );
          const payload = yield* validateProvision(provider, decoded);
          const result = yield* Effect.tryPromise({
            try: () =>
              gatewayFor(runtime).putProviderAccount(
                accountScope(session),
                provider,
                name,
                payload,
              ),
            catch: (cause) =>
              new WorkerHttpError(
                503,
                "GATEWAY_UNAVAILABLE",
                cause instanceof Error ? cause.message : "Provider account is unavailable",
              ),
          });
          return json(result);
        }),
      ),
    )
    .handleRaw("activateProviderAccount", ({ request, params }) =>
      safe(
        Effect.gen(function* () {
          const runtime = yield* GatewayRuntime;
          const webRequest = yield* toWebRequest(request);
          const identity = yield* requireAccess(webRequest, runtime.env, "admin");
          const session = yield* activeAccountSession(runtime, identity);
          yield* requireOrganizationAdmin(session);
          const { provider, name } = yield* decodeProviderAccountParams(params);
          const result = yield* Effect.tryPromise({
            try: () =>
              gatewayFor(runtime).activateProviderAccount(accountScope(session), provider, name),
            catch: (cause) =>
              new WorkerHttpError(
                503,
                "GATEWAY_UNAVAILABLE",
                cause instanceof Error ? cause.message : "Provider account is unavailable",
              ),
          });
          return json(result);
        }),
      ),
    )
    .handleRaw("testProviderAccount", ({ request, params }) =>
      safe(
        Effect.gen(function* () {
          const runtime = yield* GatewayRuntime;
          const webRequest = yield* toWebRequest(request);
          const identity = yield* requireAccess(webRequest, runtime.env, "admin");
          const session = yield* activeAccountSession(runtime, identity);
          yield* requireOrganizationAdmin(session);
          const { provider, name } = yield* decodeProviderAccountParams(params);
          const result = yield* Effect.tryPromise({
            try: () =>
              gatewayFor(runtime).testProviderAccount(accountScope(session), provider, name),
            catch: (cause) =>
              new WorkerHttpError(
                503,
                "PROVIDER_ACCOUNT_TEST_FAILED",
                cause instanceof Error ? cause.message : "Provider account test failed",
              ),
          });
          return json({ ...result, test: "credential-decrypted" });
        }),
      ),
    )
    .handleRaw("deleteProviderAccount", ({ request, params }) =>
      safe(
        Effect.gen(function* () {
          const runtime = yield* GatewayRuntime;
          const webRequest = yield* toWebRequest(request);
          const identity = yield* requireAccess(webRequest, runtime.env, "admin");
          const session = yield* activeAccountSession(runtime, identity);
          yield* requireOrganizationAdmin(session);
          const { provider, name } = yield* decodeProviderAccountParams(params);
          yield* Effect.tryPromise({
            try: () =>
              gatewayFor(runtime).deleteProviderAccount(accountScope(session), provider, name),
            catch: () =>
              new WorkerHttpError(503, "GATEWAY_UNAVAILABLE", "Provider account is unavailable"),
          });
          return json({ provider, name, deleted: true });
        }),
      ),
    )
    .handleRaw("dashboardIndex", ({ request }) => dashboardAsset(request, "index.html"))
    .handleRaw("dashboardAsset", ({ request, params }) =>
      dashboardAsset(request, [params.head, params["*"]].filter(Boolean).join("/") || "index.html"),
    ),
);

/**
 * SPA fallback discipline: a miss may fall back to index.html only for HTML
 * navigations. Missing scripts, styles, images, and source maps must remain
 * HTTP 404 instead of receiving HTML.
 */
export const isHtmlNavigation = (webRequest: Request, path: string): boolean => {
  const mode = webRequest.headers.get("sec-fetch-mode");
  if (mode !== null && mode !== undefined) return mode === "navigate";
  const acceptsHtml = (webRequest.headers.get("accept") ?? "").includes("text/html");
  return acceptsHtml && !/\.[a-z0-9]+$/i.test(path);
};

const dashboardAsset = (
  request: HttpServerRequest.HttpServerRequest,
  path: string,
): Effect.Effect<HttpServerResponse.HttpServerResponse, never, GatewayRuntime> =>
  safe(
    Effect.gen(function* () {
      const runtime = yield* GatewayRuntime;
      const webRequest = yield* toWebRequest(request);
      yield* requireAccess(webRequest, runtime.env, "read");
      const assets = runtime.env.ASSETS;
      if (!assets)
        throw new WorkerHttpError(
          503,
          "DASHBOARD_NOT_BUILT",
          "Gateway dashboard assets are not configured",
        );
      const requested = yield* Effect.tryPromise({
        try: () => assets.fetch(new Request(`https://maskirovka-assets.invalid/${path}`)),
        catch: () =>
          new WorkerHttpError(
            503,
            "DASHBOARD_UNAVAILABLE",
            "Gateway dashboard assets are unavailable",
          ),
      });
      const navigationMiss = requested.status === 404 && isHtmlNavigation(webRequest, path);
      if (requested.status === 404 && !navigationMiss) {
        throw new WorkerHttpError(
          404,
          "DASHBOARD_ASSET_NOT_FOUND",
          "Dashboard asset does not exist",
        );
      }
      const asset = navigationMiss
        ? yield* Effect.tryPromise({
            try: () => assets.fetch(new Request("https://maskirovka-assets.invalid/index.html")),
            catch: () =>
              new WorkerHttpError(
                503,
                "DASHBOARD_UNAVAILABLE",
                "Gateway dashboard assets are unavailable",
              ),
          })
        : requested;
      if (!asset.ok)
        throw new WorkerHttpError(
          503,
          "DASHBOARD_NOT_BUILT",
          "Gateway dashboard assets have not been built",
        );
      const headers = new Headers(asset.headers);
      headers.set(
        "cache-control",
        path === "index.html" || navigationMiss
          ? "no-cache"
          : "public, max-age=31536000, immutable",
      );
      return HttpServerResponse.fromWeb(
        new Response(asset.body, { status: asset.status, statusText: asset.statusText, headers }),
      );
    }),
  );

const Routes = HttpApiBuilder.layer(MaskirovkaGatewayApi, { openapiPath: "/openapi.json" }).pipe(
  Layer.provide(GatewayHandlers),
  Layer.provide(HttpServer.layerServices),
);

const productionWebHandler = HttpRouter.toWebHandler(Routes, { disableLogger: true });

const defaultGatewayResolver = (env: GatewayEnv): GatewayStub =>
  env.MASKIROVKA_GATEWAY.getByName(env.GATEWAY_ID || "default-gateway");

const runtimeContext = (
  env: GatewayEnv,
  dependencies: GatewayRouterDependencies,
): Context.Context<GatewayRuntime> =>
  Context.make(GatewayRuntime, {
    env,
    resolveGateway: dependencies.resolveGateway ?? defaultGatewayResolver,
  });

export const createGatewayTestHandler = () =>
  HttpRouter.toWebHandler(Routes, { disableLogger: true });

export const handleRequest = (
  request: Request,
  env: GatewayEnv,
  dependencies: GatewayRouterDependencies = {},
): Promise<Response> => productionWebHandler.handler(request, runtimeContext(env, dependencies));

export const handleTestRequest = (
  handler: ReturnType<typeof createGatewayTestHandler>["handler"],
  request: Request,
  env: GatewayEnv,
  dependencies: GatewayRouterDependencies = {},
): Promise<Response> => handler(request, runtimeContext(env, dependencies));
