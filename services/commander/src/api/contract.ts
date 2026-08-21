import {
  ConnectRequest,
  ConnectResponse,
  DisconnectRequest,
  ErrorEnvelope,
  LlmSeatRegistrationRequest,
  MapUploadRequest,
  SessionExportSchema,
  TickRequest,
  TickResponse,
} from "@stavka/protocol";
import { Schema } from "effect";
import {
  HttpApi,
  HttpApiEndpoint,
  HttpApiGroup,
  HttpApiMiddleware,
  HttpApiSchema,
} from "effect/unstable/httpapi";

import { DecisionLogEntry } from "../logging/types";
import { CommanderEnvironment } from "../config";
import { CommanderSessionStateSchema, SeatRegistrationSchema } from "../state/types";
import { SessionExportHeader, SessionExportPage } from "../logging/r2-session-export-repository";

const BadRequest = ErrorEnvelope.pipe(HttpApiSchema.status(400));
const Unauthorized = ErrorEnvelope.pipe(HttpApiSchema.status(401));
const Forbidden = ErrorEnvelope.pipe(HttpApiSchema.status(403));
const NotFound = ErrorEnvelope.pipe(HttpApiSchema.status(404));
const MethodNotAllowed = ErrorEnvelope.pipe(HttpApiSchema.status(405));
const Conflict = ErrorEnvelope.pipe(HttpApiSchema.status(409));
const PayloadTooLarge = ErrorEnvelope.pipe(HttpApiSchema.status(413));
const InternalServerError = ErrorEnvelope.pipe(HttpApiSchema.status(500));
const ServiceUnavailable = ErrorEnvelope.pipe(HttpApiSchema.status(503));

export class MachineAuth extends HttpApiMiddleware.Service<
  MachineAuth,
  { requires: CommanderEnvironment }
>()("stavka/commander/http/MachineAuth") {}

const ApiErrors = [
  BadRequest,
  Unauthorized,
  Forbidden,
  NotFound,
  MethodNotAllowed,
  Conflict,
  PayloadTooLarge,
  InternalServerError,
  ServiceUnavailable,
] as const;

const MissionEpochHeaders = {
  "x-stavka-mission-epoch": Schema.optional(Schema.NumberFromString),
};

const AdminQuery = {
  session_id: Schema.String,
  faction: Schema.String,
  epoch: Schema.optional(Schema.NumberFromString),
};

const ExportId = Schema.String.pipe(Schema.check(Schema.isTrimmed(), Schema.isNonEmpty()));

const SessionExportMetadataResponse = Schema.Struct({
  key: Schema.String,
  sessionId: Schema.String,
  faction: Schema.String,
  missionEpoch: Schema.Number,
  exportedAt: Schema.Number,
  exportId: Schema.optional(Schema.String),
  storage: Schema.Literals(["inline", "chunked"]),
  chunkCount: Schema.Number,
  payloadSize: Schema.Number,
  size: Schema.Number,
  etag: Schema.String,
  uploadedAt: Schema.String,
});

const SessionExportListResponse = Schema.Struct({
  exports: Schema.Array(SessionExportMetadataResponse),
  /** Opaque R2 cursor; pass it unchanged to retrieve the next list page. */
  cursor: Schema.optional(Schema.String),
});

const SessionExportDownloadPageResponse = Schema.Struct({
  metadata: SessionExportMetadataResponse,
  header: SessionExportHeader,
  page: SessionExportPage,
  index: Schema.Number,
  /** Opaque continuation cursor; absent after the final export page. */
  cursor: Schema.optional(Schema.String),
});

/**
 * HttpApi decodes JSON payloads with Schema's default excess-key policy. The
 * simulation protocol is a closed wire contract, so attach strict parsing to
 * its live command boundaries instead of silently stripping an unknown field.
 */
const strictPayload = <S extends Schema.Top>(schema: S): S["Rebuild"] =>
  schema.annotate({ parseOptions: { onExcessProperty: "error" } });

const StrictConnectRequest = strictPayload(ConnectRequest);
const StrictTickRequest = strictPayload(TickRequest);
const StrictDisconnectRequest = strictPayload(DisconnectRequest);
const StrictMapUploadRequest = strictPayload(MapUploadRequest);

const HealthResponse = Schema.Struct({
  ok: Schema.Boolean,
  /** live: fully configured; degraded: serving but incomplete alias/provider config; not_ready: unusable. */
  status: Schema.Literals(["live", "degraded", "not_ready"]),
  service: Schema.Literal("stavka-commander"),
  protocol_version: Schema.Literal(1),
  ai: Schema.Struct({
    provider: Schema.Literals(["mock", "openai", "anthropic"]),
    commander: Schema.String,
    sergeant: Schema.String,
    heavy: Schema.String,
    /** Per-alias readiness: each active alias must resolve to a non-empty model id. */
    aliases: Schema.Array(
      Schema.Struct({
        alias: Schema.String,
        model: Schema.String,
        ready: Schema.Boolean,
      }),
    ),
  }),
});

const MapAcceptedResponse = Schema.Struct({
  accepted: Schema.Literal(true),
  key: Schema.String,
});

const PublicGroup = HttpApiGroup.make("public", { topLevel: true }).add(
  HttpApiEndpoint.get("health", "/healthz", {
    success: HealthResponse,
    error: ApiErrors,
  }),
);

const MachineGroup = HttpApiGroup.make("machine")
  .add(
    HttpApiEndpoint.post("connect", "/api/connect", {
      payload: StrictConnectRequest,
      success: ConnectResponse,
      error: ApiErrors,
    }),
    HttpApiEndpoint.post("tick", "/api/tick", {
      headers: MissionEpochHeaders,
      payload: StrictTickRequest,
      success: TickResponse,
      error: ApiErrors,
    }),
    HttpApiEndpoint.post("disconnect", "/api/disconnect", {
      headers: MissionEpochHeaders,
      payload: StrictDisconnectRequest,
      success: HttpApiSchema.NoContent,
      error: ApiErrors,
    }),
    HttpApiEndpoint.post("map", "/api/map", {
      payload: StrictMapUploadRequest,
      success: MapAcceptedResponse,
      error: ApiErrors,
    }),
  )
  .middleware(MachineAuth);

const AdminGroup = HttpApiGroup.make("admin").add(
  HttpApiEndpoint.get("session", "/admin/session", {
    query: AdminQuery,
    success: CommanderSessionStateSchema,
    error: ApiErrors,
  }),
  HttpApiEndpoint.get("logs", "/admin/logs", {
    query: {
      ...AdminQuery,
      limit: Schema.optional(Schema.NumberFromString),
    },
    success: Schema.Array(DecisionLogEntry),
    error: ApiErrors,
  }),
  HttpApiEndpoint.get("seats", "/admin/seats", {
    success: Schema.Array(SeatRegistrationSchema),
    error: ApiErrors,
  }),
  HttpApiEndpoint.post("registerSeat", "/admin/seats", {
    payload: LlmSeatRegistrationRequest,
    success: Schema.Array(SeatRegistrationSchema),
    error: ApiErrors,
  }),
  HttpApiEndpoint.delete("removeSeat", "/admin/seats/:seatId", {
    params: { seatId: Schema.String },
    success: Schema.Array(SeatRegistrationSchema),
    error: ApiErrors,
  }),
  HttpApiEndpoint.get("exportSession", "/admin/export", {
    query: AdminQuery,
    success: SessionExportSchema,
    error: ApiErrors,
  }),
  HttpApiEndpoint.post("persistSessionExport", "/admin/exports", {
    query: {
      ...AdminQuery,
      export_id: Schema.optional(ExportId),
    },
    success: SessionExportMetadataResponse,
    error: ApiErrors,
  }),
  HttpApiEndpoint.get("listSessionExports", "/admin/exports", {
    query: {
      ...AdminQuery,
      limit: Schema.optional(Schema.NumberFromString),
      cursor: Schema.optional(Schema.String),
    },
    success: SessionExportListResponse,
    error: ApiErrors,
  }),
  HttpApiEndpoint.get("readSessionExport", "/admin/exports/object", {
    query: { key: Schema.String, cursor: Schema.optional(Schema.String) },
    success: SessionExportDownloadPageResponse,
    error: ApiErrors,
  }),
);

export const CommanderApi = HttpApi.make("stavka-commander").add(
  PublicGroup,
  MachineGroup,
  AdminGroup,
);
