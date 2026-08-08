import { Effect, Schema } from "effect";

import { decodeBase64Url } from "./base64";

const ProviderState = Schema.Struct({
  token: Schema.String,
  fingerprint: Schema.optional(Schema.String),
});

const GatewayAuthCheckpointSchema = Schema.Struct({
  version: Schema.Literal(1),
  providers: Schema.Struct({
    claude: Schema.optional(ProviderState),
    codex: Schema.optional(ProviderState),
  }),
  observed_at: Schema.Number,
});

export type GatewayAuthCheckpoint = Schema.Schema.Type<typeof GatewayAuthCheckpointSchema>;

const providerTokenName = (
  provider: "claude" | "codex",
): "CLAUDE_CODE_OAUTH_TOKEN" | "CODEX_ACCESS_TOKEN" =>
  provider === "claude" ? "CLAUDE_CODE_OAUTH_TOKEN" : "CODEX_ACCESS_TOKEN";

const removeMeteredCredentials = (): void => {
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.OPENAI_API_KEY;
  delete process.env.CODEX_API_KEY;
};

const checkpointFromEnvironment = (): Effect.Effect<GatewayAuthCheckpoint | undefined, Error> =>
  Effect.gen(function* () {
    const encoded = process.env.MASKIROVKA_AUTH_STATE_B64;
    if (!encoded) return undefined;
    return yield* Effect.try({
      try: () => {
        const decoded = Schema.decodeUnknownSync(GatewayAuthCheckpointSchema)(
          JSON.parse(decodeBase64Url(encoded)) as unknown,
        );
        for (const provider of ["claude", "codex"] as const) {
          const state = decoded.providers[provider];
          if (state && (state.token.length === 0 || state.token.length > 12_000)) {
            throw new Error(`${provider} auth token has an invalid length`);
          }
        }
        return decoded;
      },
      catch: (cause) =>
        new Error(
          cause instanceof Error
            ? `MASKIROVKA_AUTH_STATE_B64 is invalid: ${cause.message}`
            : "MASKIROVKA_AUTH_STATE_B64 is invalid",
        ),
    });
  });

/** Restore both subscription credentials before any provider SDK is imported. */
export const restoreGatewaySubscriptionAuth = (): Effect.Effect<void, Error> =>
  Effect.gen(function* () {
    yield* Effect.sync(removeMeteredCredentials);
    const checkpoint = yield* checkpointFromEnvironment();
    if (!checkpoint) return;
    for (const provider of ["claude", "codex"] as const) {
      const state = checkpoint.providers[provider];
      if (state) process.env[providerTokenName(provider)] = state.token;
    }
  });
