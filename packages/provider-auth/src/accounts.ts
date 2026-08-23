import { Data, Schema } from "effect";

export const ProviderIdSchema = Schema.Literals(["codex", "claude"]);
export type ProviderId = typeof ProviderIdSchema.Type;

const SecretSchema = Schema.String.pipe(Schema.check(Schema.isNonEmpty()));

export const ProviderAccountNameSchema = Schema.String.pipe(
  Schema.check(
    Schema.isTrimmed(),
    Schema.isNonEmpty(),
    Schema.isMaxLength(64),
    Schema.isPattern(/^[a-z0-9][a-z0-9._-]*$/u),
  ),
);

export const CodexOAuthCredentialSchema = Schema.Struct({
  kind: Schema.Literal("codex-chatgpt-oauth"),
  accessToken: SecretSchema,
  refreshToken: SecretSchema,
  expiresAt: Schema.Number,
  accountId: SecretSchema,
  workspaceId: Schema.optional(Schema.String),
  identity: Schema.optional(Schema.String),
});
export type CodexOAuthCredential = typeof CodexOAuthCredentialSchema.Type;

export const ClaudeSubscriptionCredentialSchema = Schema.Struct({
  kind: Schema.Literal("claude-subscription"),
  oauthToken: SecretSchema,
  expiresAt: Schema.optional(Schema.Number),
  remoteAccountId: Schema.optional(Schema.String),
  remoteWorkspaceId: Schema.optional(Schema.String),
});
export type ClaudeSubscriptionCredential = typeof ClaudeSubscriptionCredentialSchema.Type;

export const ProviderApiKeyCredentialSchema = Schema.Struct({
  kind: Schema.Literal("api-key"),
  apiKey: SecretSchema,
});
export type ProviderApiKeyCredential = typeof ProviderApiKeyCredentialSchema.Type;

export const ProviderCredentialSchema = Schema.Union([
  CodexOAuthCredentialSchema,
  ClaudeSubscriptionCredentialSchema,
  ProviderApiKeyCredentialSchema,
]);
export type ProviderCredential = typeof ProviderCredentialSchema.Type;

export const ProviderAccountSchema = Schema.Struct({
  provider: ProviderIdSchema,
  name: ProviderAccountNameSchema,
  label: Schema.String.pipe(
    Schema.check(Schema.isTrimmed(), Schema.isNonEmpty(), Schema.isMaxLength(120)),
  ),
  authKind: Schema.Literals(["chatgpt-oauth", "claude-subscription", "anthropic-api-key"]),
  credential: ProviderCredentialSchema,
  remoteAccountId: Schema.optional(Schema.String),
  remoteWorkspaceId: Schema.optional(Schema.String),
  createdAt: Schema.String,
  updatedAt: Schema.String,
});
export type ProviderAccount = typeof ProviderAccountSchema.Type;

export const CloudflareAccessProfileSchema = Schema.Struct({
  name: ProviderAccountNameSchema,
  label: Schema.String.pipe(
    Schema.check(Schema.isTrimmed(), Schema.isNonEmpty(), Schema.isMaxLength(120)),
  ),
  url: Schema.String,
  auth: Schema.Union([
    Schema.Struct({ kind: Schema.Literal("local") }),
    Schema.Struct({ kind: Schema.Literal("access-token"), token: SecretSchema }),
    Schema.Struct({
      kind: Schema.Literal("service-token"),
      clientId: SecretSchema,
      clientSecret: SecretSchema,
    }),
  ]),
  createdAt: Schema.String,
  updatedAt: Schema.String,
});
export type CloudflareAccessProfile = typeof CloudflareAccessProfileSchema.Type;

export const LocalProfilesSchema = Schema.Struct({
  version: Schema.Literal(1),
  providerAccounts: Schema.Array(ProviderAccountSchema),
  cloudflareProfiles: Schema.Array(CloudflareAccessProfileSchema),
  active: Schema.Struct({
    codex: Schema.optional(Schema.String),
    claude: Schema.optional(Schema.String),
    cloudflare: Schema.optional(Schema.String),
  }),
});
export type LocalProfiles = typeof LocalProfilesSchema.Type;

export const emptyLocalProfiles = (): LocalProfiles => ({
  version: 1,
  providerAccounts: [],
  cloudflareProfiles: [],
  active: {},
});

export const ProvisionProviderAccountPayloadSchema = Schema.Struct({
  label: Schema.String.pipe(
    Schema.check(Schema.isTrimmed(), Schema.isNonEmpty(), Schema.isMaxLength(120)),
  ),
  authKind: ProviderAccountSchema.fields.authKind,
  credential: ProviderCredentialSchema,
  remoteAccountId: Schema.optional(Schema.String),
  remoteWorkspaceId: Schema.optional(Schema.String),
  activate: Schema.optional(Schema.Boolean),
});
export type ProvisionProviderAccountPayload = typeof ProvisionProviderAccountPayloadSchema.Type;

export interface ProviderAccountPublic {
  readonly provider: ProviderId;
  readonly name: string;
  readonly label: string;
  readonly authKind: ProviderAccount["authKind"];
  readonly remoteAccountId?: string;
  readonly remoteWorkspaceId?: string;
  readonly active: boolean;
  readonly revision: number;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export class ProviderAuthError extends Data.TaggedError("ProviderAuthError")<{
  readonly operation: string;
  readonly message: string;
  readonly status?: number;
}> {}

export const providerAccountKey = (provider: ProviderId, name: string): string =>
  `${provider}/${name}`;

export const publicProviderAccount = (
  account: ProviderAccount,
): Omit<ProviderAccount, "credential"> => {
  const { credential: _credential, ...safe } = account;
  return safe;
};
