import { Data, Effect, Schema } from "effect";

const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const AUTH_BASE_URL = "https://auth.openai.com";
const DEVICE_USER_CODE_URL = `${AUTH_BASE_URL}/api/accounts/deviceauth/usercode`;
const DEVICE_TOKEN_URL = `${AUTH_BASE_URL}/api/accounts/deviceauth/token`;
const TOKEN_URL = `${AUTH_BASE_URL}/oauth/token`;
const DEVICE_VERIFICATION_URI = `${AUTH_BASE_URL}/codex/device`;
const DEVICE_REDIRECT_URI = `${AUTH_BASE_URL}/deviceauth/callback`;

export const DeviceAuthorization = Schema.Struct({
  device_auth_id: Schema.String,
  user_code: Schema.String,
  interval: Schema.Union([Schema.Number, Schema.String]),
});

export const DevicePoll = Schema.Struct({
  authorization_code: Schema.String,
  code_verifier: Schema.String,
});

export const TokenResponse = Schema.Struct({
  access_token: Schema.String,
  refresh_token: Schema.String,
  expires_in: Schema.Number,
});

export interface CodexCredentials {
  readonly access: string;
  readonly refresh: string;
  readonly expires: number;
  readonly accountId?: string;
}

export class CodexAuthError extends Data.TaggedError("CodexAuthError")<{
  readonly operation: string;
  readonly message: string;
  readonly status?: number;
}> {}

const decodeJwtAccountId = (token: string): string | undefined => {
  try {
    const payload = token.split(".")[1];
    if (!payload) return undefined;
    const normalized = payload.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(payload.length / 4) * 4, "=");
    const json = JSON.parse(atob(normalized)) as Record<string, unknown>;
    const auth = json["https://api.openai.com/auth"] as Record<string, unknown> | undefined;
    return typeof auth?.chatgpt_account_id === "string" ? auth.chatgpt_account_id : undefined;
  } catch {
    return undefined;
  }
};

export const startDeviceAuthorization = Effect.tryPromise({
  try: async () => {
    const response = await fetch(DEVICE_USER_CODE_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ client_id: CLIENT_ID }),
    });
    if (!response.ok) throw new CodexAuthError({ operation: "device.start", message: await response.text(), status: response.status });
    const decoded = Schema.decodeUnknownSync(DeviceAuthorization)(await response.json());
    return {
      deviceAuthId: decoded.device_auth_id,
      userCode: decoded.user_code,
      intervalSeconds: Number(decoded.interval),
      verificationUri: DEVICE_VERIFICATION_URI,
    };
  },
  catch: (cause) => cause instanceof CodexAuthError
    ? cause
    : new CodexAuthError({ operation: "device.start", message: cause instanceof Error ? cause.message : String(cause) }),
});

export const pollDeviceAuthorization = (deviceAuthId: string, userCode: string) =>
  Effect.tryPromise({
    try: async (): Promise<{ readonly pending: true } | { readonly pending: false; readonly credentials: CodexCredentials }> => {
      const response = await fetch(DEVICE_TOKEN_URL, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ device_auth_id: deviceAuthId, user_code: userCode }),
      });
      if (response.status === 403 || response.status === 404) return { pending: true };
      if (!response.ok) throw new CodexAuthError({ operation: "device.poll", message: await response.text(), status: response.status });
      const device = Schema.decodeUnknownSync(DevicePoll)(await response.json());
      const tokenResponse = await fetch(TOKEN_URL, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          client_id: CLIENT_ID,
          code: device.authorization_code,
          code_verifier: device.code_verifier,
          redirect_uri: DEVICE_REDIRECT_URI,
        }),
      });
      if (!tokenResponse.ok) throw new CodexAuthError({ operation: "token.exchange", message: await tokenResponse.text(), status: tokenResponse.status });
      const token = Schema.decodeUnknownSync(TokenResponse)(await tokenResponse.json());
      return {
        pending: false,
        credentials: {
          access: token.access_token,
          refresh: token.refresh_token,
          expires: Date.now() + token.expires_in * 1000,
          accountId: decodeJwtAccountId(token.access_token),
        },
      };
    },
    catch: (cause) => cause instanceof CodexAuthError
      ? cause
      : new CodexAuthError({ operation: "device.poll", message: cause instanceof Error ? cause.message : String(cause) }),
  });

export const refreshCodexCredentials = (refreshToken: string) =>
  Effect.tryPromise({
    try: async (): Promise<CodexCredentials> => {
      const response = await fetch(TOKEN_URL, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "refresh_token",
          refresh_token: refreshToken,
          client_id: CLIENT_ID,
        }),
      });
      if (!response.ok) throw new CodexAuthError({ operation: "token.refresh", message: await response.text(), status: response.status });
      const token = Schema.decodeUnknownSync(TokenResponse)(await response.json());
      return {
        access: token.access_token,
        refresh: token.refresh_token,
        expires: Date.now() + token.expires_in * 1000,
        accountId: decodeJwtAccountId(token.access_token),
      };
    },
    catch: (cause) => cause instanceof CodexAuthError
      ? cause
      : new CodexAuthError({ operation: "token.refresh", message: cause instanceof Error ? cause.message : String(cause) }),
  });
