import { Effect, Ref, Schema } from "effect";

import { authTokenFingerprint, type AuthCheckpoint } from "../auth-checkpoint";
import { decodeBase64Url } from "../base64";
import type { SeatProvider } from "../config";

const SHA256_HEX = /^[a-f0-9]{64}$/;

const providerTokenName = (
  provider: SeatProvider,
): "CLAUDE_CODE_OAUTH_TOKEN" | "CODEX_ACCESS_TOKEN" =>
  provider === "claude" ? "CLAUDE_CODE_OAUTH_TOKEN" : "CODEX_ACCESS_TOKEN";

const removeMeteredCredentials = (): void => {
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.OPENAI_API_KEY;
  delete process.env.CODEX_API_KEY;
};

export class SubscriptionAuthStateError extends Schema.TaggedErrorClass<SubscriptionAuthStateError>(
  "stavka/maskirovka-seat/SubscriptionAuthStateError",
)("SubscriptionAuthStateError", {
  message: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {}

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
      const decoded = yield* Effect.try({
        try: () => JSON.parse(decodeBase64Url(encoded)) as unknown,
        catch: (cause) =>
          new SubscriptionAuthStateError({
            message: "MASKIROVKA_AUTH_STATE_B64 is not a valid credential checkpoint",
            cause,
          }),
      });
      if (
        typeof decoded !== "object" ||
        decoded === null ||
        !("version" in decoded) ||
        decoded.version !== 1 ||
        !("provider" in decoded) ||
        decoded.provider !== provider ||
        !("token" in decoded) ||
        typeof decoded.token !== "string" ||
        decoded.token.length === 0
      ) {
        return yield* Effect.fail(
          new SubscriptionAuthStateError({
            message: "MASKIROVKA_AUTH_STATE_B64 does not match this seat",
          }),
        );
      }
      const token = decoded.token;
      yield* Effect.sync(() => {
        process.env[providerTokenName(provider)] = token;
      });
    }

    const tokenName = providerTokenName(provider);
    const initialToken = yield* Effect.sync(() => process.env[tokenName]);
    const initialFingerprint = initialToken ? yield* authTokenFingerprint(initialToken) : undefined;
    const acknowledgedFingerprint = yield* Ref.make(initialFingerprint);
    return {
      configured: Effect.sync(() => Boolean(process.env[tokenName])),
      checkpointAfterRotation: (baseFingerprint) => {
        if (!baseFingerprint || !SHA256_HEX.test(baseFingerprint)) return Effect.succeed(undefined);
        return Effect.gen(function* () {
          const token = yield* Effect.sync(() => process.env[tokenName]);
          if (!token) return undefined;
          const currentFingerprint = yield* authTokenFingerprint(token);
          if (currentFingerprint === baseFingerprint) {
            yield* Ref.set(acknowledgedFingerprint, baseFingerprint);
            return undefined;
          }
          const acknowledged = yield* Ref.get(acknowledgedFingerprint);
          if (baseFingerprint !== acknowledged) return undefined;
          return {
            version: 1 as const,
            provider,
            token,
            base_fingerprint: baseFingerprint,
            observed_at: Date.now(),
          };
        });
      },
    };
  });

export const subscriptionEnvironment = (
  provider: SeatProvider,
): Effect.Effect<Record<string, string>> =>
  Effect.sync(() => {
    removeMeteredCredentials();
    const allowed = [
      "PATH",
      "HOME",
      "CODEX_HOME",
      "LANG",
      "LC_ALL",
      "SHELL",
      "USER",
      "TMPDIR",
      providerTokenName(provider),
    ];
    const environment: Record<string, string> = {};
    for (const name of allowed) {
      const value = process.env[name];
      if (value) environment[name] = value;
    }
    return environment;
  });
