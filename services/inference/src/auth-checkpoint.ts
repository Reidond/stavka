import { Effect, Schema } from "effect";

import { encodeBase64Url } from "./base64";
import { ProviderCredentialSchema } from "@stavka/provider-auth";
import { gatewayProviders, type GatewayProvider } from "./config";

const AuthProviderCheckpoint = Schema.Struct({
  name: Schema.String,
  auth_kind: Schema.String,
  credential: ProviderCredentialSchema,
  revision: Schema.Number,
});

const AuthCheckpointSchema = Schema.Struct({
  version: Schema.Literal(2),
  providers: Schema.Struct({
    claude: Schema.optional(AuthProviderCheckpoint),
    codex: Schema.optional(AuthProviderCheckpoint),
  }),
  observed_at: Schema.Number,
});

export type GatewayAuthCheckpoint = Schema.Schema.Type<typeof AuthCheckpointSchema>;

export const authTokenFingerprint = (token: string): Effect.Effect<string, Error> =>
  Effect.tryPromise({
    try: async () => {
      const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
      return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join(
        "",
      );
    },
    catch: (cause) => (cause instanceof Error ? cause : new Error("Unable to fingerprint auth")),
  });

export const encodeAuthCheckpoint = (providers: GatewayAuthCheckpoint["providers"]): string =>
  encodeBase64Url(
    JSON.stringify({
      version: 2,
      providers,
      observed_at: Date.now(),
    } satisfies GatewayAuthCheckpoint),
  );

export const providerCheckpoint = (
  checkpoint: GatewayAuthCheckpoint,
  provider: GatewayProvider,
): GatewayAuthCheckpoint["providers"][GatewayProvider] => checkpoint.providers[provider];

export const checkpointProviders = gatewayProviders;
