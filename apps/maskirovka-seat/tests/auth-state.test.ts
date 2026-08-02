import { afterEach, describe, expect, it } from "vitest";

import { Effect } from "effect";
import { authTokenFingerprint } from "../src/auth-checkpoint";
import { restoreSubscriptionAuth, subscriptionEnvironment } from "../src/container/auth-state";
import { encodeBase64Url } from "../src/base64";

const originalEnvironment = { ...process.env };

afterEach(() => {
  for (const name of Object.keys(process.env)) delete process.env[name];
  Object.assign(process.env, originalEnvironment);
});

describe("container subscription auth", () => {
  it("restores injected auth but checkpoints only a post-bootstrap rotation", async () => {
    process.env.ANTHROPIC_API_KEY = "metered-anthropic";
    process.env.OPENAI_API_KEY = "metered-openai";
    process.env.CODEX_API_KEY = "metered-codex";
    process.env.MASKIROVKA_AUTH_STATE_B64 = encodeBase64Url(
      JSON.stringify({
        version: 1,
        provider: "codex",
        token: "subscription-token",
        observed_at: 1,
      }),
    );

    const authState = await Effect.runPromise(restoreSubscriptionAuth("codex"));
    const baseFingerprint = await Effect.runPromise(authTokenFingerprint("subscription-token"));

    expect(process.env.CODEX_ACCESS_TOKEN).toBe("subscription-token");
    expect(process.env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(process.env.OPENAI_API_KEY).toBeUndefined();
    expect(process.env.CODEX_API_KEY).toBeUndefined();
    expect(Effect.runSync(subscriptionEnvironment("codex"))).toMatchObject({
      CODEX_ACCESS_TOKEN: "subscription-token",
    });
    expect(
      await Effect.runPromise(authState.checkpointAfterRotation(baseFingerprint)),
    ).toBeUndefined();

    process.env.CODEX_ACCESS_TOKEN = "rotated-subscription-token";
    await expect(
      Effect.runPromise(authState.checkpointAfterRotation("b".repeat(64))),
    ).resolves.toBeUndefined();
    await expect(
      Effect.runPromise(authState.checkpointAfterRotation(baseFingerprint)),
    ).resolves.toMatchObject({
      version: 1,
      provider: "codex",
      token: "rotated-subscription-token",
      base_fingerprint: baseFingerprint,
    });

    const rotatedFingerprint = await Effect.runPromise(
      authTokenFingerprint("rotated-subscription-token"),
    );
    await expect(
      Effect.runPromise(authState.checkpointAfterRotation(rotatedFingerprint)),
    ).resolves.toBeUndefined();
    process.env.CODEX_ACCESS_TOKEN = "second-rotation";
    await expect(
      Effect.runPromise(authState.checkpointAfterRotation(rotatedFingerprint)),
    ).resolves.toMatchObject({
      token: "second-rotation",
      base_fingerprint: rotatedFingerprint,
    });
  });

  it("rejects a checkpoint intended for another provider", async () => {
    process.env.MASKIROVKA_AUTH_STATE_B64 = encodeBase64Url(
      JSON.stringify({
        version: 1,
        provider: "claude",
        token: "oauth",
        observed_at: 1,
      }),
    );

    await expect(Effect.runPromise(restoreSubscriptionAuth("codex"))).rejects.toThrow(
      "does not match this seat",
    );
  });
});
