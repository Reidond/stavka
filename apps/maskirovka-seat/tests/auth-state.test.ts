import { Effect } from "effect";
import { afterEach, describe, expect, it } from "vitest";

import { authTokenFingerprint } from "../src/auth-checkpoint";
import { encodeBase64Url } from "../src/base64";
import { restoreSubscriptionAuth, subscriptionCredential } from "../src/container/auth-state";

const originalEnvironment = { ...process.env };
const credentialExpiresAt = Date.now() + 60 * 60_000;
const codexCredential = (accessToken: string) => ({
  kind: "codex-chatgpt-oauth" as const,
  accessToken,
  refreshToken: "refresh-token",
  expiresAt: credentialExpiresAt,
  accountId: "account-1",
});
const encodedCredential = (accessToken: string): string =>
  Buffer.from(JSON.stringify(codexCredential(accessToken)), "utf8").toString("base64url");

afterEach(() => {
  for (const name of Object.keys(process.env)) delete process.env[name];
  Object.assign(process.env, originalEnvironment);
});

describe("container subscription account state", () => {
  it("restores an account checkpoint and reports only post-bootstrap rotation", async () => {
    const initial = encodedCredential("initial-access");
    process.env.ANTHROPIC_API_KEY = "metered-anthropic";
    process.env.MASKIROVKA_AUTH_STATE_B64 = encodeBase64Url(
      JSON.stringify({
        version: 2,
        provider: "codex",
        credential: codexCredential("initial-access"),
        base_fingerprint: "a".repeat(64),
        observed_at: 1,
      }),
    );

    const authState = await Effect.runPromise(restoreSubscriptionAuth("codex"));
    const baseFingerprint = await Effect.runPromise(authTokenFingerprint(initial));

    expect(process.env.STAVKA_PROVIDER_ACCOUNT_B64).toBe(initial);
    expect(process.env.ANTHROPIC_API_KEY).toBeUndefined();
    await expect(Effect.runPromise(subscriptionCredential("codex"))).resolves.toMatchObject({
      accessToken: "initial-access",
    });
    await expect(authState.configured.pipe(Effect.runPromise)).resolves.toBe(true);
    await expect(
      Effect.runPromise(authState.checkpointAfterRotation(baseFingerprint)),
    ).resolves.toBeUndefined();

    process.env.STAVKA_PROVIDER_ACCOUNT_B64 = encodedCredential("rotated-access");
    await expect(
      Effect.runPromise(authState.checkpointAfterRotation(baseFingerprint)),
    ).resolves.toMatchObject({
      version: 2,
      provider: "codex",
      credential: { accessToken: "rotated-access" },
      base_fingerprint: baseFingerprint,
    });
  });

  it("rejects a checkpoint intended for another provider", async () => {
    process.env.MASKIROVKA_AUTH_STATE_B64 = encodeBase64Url(
      JSON.stringify({
        version: 2,
        provider: "claude",
        credential: { kind: "claude-subscription", oauthToken: "oauth" },
        base_fingerprint: "a".repeat(64),
        observed_at: 1,
      }),
    );
    await expect(Effect.runPromise(restoreSubscriptionAuth("codex"))).rejects.toThrow(
      "does not match this seat",
    );
  });
});
