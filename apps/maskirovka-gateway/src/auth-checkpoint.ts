import { Effect, Schema } from "effect";

import { encodeBase64Url } from "./base64";
import { gatewayProviders, type GatewayProvider } from "./config";

const Fingerprint = Schema.String.pipe(Schema.check(Schema.isPattern(/^[a-f0-9]{64}$/u)));
const AuthProviderCheckpoint = Schema.Struct({
  token: Schema.String,
  fingerprint: Fingerprint,
});

const AuthCheckpointSchema = Schema.Struct({
  version: Schema.Literal(1),
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

export const encodeAuthCheckpoint = (
  providers: Partial<
    Record<GatewayProvider, { readonly token: string; readonly fingerprint: string }>
  >,
): string =>
  encodeBase64Url(
    JSON.stringify({
      version: 1,
      providers,
      observed_at: Date.now(),
    } satisfies GatewayAuthCheckpoint),
  );

export const providerCheckpoint = (
  checkpoint: GatewayAuthCheckpoint,
  provider: GatewayProvider,
): GatewayAuthCheckpoint["providers"][GatewayProvider] => checkpoint.providers[provider];

export const checkpointProviders = gatewayProviders;
