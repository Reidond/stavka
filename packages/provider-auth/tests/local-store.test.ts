import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { afterEach, describe, expect, it } from "vitest";

import { LocalProfileStore } from "../src/local-store";
import {
  CodexCredentialRefresher,
  exchangeCodexAuthorizationCode,
  refreshCodexCredential,
} from "../src/codex-oauth";
import { ProviderAuthError, type CodexOAuthCredential } from "../src/accounts";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })),
  );
});

describe("LocalProfileStore", () => {
  it("atomically stores named accounts with private filesystem permissions", async () => {
    const directory = await mkdtemp(join(tmpdir(), "stavka-provider-auth-"));
    temporaryDirectories.push(directory);
    const store = new LocalProfileStore(directory);
    const now = new Date().toISOString();

    await Effect.runPromise(
      store.putProviderAccount({
        provider: "codex",
        name: "work",
        label: "Work ChatGPT",
        authKind: "chatgpt-oauth",
        credential: {
          kind: "codex-chatgpt-oauth",
          accessToken: "access-secret",
          refreshToken: "refresh-secret",
          expiresAt: Date.now() + 60_000,
          accountId: "account-1",
        },
        createdAt: now,
        updatedAt: now,
      }),
    );

    const profiles = await Effect.runPromise(store.read());
    expect(profiles.active.codex).toBe("codex/work");
    expect(profiles.providerAccounts).toHaveLength(1);
    expect((await stat(directory)).mode & 0o777).toBe(0o700);
    expect((await stat(store.file)).mode & 0o777).toBe(0o600);
    expect(await readFile(store.file, "utf8")).toContain("refresh-secret");
  });

  it("refreshes each named account once and never saves a failed refresh", async () => {
    const expired: CodexOAuthCredential = {
      kind: "codex-chatgpt-oauth" as const,
      accessToken: "expired",
      refreshToken: "refresh",
      expiresAt: 0,
      accountId: "account-1",
    };
    let stored = expired;
    let refreshes = 0;
    let saves = 0;
    const refresher = new CodexCredentialRefresher(
      () => Effect.succeed(stored),
      (_key, credential) =>
        Effect.sync(() => {
          stored = credential;
          saves += 1;
        }),
      () =>
        Effect.promise(async () => {
          refreshes += 1;
          await new Promise((resolve) => setTimeout(resolve, 5));
          return { ...expired, accessToken: "fresh", expiresAt: Date.now() + 60 * 60_000 };
        }),
    );

    const values = await Effect.runPromise(
      Effect.all([refresher.fresh("codex/work"), refresher.fresh("codex/work")], {
        concurrency: "unbounded",
      }),
    );
    expect(values.map((value) => value.accessToken)).toEqual(["fresh", "fresh"]);
    expect(refreshes).toBe(1);
    expect(saves).toBe(1);

    stored = expired;
    const failing = new CodexCredentialRefresher(
      () => Effect.succeed(stored),
      () =>
        Effect.sync(() => {
          saves += 1;
        }),
      () =>
        Effect.fail(
          new ProviderAuthError({
            operation: "test",
            message: "refresh failed",
          }),
        ),
    );
    await expect(Effect.runPromise(failing.fresh("codex/work"))).rejects.toMatchObject({
      message: "refresh failed",
    });
    expect(saves).toBe(1);
  });

  it("retains the existing refresh token when OpenAI rotates only the access token", async () => {
    const payload = Buffer.from(
      JSON.stringify({
        "https://api.openai.com/auth": { chatgpt_account_id: "account-1" },
      }),
      "utf8",
    ).toString("base64url");
    const accessToken = `header.${payload}.signature`;
    const credential: CodexOAuthCredential = {
      kind: "codex-chatgpt-oauth",
      accessToken: "expired",
      refreshToken: "keep-this-refresh-token",
      expiresAt: 0,
      accountId: "account-1",
      identity: "operator@example.test",
    };
    const fetcher = async () =>
      new Response(JSON.stringify({ access_token: accessToken, expires_in: 3600 }), {
        headers: { "content-type": "application/json" },
      });

    await expect(
      Effect.runPromise(refreshCodexCredential(credential, fetcher as typeof fetch)),
    ).resolves.toMatchObject({
      accessToken,
      refreshToken: "keep-this-refresh-token",
      accountId: "account-1",
      identity: "operator@example.test",
    });
  });

  it("accepts the current Codex exchange shape without expires_in", async () => {
    const expiry = Math.floor(Date.now() / 1_000) + 3_600;
    const idPayload = Buffer.from(
      JSON.stringify({
        email: "operator@example.test",
        exp: expiry,
        "https://api.openai.com/auth": {
          chatgpt_account_id: "account-from-id-token",
          chatgpt_workspace_id: "workspace-from-id-token",
        },
      }),
      "utf8",
    ).toString("base64url");
    const accessPayload = Buffer.from(JSON.stringify({ exp: expiry }), "utf8").toString(
      "base64url",
    );
    const fetcher = async () =>
      new Response(
        JSON.stringify({
          id_token: `header.${idPayload}.signature`,
          access_token: `header.${accessPayload}.signature`,
          refresh_token: "refresh-token",
        }),
        { headers: { "content-type": "application/json" } },
      );

    await expect(
      Effect.runPromise(
        exchangeCodexAuthorizationCode("code", "verifier", "http://localhost/callback", fetcher),
      ),
    ).resolves.toMatchObject({
      accountId: "account-from-id-token",
      workspaceId: "workspace-from-id-token",
      identity: "operator@example.test",
      expiresAt: expiry * 1_000,
    });
  });

  it("refuses to activate an unknown account", async () => {
    const directory = await mkdtemp(join(tmpdir(), "stavka-provider-auth-"));
    temporaryDirectories.push(directory);
    const store = new LocalProfileStore(directory);

    await expect(
      Effect.runPromise(store.useProviderAccount("claude", "missing")),
    ).rejects.toMatchObject({
      operation: "profiles.use",
    });
  });
});
