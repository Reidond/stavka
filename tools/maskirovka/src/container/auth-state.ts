import { ProviderCredentialSchema } from "@stavka/provider-auth";
import { Effect, Schema } from "effect";

import { decodeBase64Url } from "./base64";

const ProviderState = Schema.Struct({
  name: Schema.String,
  auth_kind: Schema.String,
  credential: ProviderCredentialSchema,
  revision: Schema.Number,
});

const GatewayAuthCheckpointSchema = Schema.Struct({
  version: Schema.Literal(2),
  providers: Schema.Struct({
    claude: Schema.optional(ProviderState),
    codex: Schema.optional(ProviderState),
  }),
  observed_at: Schema.Number,
});

export type GatewayAuthCheckpoint = Schema.Schema.Type<typeof GatewayAuthCheckpointSchema>;

const providerAccountName = (
  provider: "claude" | "codex",
): "STAVKA_CLAUDE_ACCOUNT_B64" | "STAVKA_CODEX_ACCOUNT_B64" =>
  provider === "claude" ? "STAVKA_CLAUDE_ACCOUNT_B64" : "STAVKA_CODEX_ACCOUNT_B64";

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

/** Restore both named accounts before any provider implementation is imported. */
export const restoreGatewaySubscriptionAuth = (): Effect.Effect<void, Error> =>
  Effect.gen(function* () {
    yield* Effect.sync(removeMeteredCredentials);
    const checkpoint = yield* checkpointFromEnvironment();
    if (!checkpoint) return;
    for (const provider of ["claude", "codex"] as const) {
      const state = checkpoint.providers[provider];
      if (state) {
        process.env[providerAccountName(provider)] = Buffer.from(
          JSON.stringify(state),
          "utf8",
        ).toString("base64url");
      }
    }
  });
