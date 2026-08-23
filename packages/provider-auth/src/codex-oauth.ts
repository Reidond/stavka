import { Effect, Schema, Semaphore } from "effect";

import {
  CodexOAuthCredentialSchema,
  ProviderAuthError,
  type CodexOAuthCredential,
} from "./accounts";

export const CODEX_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
export const CODEX_AUTH_BASE_URL = "https://auth.openai.com";
const TOKEN_URL = `${CODEX_AUTH_BASE_URL}/oauth/token`;
const DEVICE_USER_CODE_URL = `${CODEX_AUTH_BASE_URL}/api/accounts/deviceauth/usercode`;
const DEVICE_TOKEN_URL = `${CODEX_AUTH_BASE_URL}/api/accounts/deviceauth/token`;
export const CODEX_DEVICE_VERIFICATION_URL = `${CODEX_AUTH_BASE_URL}/codex/device`;
const DEVICE_REDIRECT_URI = `${CODEX_AUTH_BASE_URL}/deviceauth/callback`;

const TokenResponseSchema = Schema.Struct({
  access_token: Schema.String,
  refresh_token: Schema.optional(Schema.String),
  expires_in: Schema.optional(Schema.Number),
  id_token: Schema.optional(Schema.String),
});

const DeviceAuthorizationSchema = Schema.Struct({
  device_auth_id: Schema.String,
  user_code: Schema.String,
  interval: Schema.Union([Schema.Number, Schema.String]),
});

const DevicePollSchema = Schema.Struct({
  authorization_code: Schema.String,
  code_verifier: Schema.String,
});

const decodeJwt = (token: string): Record<string, unknown> | undefined => {
  try {
    const payload = token.split(".")[1];
    if (!payload) return undefined;
    const normalized = payload
      .replace(/-/gu, "+")
      .replace(/_/gu, "/")
      .padEnd(Math.ceil(payload.length / 4) * 4, "=");
    return JSON.parse(atob(normalized)) as Record<string, unknown>;
  } catch {
    return undefined;
  }
};

const identityFrom = (idToken: string | undefined): string | undefined => {
  if (!idToken) return undefined;
  const payload = decodeJwt(idToken);
  return typeof payload?.email === "string" ? payload.email : undefined;
};

const authClaimsFrom = (token: string | undefined): Record<string, unknown> | undefined => {
  if (!token) return undefined;
  const payload = decodeJwt(token);
  const nested = payload?.["https://api.openai.com/auth"];
  return nested !== null && typeof nested === "object" && !Array.isArray(nested)
    ? (nested as Record<string, unknown>)
    : payload;
};

const stringClaim = (token: string | undefined, name: string): string | undefined => {
  const value = authClaimsFrom(token)?.[name];
  return typeof value === "string" ? value : undefined;
};

export const codexAccountIdFromAccessToken = (accessToken: string): string | undefined => {
  return stringClaim(accessToken, "chatgpt_account_id");
};

const expiresAtFrom = (token: typeof TokenResponseSchema.Type): number => {
  if (token.expires_in !== undefined) return Date.now() + token.expires_in * 1_000;
  const accessExpiry = decodeJwt(token.access_token)?.exp;
  if (typeof accessExpiry === "number" && Number.isFinite(accessExpiry))
    return accessExpiry * 1_000;
  const identityExpiry = token.id_token ? decodeJwt(token.id_token)?.exp : undefined;
  if (typeof identityExpiry === "number" && Number.isFinite(identityExpiry))
    return identityExpiry * 1_000;
  // The current Codex exchange omits expires_in. A conservative fallback forces
  // refresh well before a typical OAuth access token could be considered durable.
  return Date.now() + 60 * 60_000;
};

const credentialFromToken = (
  token: typeof TokenResponseSchema.Type,
  fallback?: CodexOAuthCredential,
): CodexOAuthCredential => {
  const accountId =
    codexAccountIdFromAccessToken(token.access_token) ??
    stringClaim(token.id_token, "chatgpt_account_id") ??
    fallback?.accountId;
  if (!accountId) {
    throw new ProviderAuthError({
      operation: "codex.token",
      message: "OpenAI access token did not contain a ChatGPT account id",
    });
  }
  const refreshToken = token.refresh_token ?? fallback?.refreshToken;
  if (!refreshToken) {
    throw new ProviderAuthError({
      operation: "codex.token",
      message: "OpenAI token response did not contain a refresh token",
    });
  }
  return Schema.decodeUnknownSync(CodexOAuthCredentialSchema)({
    kind: "codex-chatgpt-oauth",
    accessToken: token.access_token,
    refreshToken,
    expiresAt: expiresAtFrom(token),
    accountId,
    workspaceId:
      stringClaim(token.access_token, "chatgpt_workspace_id") ??
      stringClaim(token.id_token, "chatgpt_workspace_id") ??
      fallback?.workspaceId,
    identity: identityFrom(token.id_token) ?? fallback?.identity,
  });
};

const decodeResponse = <A>(
  response: Response,
  decode: (input: unknown) => A,
  operation: string,
): Effect.Effect<A, ProviderAuthError> =>
  Effect.tryPromise({
    try: async () => {
      if (!response.ok) {
        throw new ProviderAuthError({
          operation,
          message: `OpenAI authentication returned HTTP ${response.status}`,
          status: response.status,
        });
      }
      return decode(await response.json());
    },
    catch: (cause) =>
      cause instanceof ProviderAuthError
        ? cause
        : new ProviderAuthError({
            operation,
            message: cause instanceof Error ? cause.message : "Invalid authentication response",
          }),
  });

export const exchangeCodexAuthorizationCode = (
  code: string,
  codeVerifier: string,
  redirectUri: string,
  fetcher: typeof fetch = globalThis.fetch,
): Effect.Effect<CodexOAuthCredential, ProviderAuthError> =>
  Effect.tryPromise({
    try: () =>
      fetcher(TOKEN_URL, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          client_id: CODEX_CLIENT_ID,
          code,
          code_verifier: codeVerifier,
          redirect_uri: redirectUri,
        }),
      }),
    catch: (cause) =>
      new ProviderAuthError({
        operation: "codex.token.exchange",
        message: cause instanceof Error ? cause.message : "Token exchange failed",
      }),
  }).pipe(
    Effect.flatMap((response) =>
      decodeResponse(
        response,
        Schema.decodeUnknownSync(TokenResponseSchema),
        "codex.token.exchange",
      ),
    ),
    Effect.flatMap((token) =>
      Effect.try({
        try: () => credentialFromToken(token),
        catch: (cause) =>
          cause instanceof ProviderAuthError
            ? cause
            : new ProviderAuthError({ operation: "codex.token.exchange", message: String(cause) }),
      }),
    ),
  );

export const refreshCodexCredential = (
  credential: CodexOAuthCredential,
  fetcher: typeof fetch = globalThis.fetch,
): Effect.Effect<CodexOAuthCredential, ProviderAuthError> =>
  Effect.tryPromise({
    try: () =>
      fetcher(TOKEN_URL, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "refresh_token",
          refresh_token: credential.refreshToken,
          client_id: CODEX_CLIENT_ID,
        }),
      }),
    catch: (cause) =>
      new ProviderAuthError({
        operation: "codex.token.refresh",
        message: cause instanceof Error ? cause.message : "Token refresh failed",
      }),
  }).pipe(
    Effect.flatMap((response) =>
      decodeResponse(
        response,
        Schema.decodeUnknownSync(TokenResponseSchema),
        "codex.token.refresh",
      ),
    ),
    Effect.flatMap((token) =>
      Effect.try({
        try: () => credentialFromToken(token, credential),
        catch: (cause) =>
          cause instanceof ProviderAuthError
            ? cause
            : new ProviderAuthError({ operation: "codex.token.refresh", message: String(cause) }),
      }),
    ),
  );

export interface CodexDeviceAuthorization {
  readonly deviceAuthId: string;
  readonly userCode: string;
  readonly intervalSeconds: number;
  readonly verificationUrl: string;
}

export const startCodexDeviceAuthorization = (
  fetcher: typeof fetch = globalThis.fetch,
): Effect.Effect<CodexDeviceAuthorization, ProviderAuthError> =>
  Effect.tryPromise({
    try: () =>
      fetcher(DEVICE_USER_CODE_URL, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ client_id: CODEX_CLIENT_ID }),
      }),
    catch: (cause) =>
      new ProviderAuthError({
        operation: "codex.device.start",
        message: cause instanceof Error ? cause.message : "Device login failed",
      }),
  }).pipe(
    Effect.flatMap((response) =>
      decodeResponse(
        response,
        Schema.decodeUnknownSync(DeviceAuthorizationSchema),
        "codex.device.start",
      ),
    ),
    Effect.map((decoded) => ({
      deviceAuthId: decoded.device_auth_id,
      userCode: decoded.user_code,
      intervalSeconds: Math.max(1, Number(decoded.interval) || 5),
      verificationUrl: CODEX_DEVICE_VERIFICATION_URL,
    })),
  );

export const pollCodexDeviceAuthorization = (
  authorization: Pick<CodexDeviceAuthorization, "deviceAuthId" | "userCode">,
  fetcher: typeof fetch = globalThis.fetch,
): Effect.Effect<
  | { readonly pending: true }
  | { readonly pending: false; readonly credential: CodexOAuthCredential },
  ProviderAuthError
> =>
  Effect.tryPromise({
    try: () =>
      fetcher(DEVICE_TOKEN_URL, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          device_auth_id: authorization.deviceAuthId,
          user_code: authorization.userCode,
        }),
      }),
    catch: (cause) =>
      new ProviderAuthError({
        operation: "codex.device.poll",
        message: cause instanceof Error ? cause.message : "Device polling failed",
      }),
  }).pipe(
    Effect.flatMap(
      (
        response,
      ): Effect.Effect<
        | { readonly pending: true }
        | { readonly pending: false; readonly credential: CodexOAuthCredential },
        ProviderAuthError
      > => {
        if (response.status === 403 || response.status === 404) {
          return Effect.succeed<{ readonly pending: true }>({ pending: true });
        }
        return decodeResponse(
          response,
          Schema.decodeUnknownSync(DevicePollSchema),
          "codex.device.poll",
        ).pipe(
          Effect.flatMap((device) =>
            exchangeCodexAuthorizationCode(
              device.authorization_code,
              device.code_verifier,
              DEVICE_REDIRECT_URI,
              fetcher,
            ),
          ),
          Effect.map((credential) => ({ pending: false as const, credential })),
        );
      },
    ),
  );

/** Single-flight refresh: failed refreshes never overwrite the stored credential. */
export class CodexCredentialRefresher {
  private readonly locks = new Map<string, Semaphore.Semaphore>();

  constructor(
    private readonly load: (key: string) => Effect.Effect<CodexOAuthCredential, ProviderAuthError>,
    private readonly save: (
      key: string,
      credential: CodexOAuthCredential,
    ) => Effect.Effect<void, ProviderAuthError>,
    private readonly refresh: (
      credential: CodexOAuthCredential,
    ) => Effect.Effect<CodexOAuthCredential, ProviderAuthError> = refreshCodexCredential,
  ) {}

  fresh(
    key: string,
    minimumTtlMs = 300_000,
  ): Effect.Effect<CodexOAuthCredential, ProviderAuthError> {
    const current = this.load(key);
    return current.pipe(
      Effect.flatMap((credential) => {
        if (credential.expiresAt > Date.now() + minimumTtlMs) return Effect.succeed(credential);
        const lock = this.locks.get(key) ?? Semaphore.makeUnsafe(1);
        this.locks.set(key, lock);
        return lock.withPermit(
          Effect.suspend(() => this.load(key)).pipe(
            Effect.flatMap((latest) =>
              latest.expiresAt > Date.now() + minimumTtlMs
                ? Effect.succeed(latest)
                : this.refresh(latest).pipe(
                    Effect.flatMap((refreshed) =>
                      this.save(key, refreshed).pipe(Effect.as(refreshed)),
                    ),
                  ),
            ),
          ),
        );
      }),
    );
  }
}
