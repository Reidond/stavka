import {
  authorizeMachine,
  can,
  verifyAccessRequest,
  type AccessIdentity,
  type AccessPermission,
} from "@stavka/access-auth";
import type {
  ConnectResponse,
  ErrorEnvelope,
  MapBriefing as MapBriefingType,
  SessionExport,
} from "@stavka/protocol";
import { MapBriefing, TickResponse } from "@stavka/protocol";
import { routeAgentRequest } from "agents";
import { Context, Effect, Layer, Schema } from "effect";
import {
  HttpRouter,
  HttpServer,
  HttpServerRequest,
  HttpServerResponse,
} from "effect/unstable/http";
import { HttpApiBuilder } from "effect/unstable/httpapi";

import {
  accessConfig,
  CommanderEnvironment,
  readConfigEffect,
  type Env,
} from "../config";
import type { OrchestratorAgent } from "../durable/orchestrator";
import { authorizeSeatRequest } from "../brain/seat-auth";
import { SEAT_REGISTRY_NAME } from "../brain/seat-router";
import type { DecisionLogEntry } from "../logging/types";
import {
  R2SessionExportRepository,
  SessionExportNotFoundError,
  type SessionExportMetadata,
} from "../logging/r2-session-export-repository";
import type { CommanderSessionState, SeatRegistration } from "../state/types";
import {
  CommanderApi,
  MachineAuth,
} from "./contract";

const MAX_BODY_BYTES = 1_000_000;

const SessionIndex = Schema.Struct({
  missionId: Schema.String,
  faction: Schema.String,
  epoch: Schema.Number,
  mapName: Schema.String,
});

const MapCachePointer = Schema.Struct({
  key: Schema.String,
  source: Schema.optional(Schema.String),
  classificationVersion: Schema.optional(Schema.Number),
  contentHash: Schema.optional(Schema.String),
});

const stableHash = (value: string): string => {
  let hash = 2_166_136_261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }
  return (hash >>> 0).toString(36);
};

/**
 * Map names are not content identities. Bind every cached briefing to its
 * source, classifier revision, and content hash. Legacy payloads receive a
 * deterministic full-payload fingerprint so equal dimensions never collide.
 */
const terrainCacheKey = (briefing: MapBriefingType): string => {
  const source = briefing.source ?? "legacy";
  const classificationVersion = briefing.classification_version ?? 0;
  const contentHash = briefing.content_hash ?? `legacy-${stableHash(JSON.stringify(briefing))}`;
  return [
    "map",
    encodeURIComponent(briefing.map_name),
    encodeURIComponent(source),
    `v${classificationVersion}`,
    encodeURIComponent(contentHash),
  ].join(":");
};

const readKvJson = <S extends Schema.Top>(
  kv: KVNamespace,
  key: string,
  schema: S,
): Effect.Effect<S["Type"] | undefined, never, S["DecodingServices"]> =>
  Effect.tryPromise({
    try: () => kv.get(key),
    catch: (cause) => cause,
  }).pipe(
    Effect.flatMap((encoded) => encoded === null
      ? Effect.succeed(undefined)
      : Schema.decodeUnknownEffect(Schema.fromJsonString(schema))(encoded)),
    Effect.catch(() => Effect.succeed(undefined)),
  );

const readCachedMapBriefing = (
  kv: KVNamespace,
  mapName: string,
): Effect.Effect<MapBriefingType | undefined> => Effect.gen(function*() {
  const latestKey = `map:${encodeURIComponent(mapName)}:latest`;
  // Older cache entries stored the briefing directly. Keep that migration
  // path read-only while new entries store a provenance-bearing pointer.
  const legacy = yield* readKvJson(kv, latestKey, MapBriefing);
  if (legacy !== undefined) return legacy;
  const pointer = yield* readKvJson(kv, latestKey, MapCachePointer);
  if (pointer === undefined) return undefined;
  const briefing = yield* readKvJson(kv, pointer.key, MapBriefing);
  if (briefing === undefined) return undefined;
  // Treat the pointer as a content-addressed reference, not merely a map-name
  // alias. This prevents a malformed/stale pointer from silently mixing a
  // different source or classifier revision into an otherwise valid mission.
  const provenanceMatches =
    (pointer.source === undefined || pointer.source === briefing.source) &&
    (pointer.classificationVersion === undefined ||
      pointer.classificationVersion === briefing.classification_version) &&
    (pointer.contentHash === undefined || pointer.contentHash === briefing.content_hash);
  return provenanceMatches && terrainCacheKey(briefing) === pointer.key
    ? briefing
    : undefined;
});

const errorEnvelope = (
  code: string,
  message: string,
  issues: readonly string[] = [],
): ErrorEnvelope => ({
  error: { code, message, request_id: crypto.randomUUID(), issues: [...issues] },
});

const errorResponse = (
  status: number,
  code: string,
  message: string,
  issues: readonly string[] = [],
): HttpServerResponse.HttpServerResponse =>
  HttpServerResponse.jsonUnsafe(errorEnvelope(code, message, issues), { status });

const internalFailure = (cause: unknown): HttpServerResponse.HttpServerResponse => {
  console.error("Unhandled commander request error", cause);
  return errorResponse(500, "INTERNAL_ERROR", "Internal request failure");
};

const webRequest = (
  request: HttpServerRequest.HttpServerRequest,
) => HttpServerRequest.toWeb(request);

const withMachineAuth = <A, E, R>(
  request: HttpServerRequest.HttpServerRequest,
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A | HttpServerResponse.HttpServerResponse, E, R | CommanderEnvironment> =>
  Effect.gen(function*() {
    const env = yield* CommanderEnvironment;
    if (!env.API_KEY) {
      return errorResponse(503, "MISCONFIGURED", "API_KEY is not configured");
    }
    const raw = yield* webRequest(request).pipe(
      Effect.catch(() => Effect.succeed(undefined)),
    );
    if (raw === undefined) return errorResponse(400, "INVALID_REQUEST", "Invalid HTTP request");
    const authorized = yield* authorizeMachine(raw, env.API_KEY).pipe(
      Effect.catch(() => Effect.succeed(false)),
    );
    return authorized ? yield* effect : errorResponse(401, "UNAUTHORIZED", "Invalid machine bearer token");
  });

const withAccess = <A, E, R>(
  request: HttpServerRequest.HttpServerRequest,
  permission: AccessPermission,
  effect: (identity: AccessIdentity) => Effect.Effect<A, E, R>,
): Effect.Effect<A | HttpServerResponse.HttpServerResponse, E, R | CommanderEnvironment> =>
  Effect.gen(function*() {
    const env = yield* CommanderEnvironment;
    const raw = yield* webRequest(request).pipe(
      Effect.catch(() => Effect.succeed(undefined)),
    );
    if (raw === undefined) return errorResponse(400, "INVALID_REQUEST", "Invalid HTTP request");
    const verified = yield* Effect.result(verifyAccessRequest(raw, accessConfig(env)));
    if (verified._tag === "Failure") {
      return errorResponse(
        401,
        "ACCESS_REQUIRED",
        "A valid Cloudflare Access identity is required",
      );
    }
    if (!can(verified.success, permission)) {
      return errorResponse(403, "FORBIDDEN", `${permission} permission required`);
    }
    return yield* effect(verified.success);
  });

const sessionName = (sessionId: string, epoch: number, faction: string): string =>
  JSON.stringify([sessionId, epoch, faction]);

const sessionIndexKey = (sessionId: string, epoch: number, faction: string): string =>
  `session:${sessionName(sessionId, epoch, faction)}`;

const sessionStub = (
  env: Env,
  query: {
    readonly session_id: string;
    readonly faction: string;
    readonly epoch?: number | undefined;
  },
): DurableObjectStub<OrchestratorAgent> =>
  env.ORCHESTRATOR.getByName(sessionName(query.session_id, query.epoch ?? 1, query.faction));

const rpc = <A>(
  operation: string,
  run: () => PromiseLike<A>,
): Effect.Effect<A | HttpServerResponse.HttpServerResponse> =>
  Effect.tryPromise({
    try: async () => await run(),
    catch: (cause) => ({ operation, cause }),
  }).pipe(Effect.catch((failure) => Effect.succeed(internalFailure(failure))));

const PublicLive = HttpApiBuilder.group(CommanderApi, "public", (handlers) =>
  handlers.handle("health", () =>
    Effect.gen(function*() {
      const env = yield* CommanderEnvironment;
      const config = yield* readConfigEffect(env).pipe(
        Effect.catch((error) => Effect.die(error)),
      );
      return {
        ok: true as const,
        service: "stavka-commander" as const,
        protocol_version: 1 as const,
        ai: {
          provider: config.aiProvider,
          commander: config.commanderModel,
          sergeant: config.sergeantModel,
        },
      };
    }),
  ));

const MachineLive = HttpApiBuilder.group(CommanderApi, "machine", (handlers) =>
  handlers
    .handle("connect", ({ payload, request }) =>
      withMachineAuth(request, Effect.gen(function*() {
        const env = yield* CommanderEnvironment;
        const stub = env.ORCHESTRATOR.getByName(
          sessionName(payload.session_id, payload.mission_epoch, payload.faction),
        );
        const connected = yield* rpc<ConnectResponse>("connect", () => stub.connectSession(payload));
        if (HttpServerResponse.isHttpServerResponse(connected)) return connected;
        yield* Effect.tryPromise({
          try: () => env.TERRAIN_CACHE.put(
            sessionIndexKey(payload.session_id, payload.mission_epoch, payload.faction),
            JSON.stringify({
              missionId: payload.mission_id,
              faction: payload.faction,
              epoch: payload.mission_epoch,
              mapName: payload.map_name,
            }),
          ),
          catch: (cause) => cause,
        }).pipe(Effect.catch(() => Effect.void));
        const briefing = yield* readCachedMapBriefing(env.TERRAIN_CACHE, payload.map_name);
        // The cache key is map-scoped, but retain the wire mission binding at
        // the final application boundary as well. A corrupt or stale pointer
        // must never attach another map's terrain to a newly connected game.
        if (
          briefing !== undefined &&
          briefing.map_name === payload.map_name &&
          briefing.source !== "simulator_synthetic"
        ) {
          yield* rpc<void>("apply map briefing", () => stub.setMapBriefing(briefing));
        }
        return connected;
      })),
    )
    .handle("tick", ({ headers, payload, request }) =>
      withMachineAuth(request, Effect.gen(function*() {
        const env = yield* CommanderEnvironment;
        const epoch = payload.type === "full"
          ? payload.snapshot.mission.epoch
          : headers["x-stavka-mission-epoch"] ?? 1;
        const stub = env.ORCHESTRATOR.getByName(
          sessionName(payload.session_id, epoch, payload.faction),
        );
        const response = yield* rpc<unknown>("tick", () => stub.handleTick(payload));
        const decoded = yield* Effect.result(Schema.decodeUnknownEffect(TickResponse)(response));
        return decoded._tag === "Success"
          ? decoded.success
          : internalFailure(decoded.failure);
      })),
    )
    .handle("disconnect", ({ headers, payload, request }) =>
      withMachineAuth(request, Effect.gen(function*() {
        const env = yield* CommanderEnvironment;
        const epoch = headers["x-stavka-mission-epoch"] ?? 1;
        const stub = env.ORCHESTRATOR.getByName(
          sessionName(payload.session_id, epoch, payload.faction),
        );
        const result = yield* rpc<void>("disconnect", () => stub.disconnectSession(payload.reason));
        return HttpServerResponse.isHttpServerResponse(result) ? result : undefined;
      })),
    )
    .handle("map", ({ payload, request }) =>
      withMachineAuth(request, Effect.gen(function*() {
        const env = yield* CommanderEnvironment;
        const session = yield* readKvJson(
          env.TERRAIN_CACHE,
          sessionIndexKey(payload.session_id, payload.mission_epoch, payload.faction),
          SessionIndex,
        );
        if (session === undefined) {
          return errorResponse(
            409,
            "MAP_SESSION_NOT_CONNECTED",
            "Map upload requires an active connected mission",
          );
        }
        if (
          session.missionId !== payload.mission_id ||
          session.epoch !== payload.mission_epoch ||
          session.faction !== payload.faction ||
          session.mapName !== payload.briefing.map_name
        ) {
          return errorResponse(
            409,
            "MAP_SESSION_MISMATCH",
            "Map upload mission identity does not match the active connection",
          );
        }
        const terrainKey = terrainCacheKey(payload.briefing);
        const latestKey = `map:${encodeURIComponent(payload.briefing.map_name)}:latest`;
        const pointer = {
          key: terrainKey,
          ...(payload.briefing.source === undefined ? {} : { source: payload.briefing.source }),
          ...(payload.briefing.classification_version === undefined
            ? {}
            : { classificationVersion: payload.briefing.classification_version }),
          ...(payload.briefing.content_hash === undefined
            ? {}
            : { contentHash: payload.briefing.content_hash }),
        };
        const stored = yield* Effect.tryPromise({
          try: () => Promise.all([
            env.TERRAIN_CACHE.put(terrainKey, JSON.stringify(payload.briefing)),
            ...(payload.briefing.source === "simulator_synthetic"
              ? []
              : [env.TERRAIN_CACHE.put(
                  latestKey,
                  JSON.stringify(pointer),
                )]),
          ]),
          catch: (cause) => cause,
        }).pipe(Effect.result);
        if (stored._tag === "Failure") return internalFailure(stored.failure);
        const stub = env.ORCHESTRATOR.getByName(
          sessionName(payload.session_id, session.epoch, session.faction),
        );
        const applied = yield* rpc<void>(
          "apply map briefing",
          () => stub.setMapBriefing(payload.briefing),
        );
        if (HttpServerResponse.isHttpServerResponse(applied)) return applied;
        return { accepted: true as const, key: terrainKey };
      })),
    ),
);

const AdminLive = HttpApiBuilder.group(CommanderApi, "admin", (handlers) =>
  handlers
    .handle("session", ({ query, request }) =>
      withAccess(request, "read", () =>
        Effect.gen(function*() {
          const env = yield* CommanderEnvironment;
          return yield* rpc<CommanderSessionState>(
            "get session",
            () => sessionStub(env, query).getSessionState(),
          );
        })),
    )
    .handle("logs", ({ query, request }) =>
      withAccess(request, "read", () =>
        Effect.gen(function*() {
          const env = yield* CommanderEnvironment;
          return yield* rpc<DecisionLogEntry[]>(
            "list logs",
            () => sessionStub(env, query).listDecisionLogs(query.limit ?? 100),
          );
        })),
    )
    .handle("seats", ({ request }) =>
      withAccess(request, "read", () =>
        Effect.gen(function*() {
          const env = yield* CommanderEnvironment;
          return yield* rpc<SeatRegistration[]>(
            "get seats",
            () => env.ORCHESTRATOR.getByName(SEAT_REGISTRY_NAME).refreshSeats(),
          );
        })),
    )
    .handle("registerSeat", ({ payload, request }) =>
      withAccess(request, "admin", () =>
        Effect.gen(function*() {
          const env = yield* CommanderEnvironment;
          return yield* rpc<SeatRegistration[]>(
            "register seat",
            () => env.ORCHESTRATOR.getByName(SEAT_REGISTRY_NAME).registerSeat(payload),
          );
        })),
    )
    .handle("removeSeat", ({ params, request }) =>
      withAccess(request, "admin", () =>
        Effect.gen(function*() {
          const env = yield* CommanderEnvironment;
          return yield* rpc<SeatRegistration[]>(
            "remove seat",
            () => env.ORCHESTRATOR.getByName(SEAT_REGISTRY_NAME).removeSeat(params.seatId),
          );
        })),
    )
    .handle("exportSession", ({ query, request }) =>
      withAccess(request, "admin", () =>
        Effect.gen(function*() {
          const env = yield* CommanderEnvironment;
          return yield* rpc<SessionExport>(
            "export session",
            () => sessionStub(env, query).exportSession(),
          );
        })),
    )
    .handle("persistSessionExport", ({ query, request }) =>
      withAccess(request, "admin", () =>
        Effect.gen(function*() {
          const env = yield* CommanderEnvironment;
          if (env.SESSION_EXPORTS === undefined) {
            return errorResponse(
              503,
              "MISCONFIGURED",
              "SESSION_EXPORTS R2 binding is not configured",
            );
          }
          return yield* rpc<SessionExportMetadata>(
            "persist session export",
            () => sessionStub(env, query).persistSessionExport(query.export_id),
          );
        })),
    )
    .handle("listSessionExports", ({ query, request }) =>
      withAccess(request, "read", () =>
        Effect.gen(function*() {
          const env = yield* CommanderEnvironment;
          if (env.SESSION_EXPORTS === undefined) {
            return errorResponse(
              503,
              "MISCONFIGURED",
              "SESSION_EXPORTS R2 binding is not configured",
            );
          }
          const repository = new R2SessionExportRepository(env.SESSION_EXPORTS);
          const listed = yield* Effect.result(repository.list({
            sessionId: query.session_id,
            faction: query.faction,
            ...(query.epoch === undefined ? {} : { missionEpoch: query.epoch }),
            ...(query.limit === undefined ? {} : { limit: query.limit }),
            ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
          }));
          return listed._tag === "Success"
            ? listed.success
            : internalFailure(listed.failure);
        })),
    )
    .handle("readSessionExport", ({ query, request }) =>
      withAccess(request, "read", () =>
        Effect.gen(function*() {
          const env = yield* CommanderEnvironment;
          if (env.SESSION_EXPORTS === undefined) {
            return errorResponse(
              503,
              "MISCONFIGURED",
              "SESSION_EXPORTS R2 binding is not configured",
            );
          }
          const repository = new R2SessionExportRepository(env.SESSION_EXPORTS);
          const stored = yield* Effect.result(repository.readPage(query.key, query.cursor));
          if (stored._tag === "Success") return stored.success;
          return stored.failure instanceof SessionExportNotFoundError
            ? errorResponse(404, "NOT_FOUND", "Session export was not found")
            : internalFailure(stored.failure);
        })),
    ),
);

const MachineAuthLive = Layer.succeed(MachineAuth)((httpEffect) =>
  Effect.gen(function*() {
    const env = yield* CommanderEnvironment;
    if (!env.API_KEY) {
      return errorResponse(503, "MISCONFIGURED", "API_KEY is not configured");
    }
    const request = yield* HttpServerRequest.HttpServerRequest;
    const raw = yield* webRequest(request).pipe(
      Effect.catch(() => Effect.succeed(undefined)),
    );
    if (raw === undefined) {
      return errorResponse(400, "INVALID_REQUEST", "Invalid HTTP request");
    }
    const authorized = yield* authorizeMachine(raw, env.API_KEY).pipe(
      Effect.catch(() => Effect.succeed(false)),
    );
    return authorized
      ? yield* httpEffect
      : errorResponse(401, "UNAUTHORIZED", "Invalid machine bearer token");
  }),
);

const HttpApiLive = HttpApiBuilder.layer(CommanderApi, {
  openapiPath: "/openapi.json",
}).pipe(
  Layer.provide(Layer.mergeAll(PublicLive, MachineLive, AdminLive)),
  Layer.provide(MachineAuthLive),
  Layer.provide(HttpServer.layerServices),
);

const AgentsRoute = HttpRouter.add("*", "/agents/*", (request) =>
  withAccess(request, "read", () =>
    Effect.gen(function*() {
      const env = yield* CommanderEnvironment;
      const raw = yield* webRequest(request);
      const response = yield* Effect.tryPromise({
        try: () => routeAgentRequest(raw, env),
        catch: (cause) => cause,
      }).pipe(Effect.catch((cause) => Effect.succeed(internalFailure(cause))));
      if (HttpServerResponse.isHttpServerResponse(response)) return response;
      if (response === null) return errorResponse(404, "NOT_FOUND", "Agent not found");
      // Keep Cloudflare's non-standard `webSocket` attachment on 101 responses.
      return HttpServerResponse.raw(response, { status: response.status });
    }),
  ).pipe(
    Effect.map((response) =>
      HttpServerResponse.isHttpServerResponse(response)
        ? response
        : errorResponse(500, "INTERNAL_ERROR", "Invalid agent response")),
  ),
);

const SeatRoute = HttpRouter.add("GET", "/seats", (request) =>
  Effect.gen(function*() {
    const env = yield* CommanderEnvironment;
    const raw = yield* webRequest(request).pipe(
      Effect.catch(() => Effect.succeed(undefined)),
    );
    if (raw === undefined) return errorResponse(400, "INVALID_REQUEST", "Invalid HTTP request");
    if (!env.SEAT_REGISTRATION_TOKEN && !env.STAVKA_SEAT_KEYS) {
      return errorResponse(503, "MISCONFIGURED", "Seat registration credentials are not configured");
    }
    const principal = yield* authorizeSeatRequest(raw, env);
    if (principal === undefined) {
      return errorResponse(401, "UNAUTHORIZED", "Invalid seat bearer token");
    }
    const response = yield* Effect.tryPromise({
      try: () => env.ORCHESTRATOR.getByName(SEAT_REGISTRY_NAME).fetch(raw),
      catch: (cause) => cause,
    }).pipe(Effect.catch((cause) => Effect.succeed(internalFailure(cause))));
    if (HttpServerResponse.isHttpServerResponse(response)) return response;
    if (response === null) return errorResponse(404, "NOT_FOUND", "Seat registry not found");
    return HttpServerResponse.raw(response, { status: response.status });
  }),
);

const MethodFallbacks = Layer.mergeAll(
  HttpRouter.add("*", "/api/*", () =>
    Effect.sync(() =>
      errorResponse(405, "METHOD_NOT_ALLOWED", "Unsupported API method"),
    )),
  HttpRouter.add("*", "/admin/*", () =>
    Effect.sync(() =>
      errorResponse(405, "METHOD_NOT_ALLOWED", "Unsupported admin method"),
    )),
);

const NotFoundRoutes = Layer.mergeAll(
  HttpRouter.add("*", "/", () =>
    Effect.sync(() => errorResponse(404, "NOT_FOUND", "Route not found"))),
  HttpRouter.add("*", "/*", () =>
    Effect.sync(() => errorResponse(404, "NOT_FOUND", "Route not found"))),
);

const bodyLimit = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A | HttpServerResponse.HttpServerResponse, E, R | HttpServerRequest.HttpServerRequest> =>
  Effect.gen(function*() {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const length = Number(request.headers["content-length"] ?? "0");
    return length > MAX_BODY_BYTES
      ? errorResponse(413, "PAYLOAD_TOO_LARGE", "Payload exceeds 1MB")
      : yield* effect;
  });

const ApplicationLive = Layer.mergeAll(
  HttpApiLive,
  SeatRoute,
  AgentsRoute,
  MethodFallbacks,
  NotFoundRoutes,
);

// CommanderEnvironment is supplied per request by the Worker adapter below.
// HttpApi middleware requirements are otherwise surfaced as build-time Layer
// requirements, so erase only that dynamic requirement at this boundary.
const webHandler = HttpRouter.toWebHandler(
  ApplicationLive as Layer.Layer<never, never, HttpRouter.HttpRouter>,
  { middleware: bodyLimit },
);

const normalizedError = async (response: Response): Promise<Response> => {
  if (response.status < 400) return response;
  const text = await response.clone().text();
  if (text.length > 0) return response;
  const failure = response.status === 400
    ? errorEnvelope("INVALID_REQUEST", "Request validation failed")
    : response.status === 413
    ? errorEnvelope("PAYLOAD_TOO_LARGE", "Payload exceeds 1MB")
    : response.status === 404
    ? errorEnvelope("NOT_FOUND", "Route not found")
    : errorEnvelope("INTERNAL_ERROR", "Internal request failure");
  return Response.json(failure, { status: response.status });
};

/** Web-standard boundary used by the Worker runtime; all dispatch stays in Effect routers. */
export const handleRequest = async (request: Request, env: Env): Promise<Response> => {
  const response = await webHandler.handler(request, Context.make(CommanderEnvironment, env));
  return normalizedError(response);
};
