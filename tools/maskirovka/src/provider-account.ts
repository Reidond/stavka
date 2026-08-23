import { homedir } from "node:os";
import { join } from "node:path";
import {
  ProviderCredentialSchema,
  refreshCodexCredential,
  type ProviderCredential,
  type ProviderId,
} from "@stavka/provider-auth";
import { LocalProfileStore } from "@stavka/provider-auth/node";
import { Effect, Schema } from "effect";

const environmentName = (provider: ProviderId): string =>
  provider === "codex" ? "STAVKA_CODEX_ACCOUNT_B64" : "STAVKA_CLAUDE_ACCOUNT_B64";

const credentialFromEnvironment = (
  provider: ProviderId,
  environment: NodeJS.ProcessEnv,
): Effect.Effect<ProviderCredential | undefined, Error> =>
  Effect.try({
    try: () => {
      const encoded = environment[environmentName(provider)];
      if (!encoded) return undefined;
      const account = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as {
        readonly credential?: unknown;
      };
      return Schema.decodeUnknownSync(ProviderCredentialSchema)(account.credential);
    },
    catch: (cause) =>
      new Error(
        cause instanceof Error
          ? `${environmentName(provider)} is invalid: ${cause.message}`
          : `${environmentName(provider)} is invalid`,
      ),
  });

export const loadProviderCredential = (
  provider: ProviderId,
  environment: NodeJS.ProcessEnv = process.env,
): Effect.Effect<ProviderCredential | undefined, Error> =>
  credentialFromEnvironment(provider, environment).pipe(
    Effect.flatMap((credential) => {
      if (credential) {
        return credential.kind === "codex-chatgpt-oauth" &&
          credential.expiresAt <= Date.now() + 300_000
          ? refreshCodexCredential(credential).pipe(
              Effect.mapError((error) => new Error(error.message)),
            )
          : Effect.succeed(credential);
      }
      const directory = environment.STAVKA_HOME ?? join(homedir(), ".stavka");
      const store = new LocalProfileStore(directory);
      return store.activeProviderAccount(provider).pipe(
        Effect.flatMap((account) => {
          if (
            account.credential.kind !== "codex-chatgpt-oauth" ||
            account.credential.expiresAt > Date.now() + 300_000
          )
            return Effect.succeed(account.credential);
          return refreshCodexCredential(account.credential).pipe(
            Effect.flatMap((refreshed) =>
              store
                .putProviderAccount(
                  { ...account, credential: refreshed, updatedAt: new Date().toISOString() },
                  false,
                )
                .pipe(Effect.as(refreshed)),
            ),
          );
        }),
        Effect.catch(() => Effect.succeed(undefined)),
      );
    }),
  );
