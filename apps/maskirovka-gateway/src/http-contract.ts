import { Schema } from "effect";
import { HttpApi, HttpApiEndpoint, HttpApiGroup } from "effect/unstable/httpapi";

import { gatewayProviders, gatewaySeats, gatewayTiers } from "./config";

export const ProviderSchema = Schema.Literals(gatewayProviders);
export const TierSchema = Schema.Literals(gatewayTiers);
export const SeatSchema = Schema.Literals(gatewaySeats);

export const AuthPayloadSchema = Schema.Struct({
  token: Schema.String.pipe(
    Schema.check(Schema.isTrimmed(), Schema.isNonEmpty(), Schema.isMaxLength(12_000)),
  ),
});

export const AliasPayloadSchema = Schema.Struct({
  seat: SeatSchema,
  model: Schema.String.pipe(
    Schema.check(Schema.isTrimmed(), Schema.isNonEmpty(), Schema.isMaxLength(256)),
  ),
});

export const KillSwitchPayloadSchema = Schema.Struct({ enabled: Schema.Boolean });

const AnyResponse = Schema.Unknown;

const GatewayApi = HttpApiGroup.make("gateway").add(
  HttpApiEndpoint.get("health", "/healthz", { success: AnyResponse }),
  HttpApiEndpoint.get("models", "/v1/models", { success: AnyResponse }),
  HttpApiEndpoint.post("responses", "/v1/responses", { success: AnyResponse }),
  HttpApiEndpoint.post("messages", "/v1/messages", { success: AnyResponse }),
  HttpApiEndpoint.get("adminStatus", "/admin/status", { success: AnyResponse }),
  HttpApiEndpoint.get("adminRequests", "/admin/requests", {
    query: { limit: Schema.optional(Schema.String) },
    success: AnyResponse,
  }),
  HttpApiEndpoint.get("adminAliases", "/admin/aliases", { success: AnyResponse }),
  HttpApiEndpoint.put("remapAlias", "/admin/aliases/:tier", {
    params: { tier: Schema.String },
    success: AnyResponse,
  }),
  HttpApiEndpoint.post("killSwitch", "/admin/kill-switch", { success: AnyResponse }),
  HttpApiEndpoint.put("putAuth", "/admin/auth/:provider", {
    params: { provider: Schema.String },
    success: AnyResponse,
  }),
  HttpApiEndpoint.delete("deleteAuth", "/admin/auth/:provider", {
    params: { provider: Schema.String },
    success: AnyResponse,
  }),
  HttpApiEndpoint.get("dashboardIndex", "/_", { success: AnyResponse }),
  HttpApiEndpoint.get("dashboardAsset", "/_/:head/*", {
    params: { head: Schema.String, "*": Schema.String },
    success: AnyResponse,
  }),
);

export const MaskirovkaGatewayApi = HttpApi.make("maskirovka-gateway").add(GatewayApi);
