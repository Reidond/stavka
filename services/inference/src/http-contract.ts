import { Schema } from "effect";
import { HttpApi, HttpApiEndpoint, HttpApiGroup } from "effect/unstable/httpapi";
import {
  AccountSessionSchema,
  ActiveAccountSessionSchema,
  OrganizationUserSchema,
  SignUpPayloadSchema,
} from "@stavka/access-auth";
import {
  OwnedProviderAccountPublicSchema,
  ProviderAccountNameSchema,
  ProvisionProviderAccountPayloadSchema,
} from "@stavka/provider-auth";

import { gatewayProviders, gatewaySeats, gatewayTiers } from "./config";

export const ProviderSchema = Schema.Literals(gatewayProviders);
export const TierSchema = Schema.Literals(gatewayTiers);
export const SeatSchema = Schema.Literals(gatewaySeats);

export { ProvisionProviderAccountPayloadSchema };
export { SignUpPayloadSchema };
export const AccountNameSchema = ProviderAccountNameSchema;

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
  HttpApiEndpoint.get("accountSession", "/auth/session", { success: AccountSessionSchema }),
  HttpApiEndpoint.post("signUpAccount", "/auth/signup", {
    payload: SignUpPayloadSchema,
    success: ActiveAccountSessionSchema,
  }),
  HttpApiEndpoint.get("organizationUsers", "/account/users", {
    success: Schema.Struct({ users: Schema.Array(OrganizationUserSchema) }),
  }),
  HttpApiEndpoint.get("adminStatus", "/admin/status", { success: AnyResponse }),
  HttpApiEndpoint.get("adminRequests", "/admin/requests", {
    query: { limit: Schema.optional(Schema.String) },
    success: AnyResponse,
  }),
  HttpApiEndpoint.get("adminAliases", "/admin/aliases", { success: AnyResponse }),
  HttpApiEndpoint.put("remapAlias", "/admin/aliases/:tier", {
    params: { tier: TierSchema },
    payload: AliasPayloadSchema,
    success: AnyResponse,
  }),
  HttpApiEndpoint.post("killSwitch", "/admin/kill-switch", {
    payload: KillSwitchPayloadSchema,
    success: AnyResponse,
  }),
  HttpApiEndpoint.get("providerAccounts", "/admin/provider-accounts", {
    success: Schema.Struct({
      account: ActiveAccountSessionSchema,
      accounts: Schema.Array(OwnedProviderAccountPublicSchema),
    }),
  }),
  HttpApiEndpoint.put("putProviderAccount", "/admin/provider-accounts/:provider/:name", {
    params: { provider: ProviderSchema, name: AccountNameSchema },
    payload: ProvisionProviderAccountPayloadSchema,
    success: OwnedProviderAccountPublicSchema,
  }),
  HttpApiEndpoint.delete("deleteProviderAccount", "/admin/provider-accounts/:provider/:name", {
    params: { provider: ProviderSchema, name: AccountNameSchema },
    success: AnyResponse,
  }),
  HttpApiEndpoint.post(
    "activateProviderAccount",
    "/admin/provider-accounts/:provider/:name/activate",
    {
      params: { provider: ProviderSchema, name: AccountNameSchema },
      success: OwnedProviderAccountPublicSchema,
    },
  ),
  HttpApiEndpoint.post("testProviderAccount", "/admin/provider-accounts/:provider/:name/test", {
    params: { provider: ProviderSchema, name: AccountNameSchema },
    success: Schema.Struct({
      provider: OwnedProviderAccountPublicSchema.fields.provider,
      name: OwnedProviderAccountPublicSchema.fields.name,
      test: Schema.Literal("credential-decrypted"),
      label: OwnedProviderAccountPublicSchema.fields.label,
      authKind: OwnedProviderAccountPublicSchema.fields.authKind,
      remoteAccountId: Schema.optional(Schema.String),
      remoteWorkspaceId: Schema.optional(Schema.String),
      active: Schema.Boolean,
      revision: Schema.Number,
      createdAt: Schema.Number,
      updatedAt: Schema.Number,
      owner: OwnedProviderAccountPublicSchema.fields.owner,
      organization: OwnedProviderAccountPublicSchema.fields.organization,
    }),
  }),
  HttpApiEndpoint.get("dashboardIndex", "/_", { success: AnyResponse }),
  HttpApiEndpoint.get("dashboardAsset", "/_/:head/*", {
    params: { head: Schema.String, "*": Schema.String },
    success: AnyResponse,
  }),
);

export const MaskirovkaGatewayApi = HttpApi.make("maskirovka-gateway").add(GatewayApi);
