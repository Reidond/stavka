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
  it("restores both named accounts and strips metered API keys before providers start", async () => {
    process.env.ANTHROPIC_API_KEY = "metered-anthropic";
    process.env.OPENAI_API_KEY = "metered-openai";
    process.env.CODEX_API_KEY = "metered-codex";
    process.env.MASKIROVKA_AUTH_STATE_B64 = encodeBase64Url(
      JSON.stringify({
        version: 2,
        providers: {
          claude: {
            name: "max",
            auth_kind: "claude-subscription",
            credential: { kind: "claude-subscription", oauthToken: "claude-subscription" },
            revision: 1,
          },
          codex: {
            name: "plus",
            auth_kind: "chatgpt-oauth",
            credential: {
              kind: "codex-chatgpt-oauth",
              accessToken: "codex-access",
              refreshToken: "codex-refresh",
              expiresAt: Date.now() + 60_000,
              accountId: "account-1",
            },
            revision: 2,
          },
        },
        observed_at: 1,
      }),
    );

    await Effect.runPromise(restoreGatewaySubscriptionAuth());

    expect(
      JSON.parse(Buffer.from(process.env.STAVKA_CLAUDE_ACCOUNT_B64!, "base64url").toString("utf8")),
    ).toMatchObject({ name: "max", credential: { oauthToken: "claude-subscription" } });
    expect(
      JSON.parse(Buffer.from(process.env.STAVKA_CODEX_ACCOUNT_B64!, "base64url").toString("utf8")),
    ).toMatchObject({ name: "plus", credential: { refreshToken: "codex-refresh" } });
    expect(process.env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
    expect(process.env.CODEX_ACCESS_TOKEN).toBeUndefined();
    expect(process.env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(process.env.OPENAI_API_KEY).toBeUndefined();
    expect(process.env.CODEX_API_KEY).toBeUndefined();
  });

  it("boots without doctor/.dev.vars side effects when no checkpoint is present", async () => {
    delete process.env.MASKIROVKA_AUTH_STATE_B64;
    process.env.ANTHROPIC_API_KEY = "metered";

    await Effect.runPromise(restoreGatewaySubscriptionAuth());

    expect(process.env.STAVKA_CLAUDE_ACCOUNT_B64).toBeUndefined();
    expect(process.env.STAVKA_CODEX_ACCOUNT_B64).toBeUndefined();
    expect(process.env.ANTHROPIC_API_KEY).toBeUndefined();
  });

  it("rejects an invalid auth checkpoint instead of starting with partial secrets", async () => {
    process.env.MASKIROVKA_AUTH_STATE_B64 = encodeBase64Url(
      JSON.stringify({
        version: 2,
        providers: {
          claude: {
            name: "broken",
            auth_kind: "claude-subscription",
            credential: { kind: "claude-subscription", oauthToken: "" },
            revision: 1,
          },
        },
        observed_at: 1,
      }),
    );

    await expect(Effect.runPromise(restoreGatewaySubscriptionAuth())).rejects.toThrow(
      /MASKIROVKA_AUTH_STATE_B64 is invalid/u,
    );
  });
});
