import { afterEach, describe, expect, it } from "vitest";
import { Effect } from "effect";

import { encodeBase64Url } from "../src/container/base64";
import { restoreGatewaySubscriptionAuth } from "../src/container/auth-state";

const originalEnvironment = { ...process.env };

afterEach(() => {
  for (const name of Object.keys(process.env)) delete process.env[name];
  Object.assign(process.env, originalEnvironment);
});

describe("gateway container subscription auth", () => {
  it("restores both providers and strips metered API keys before SDKs start", async () => {
    process.env.ANTHROPIC_API_KEY = "metered-anthropic";
    process.env.OPENAI_API_KEY = "metered-openai";
    process.env.CODEX_API_KEY = "metered-codex";
    process.env.MASKIROVKA_AUTH_STATE_B64 = encodeBase64Url(
      JSON.stringify({
        version: 1,
        providers: {
          claude: { token: "claude-subscription", fingerprint: "a".repeat(64) },
          codex: { token: "codex-subscription", fingerprint: "b".repeat(64) },
        },
        observed_at: 1,
      }),
    );

    await Effect.runPromise(restoreGatewaySubscriptionAuth());

    expect(process.env.CLAUDE_CODE_OAUTH_TOKEN).toBe("claude-subscription");
    expect(process.env.CODEX_ACCESS_TOKEN).toBe("codex-subscription");
    expect(process.env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(process.env.OPENAI_API_KEY).toBeUndefined();
    expect(process.env.CODEX_API_KEY).toBeUndefined();
  });

  it("boots without doctor/.dev.vars side effects when no checkpoint is present", async () => {
    delete process.env.MASKIROVKA_AUTH_STATE_B64;
    process.env.ANTHROPIC_API_KEY = "metered";

    await Effect.runPromise(restoreGatewaySubscriptionAuth());

    expect(process.env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
    expect(process.env.CODEX_ACCESS_TOKEN).toBeUndefined();
    expect(process.env.ANTHROPIC_API_KEY).toBeUndefined();
  });

  it("rejects an invalid auth checkpoint instead of starting with partial secrets", async () => {
    process.env.MASKIROVKA_AUTH_STATE_B64 = encodeBase64Url(
      JSON.stringify({
        version: 1,
        providers: { claude: { token: "", fingerprint: "a".repeat(64) } },
        observed_at: 1,
      }),
    );

    await expect(Effect.runPromise(restoreGatewaySubscriptionAuth())).rejects.toThrow(
      /MASKIROVKA_AUTH_STATE_B64 is invalid/u,
    );
  });
});
