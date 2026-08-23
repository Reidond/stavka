import {
  ProviderCredentialSchema,
  refreshCodexCredential,
  type ProviderCredential,
} from "@stavka/provider-auth";
import { Effect, Ref, Schema } from "effect";

import { authTokenFingerprint, type AuthCheckpoint } from "../auth-checkpoint";
import { decodeBase64Url } from "../base64";
import type { SeatProvider } from "../config";

const SHA256_HEX = /^[a-f0-9]{64}$/u;

const removeMeteredCredentials = (): void => {
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.OPENAI_API_KEY;
  delete process.env.CODEX_API_KEY;
  delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
  delete process.env.CODEX_ACCESS_TOKEN;
};

export class SubscriptionAuthStateError extends Schema.TaggedErrorClass<SubscriptionAuthStateError>(
  "stavka/maskirovka-seat/SubscriptionAuthStateError",
)("SubscriptionAuthStateError", {
  message: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {}

const assertCredential = (provider: SeatProvider, input: unknown): ProviderCredential => {
  const credential = Schema.decodeUnknownSync(ProviderCredentialSchema)(input);
  if (
    (provider === "codex" && credential.kind !== "codex-chatgpt-oauth") ||
    (provider === "claude" &&
      credential.kind !== "claude-subscription" &&
      credential.kind !== "api-key")
  )
    throw new Error(`Credential kind does not match ${provider} seat`);
  return credential;
};

const encodeCredential = (credential: ProviderCredential): string =>
  Buffer.from(JSON.stringify(credential), "utf8").toString("base64url");

const decodeCredential = (provider: SeatProvider, encoded: string): ProviderCredential =>
  assertCredential(
    provider,
    JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as unknown,
  );

export interface SubscriptionAuthState {
  readonly configured: Effect.Effect<boolean>;
  readonly checkpointAfterRotation: (
    baseFingerprint: string | undefined,
  ) => Effect.Effect<AuthCheckpoint | undefined>;
}

export const restoreSubscriptionAuth = (
  provider: SeatProvider,
): Effect.Effect<SubscriptionAuthState, SubscriptionAuthStateError> =>
  Effect.gen(function* () {
    yield* Effect.sync(removeMeteredCredentials);
    const encoded = process.env.MASKIROVKA_AUTH_STATE_B64;
    if (encoded) {
      const checkpoint = yield* Effect.try({
        try: () => {
          const decoded = JSON.parse(decodeBase64Url(encoded)) as AuthCheckpoint;
          if (decoded.version !== 2) {
            throw new Error("Unsupported provider account checkpoint version");
          }
          if (decoded.provider !== provider) {
            throw new Error("Credential checkpoint does not match this seat");
          }
          return { ...decoded, credential: assertCredential(provider, decoded.credential) };
        },
        catch: (cause) =>
          new SubscriptionAuthStateError({
            message:
              cause instanceof Error && cause.message.includes("does not match this seat")
                ? cause.message
                : "MASKIROVKA_AUTH_STATE_B64 is not a valid provider account checkpoint",
            cause,
          }),
      });
      yield* Effect.sync(() => {
        process.env.STAVKA_PROVIDER_ACCOUNT_B64 = encodeCredential(checkpoint.credential);
      });
    }

    const initial = yield* Effect.sync(() => process.env.STAVKA_PROVIDER_ACCOUNT_B64);
    const initialFingerprint = initial ? yield* authTokenFingerprint(initial) : undefined;
    const acknowledgedFingerprint = yield* Ref.make(initialFingerprint);
    return {
      configured: Effect.sync(() => Boolean(process.env.STAVKA_PROVIDER_ACCOUNT_B64)),
      checkpointAfterRotation: (baseFingerprint) => {
        if (!baseFingerprint || !SHA256_HEX.test(baseFingerprint)) return Effect.succeed(undefined);
        return Effect.gen(function* () {
          const current = yield* Effect.sync(() => process.env.STAVKA_PROVIDER_ACCOUNT_B64);
          if (!current) return undefined;
          const currentFingerprint = yield* authTokenFingerprint(current);
          if (currentFingerprint === baseFingerprint) {
            yield* Ref.set(acknowledgedFingerprint, baseFingerprint);
            return undefined;
          }
          const acknowledged = yield* Ref.get(acknowledgedFingerprint);
          if (baseFingerprint !== acknowledged) return undefined;
          return {
            version: 2 as const,
            provider,
            credential: decodeCredential(provider, current),
            base_fingerprint: baseFingerprint,
            observed_at: Date.now(),
          };
        });
      },
    };
  });

export const subscriptionCredential = (
  provider: SeatProvider,
): Effect.Effect<ProviderCredential, SubscriptionAuthStateError> =>
  Effect.gen(function* () {
    yield* Effect.sync(removeMeteredCredentials);
    const encoded = yield* Effect.sync(() => process.env.STAVKA_PROVIDER_ACCOUNT_B64);
    if (!encoded)
      return yield* Effect.fail(
        new SubscriptionAuthStateError({ message: `No ${provider} account is configured` }),
      );
    let credential = yield* Effect.try({
      try: () =>
        assertCredential(provider, JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"))),
      catch: (cause) =>
        new SubscriptionAuthStateError({ message: "Provider account is invalid", cause }),
    });
    if (credential.kind === "codex-chatgpt-oauth" && credential.expiresAt <= Date.now() + 300_000) {
      credential = yield* refreshCodexCredential(credential).pipe(
        Effect.mapError(
          (cause) => new SubscriptionAuthStateError({ message: cause.message, cause }),
        ),
      );
      const refreshed = credential;
      yield* Effect.sync(() => {
        process.env.STAVKA_PROVIDER_ACCOUNT_B64 = encodeCredential(refreshed);
      });
    }
    return credential;
  });
