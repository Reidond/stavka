#!/usr/bin/env node
import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { LocalProfileStore, loginCodexWithBrowser } from "@stavka/provider-auth/node";
import {
  CODEX_DEVICE_VERIFICATION_URL,
  ClaudeOAuthTokenSchema,
  ProviderAccountNameSchema,
  ProviderAuthError,
  pollCodexDeviceAuthorization,
  publicProviderAccount,
  refreshCodexCredential,
  startCodexDeviceAuthorization,
  type CloudflareAccessProfile,
  type ProviderAccount,
  type ProviderId,
} from "@stavka/provider-auth";
import { Duration, Effect, Schema } from "effect";

const usage = `Stavka provider accounts

  stavka codex login <name> [--device] [--label <label>]
  claude setup-token | stavka claude login <name> --token-stdin [--label <label>]
  stavka cloudflare login <name> --url <Access URL> [--label <label>]
  stavka cloudflare service-token <name> --url <Access URL> --client-id <id> --client-secret-stdin
  stavka accounts
  stavka use <codex|claude|cloudflare> <name>
  stavka auth push --account <provider/name> [--cloudflare <profile>] [--as <name>]
  stavka auth list [--cloudflare <profile>]
  stavka auth activate --account <provider/name> [--cloudflare <profile>]
  stavka auth test --account <provider/name> [--cloudflare <profile>]
  stavka auth delete --account <provider/name> [--cloudflare <profile>]

Secrets are read from OAuth callbacks, cloudflared, or stdin; never pass them as arguments.`;

const store = new LocalProfileStore(process.env.STAVKA_HOME ?? join(homedir(), ".stavka"));

const argument = (args: readonly string[], name: string): string | undefined => {
  const index = args.indexOf(name);
  return index < 0 ? undefined : args[index + 1];
};

const required = (value: string | undefined, message: string): Effect.Effect<string, Error> =>
  value ? Effect.succeed(value) : Effect.fail(new Error(message));

const accountName = (value: string): Effect.Effect<string, Error> =>
  Schema.decodeUnknownEffect(ProviderAccountNameSchema)(value).pipe(
    Effect.mapError(() => new Error(`Invalid account name ${JSON.stringify(value)}`)),
  );

const parseCloudflareAccessUrl = (value: string): URL => {
  const url = new URL(value);
  if (url.protocol !== "https:") throw new Error("Cloudflare Access profiles require HTTPS");
  return url;
};

const cloudflareAccessUrl = (value: string): Effect.Effect<string, Error> =>
  Effect.try({
    try: () => parseCloudflareAccessUrl(value).toString(),
    catch: (cause) =>
      cause instanceof Error ? cause : new Error("Cloudflare Access profile URL is invalid"),
  });

const accountReference = (
  value: string,
): Effect.Effect<{ readonly provider: ProviderId; readonly name: string }, Error> =>
  Effect.gen(function* () {
    const [provider, rawName, ...extra] = value.split("/");
    if ((provider !== "codex" && provider !== "claude") || !rawName || extra.length > 0) {
      return yield* Effect.fail(new Error("Account must be codex/<name> or claude/<name>"));
    }
    return { provider, name: yield* accountName(rawName) };
  });

const readSecretFromStdin = (maximum = 16_000): Effect.Effect<string, Error> =>
  Effect.tryPromise({
    try: async () => {
      if (process.stdin.isTTY) throw new Error("Secret input requires a pipe or redirected stdin");
      const chunks: Buffer[] = [];
      let length = 0;
      for await (const chunk of process.stdin) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
        length += buffer.length;
        if (length > maximum) throw new Error("Secret input is too large");
        chunks.push(buffer);
      }
      const secret = Buffer.concat(chunks).toString("utf8").trim();
      if (!secret) throw new Error("Secret input was empty");
      return secret;
    },
    catch: (cause) => (cause instanceof Error ? cause : new Error("Unable to read secret input")),
  });

const writeLine = (value: string): Effect.Effect<void> =>
  Effect.sync(() => process.stdout.write(`${value}\n`));

const saveAccount = (
  provider: ProviderId,
  name: string,
  label: string,
  credential: ProviderAccount["credential"],
): Effect.Effect<void, ProviderAuthError> => {
  const now = new Date().toISOString();
  const authKind =
    credential.kind === "codex-chatgpt-oauth"
      ? "chatgpt-oauth"
      : credential.kind === "claude-subscription"
        ? "claude-subscription"
        : "anthropic-api-key";
  return store.putProviderAccount(
    {
      provider,
      name,
      label,
      authKind,
      credential,
      ...(credential.kind === "codex-chatgpt-oauth"
        ? {
            remoteAccountId: credential.accountId,
            ...(credential.workspaceId ? { remoteWorkspaceId: credential.workspaceId } : {}),
          }
        : credential.kind === "claude-subscription"
          ? {
              ...(credential.remoteAccountId
                ? { remoteAccountId: credential.remoteAccountId }
                : {}),
              ...(credential.remoteWorkspaceId
                ? { remoteWorkspaceId: credential.remoteWorkspaceId }
                : {}),
            }
          : {}),
      createdAt: now,
      updatedAt: now,
    },
    true,
  );
};

const codexLogin = (args: readonly string[]): Effect.Effect<void, Error | ProviderAuthError> =>
  Effect.gen(function* () {
    const name = yield* required(args[0], "Codex account name is required").pipe(
      Effect.flatMap(accountName),
    );
    const label = argument(args, "--label") ?? name;
    const credential = args.includes("--device")
      ? yield* Effect.gen(function* () {
          const authorization = yield* startCodexDeviceAuthorization();
          yield* writeLine(
            `Open ${CODEX_DEVICE_VERIFICATION_URL} and enter code ${authorization.userCode}`,
          );
          const deadline = Date.now() + 15 * 60_000;
          while (Date.now() < deadline) {
            yield* Effect.sleep(Duration.seconds(authorization.intervalSeconds));
            const result = yield* pollCodexDeviceAuthorization(authorization);
            if (!result.pending) return result.credential;
          }
          return yield* Effect.fail(new Error("Codex device login timed out"));
        })
      : (yield* loginCodexWithBrowser()).credential;
    yield* saveAccount("codex", name, label, credential);
    yield* writeLine(
      `Saved and activated codex/${name} (${credential.identity ?? "ChatGPT account"}).`,
    );
  });

const claudeLogin = (args: readonly string[]): Effect.Effect<void, Error | ProviderAuthError> =>
  Effect.gen(function* () {
    const name = yield* required(args[0], "Claude account name is required").pipe(
      Effect.flatMap(accountName),
    );
    if (!args.includes("--token-stdin") && !args.includes("--api-key-stdin")) {
      return yield* Effect.fail(new Error("Use --token-stdin or --api-key-stdin"));
    }
    const value = yield* readSecretFromStdin();
    if (args.includes("--token-stdin") && !Schema.is(ClaudeOAuthTokenSchema)(value)) {
      return yield* Effect.fail(
        new Error("Expected only the Claude setup-token value, not terminal output."),
      );
    }
    const credential = args.includes("--api-key-stdin")
      ? ({ kind: "api-key", apiKey: value } as const)
      : ({ kind: "claude-subscription", oauthToken: value } as const);
    yield* saveAccount("claude", name, argument(args, "--label") ?? name, credential);
    yield* writeLine(`Saved and activated claude/${name}.`);
  });

const cloudflareLogin = (args: readonly string[]): Effect.Effect<void, Error | ProviderAuthError> =>
  Effect.gen(function* () {
    const name = yield* required(args[0], "Cloudflare profile name is required").pipe(
      Effect.flatMap(accountName),
    );
    const url = yield* required(argument(args, "--url"), "--url is required").pipe(
      Effect.flatMap(cloudflareAccessUrl),
    );
    const run = promisify(execFile);
    yield* Effect.tryPromise({
      try: () => run("cloudflared", ["access", "login", url]),
      catch: (cause) =>
        new Error(cause instanceof Error ? cause.message : "cloudflared login failed"),
    });
    const token = yield* Effect.tryPromise({
      try: async () => (await run("cloudflared", ["access", "token", "-app", url])).stdout.trim(),
      catch: (cause) =>
        new Error(cause instanceof Error ? cause.message : "cloudflared token failed"),
    });
    if (!token) return yield* Effect.fail(new Error("cloudflared returned an empty Access token"));
    const now = new Date().toISOString();
    yield* store.putCloudflareProfile({
      name,
      label: argument(args, "--label") ?? name,
      url,
      auth: { kind: "access-token", token },
      createdAt: now,
      updatedAt: now,
    });
    yield* writeLine(`Saved and activated cloudflare/${name}.`);
  });

const saveCloudflareProfile = (
  args: readonly string[],
  auth: CloudflareAccessProfile["auth"],
): Effect.Effect<void, Error | ProviderAuthError> =>
  Effect.gen(function* () {
    const name = yield* required(args[0], "Cloudflare profile name is required").pipe(
      Effect.flatMap(accountName),
    );
    const rawUrl = yield* required(argument(args, "--url"), "--url is required");
    const url = yield* cloudflareAccessUrl(rawUrl);
    const now = new Date().toISOString();
    yield* store.putCloudflareProfile({
      name,
      label: argument(args, "--label") ?? name,
      url,
      auth,
      createdAt: now,
      updatedAt: now,
    });
    yield* writeLine(`Saved and activated cloudflare/${name}.`);
  });

const cloudflareServiceToken = (
  args: readonly string[],
): Effect.Effect<void, Error | ProviderAuthError> =>
  Effect.gen(function* () {
    const clientId = yield* required(argument(args, "--client-id"), "--client-id is required");
    if (!args.includes("--client-secret-stdin")) {
      return yield* Effect.fail(new Error("Use --client-secret-stdin"));
    }
    yield* saveCloudflareProfile(args, {
      kind: "service-token",
      clientId,
      clientSecret: yield* readSecretFromStdin(),
    });
  });

const accessHeaders = (profile: CloudflareAccessProfile): Headers => {
  const headers = new Headers({ "content-type": "application/json" });
  if (profile.auth.kind === "access-token") headers.set("cf-access-token", profile.auth.token);
  else if (profile.auth.kind === "service-token") {
    headers.set("CF-Access-Client-Id", profile.auth.clientId);
    headers.set("CF-Access-Client-Secret", profile.auth.clientSecret);
  }
  return headers;
};

const remoteRequest = <A>(
  profile: CloudflareAccessProfile,
  path: string,
  init: RequestInit = {},
): Effect.Effect<A, Error> =>
  Effect.tryPromise({
    try: async () => {
      if (profile.auth.kind === "local")
        throw new Error(
          "Local profiles are no longer supported. Use cloudflare login with https://stavka.sands.red.",
        );
      const baseUrl = parseCloudflareAccessUrl(profile.url);
      const headers = accessHeaders(profile);
      new Headers(init.headers).forEach((value, key) => headers.set(key, value));
      const response = await fetch(new URL(path, `${baseUrl.toString().replace(/\/$/u, "")}/`), {
        ...init,
        headers,
      });
      const body: unknown = await response.json().catch(() => undefined);
      if (!response.ok) {
        const message =
          body && typeof body === "object" && "error" in body
            ? JSON.stringify((body as { readonly error: unknown }).error)
            : `HTTP ${response.status}`;
        throw new Error(message);
      }
      return body as A;
    },
    catch: (cause) => (cause instanceof Error ? cause : new Error("Remote request failed")),
  });

const freshLocalAccount = (
  provider: ProviderId,
  name: string,
): Effect.Effect<ProviderAccount, Error | ProviderAuthError> =>
  Effect.gen(function* () {
    const account = yield* store.providerAccount(provider, name);
    if (
      account.credential.kind !== "codex-chatgpt-oauth" ||
      account.credential.expiresAt > Date.now() + 300_000
    )
      return account;
    const credential = yield* refreshCodexCredential(account.credential);
    const refreshed = { ...account, credential, updatedAt: new Date().toISOString() };
    yield* store.putProviderAccount(refreshed, false);
    return refreshed;
  });

const authCommand = (command: string | undefined, args: readonly string[]) =>
  Effect.gen(function* () {
    const profile = yield* store.cloudflareProfile(argument(args, "--cloudflare"));
    if (command === "list") {
      const response = yield* remoteRequest<{ readonly accounts: readonly unknown[] }>(
        profile,
        "/admin/provider-accounts",
      );
      yield* writeLine(JSON.stringify(response, null, 2));
      return;
    }
    const reference = yield* required(argument(args, "--account"), "--account is required").pipe(
      Effect.flatMap(accountReference),
    );
    const remoteName = yield* accountName(argument(args, "--as") ?? reference.name);
    const path = `/admin/provider-accounts/${reference.provider}/${remoteName}`;
    if (command === "push") {
      const account = yield* freshLocalAccount(reference.provider, reference.name);
      const response = yield* remoteRequest<unknown>(profile, path, {
        method: "PUT",
        body: JSON.stringify({
          label: account.label,
          authKind: account.authKind,
          credential: account.credential,
          ...(account.remoteAccountId ? { remoteAccountId: account.remoteAccountId } : {}),
          ...(account.remoteWorkspaceId ? { remoteWorkspaceId: account.remoteWorkspaceId } : {}),
          activate: !args.includes("--no-activate"),
        }),
      });
      yield* writeLine(JSON.stringify(response, null, 2));
      return;
    }
    if (command === "test") {
      yield* writeLine(
        JSON.stringify(yield* remoteRequest(profile, `${path}/test`, { method: "POST" }), null, 2),
      );
      return;
    }
    if (command === "activate") {
      yield* writeLine(
        JSON.stringify(
          yield* remoteRequest(profile, `${path}/activate`, { method: "POST" }),
          null,
          2,
        ),
      );
      return;
    }
    if (command === "delete") {
      yield* writeLine(
        JSON.stringify(yield* remoteRequest(profile, path, { method: "DELETE" }), null, 2),
      );
      return;
    }
    return yield* Effect.fail(
      new Error("auth command must be push, list, activate, test, or delete"),
    );
  });

const accounts = (): Effect.Effect<void, ProviderAuthError> =>
  store.read().pipe(
    Effect.flatMap((profiles) =>
      writeLine(
        JSON.stringify(
          {
            active: profiles.active,
            providerAccounts: profiles.providerAccounts.map(publicProviderAccount),
            cloudflareProfiles: profiles.cloudflareProfiles.map(({ auth: _auth, ...profile }) => ({
              ...profile,
              authKind: authKind(_auth),
            })),
          },
          null,
          2,
        ),
      ),
    ),
  );

const authKind = (auth: CloudflareAccessProfile["auth"]): string => auth.kind;

const useAccount = (args: readonly string[]): Effect.Effect<void, Error | ProviderAuthError> =>
  Effect.gen(function* () {
    const kind = yield* required(args[0], "use requires codex, claude, or cloudflare");
    const name = yield* required(args[1], "use requires an account name").pipe(
      Effect.flatMap(accountName),
    );
    if (kind === "cloudflare") yield* store.useCloudflareProfile(name);
    else if (kind === "codex" || kind === "claude") yield* store.useProviderAccount(kind, name);
    else return yield* Effect.fail(new Error("use requires codex, claude, or cloudflare"));
    yield* writeLine(`Activated ${kind}/${name}.`);
  });

export const runCli = (args: readonly string[]): Effect.Effect<void, Error | ProviderAuthError> => {
  const normalized = args[0] === "--" ? args.slice(1) : args;
  const [group, command, ...rest] = normalized;
  if (!group || group === "help" || group === "--help" || group === "-h") return writeLine(usage);
  if (group === "codex" && command === "login") return codexLogin(rest);
  if (group === "claude" && command === "login") return claudeLogin(rest);
  if (group === "cloudflare" && command === "login") return cloudflareLogin(rest);
  if (group === "cloudflare" && command === "service-token") return cloudflareServiceToken(rest);
  if (group === "accounts") return accounts();
  if (group === "use") return useAccount([command ?? "", ...rest]);
  if (group === "auth") return authCommand(command, rest);
  return Effect.fail(new Error(`Unknown command\n\n${usage}`));
};
