import { Context, Data, Effect, Layer } from "effect";
import {
  createRemoteJWKSet,
  jwtVerify,
  type JWTClaimVerificationOptions,
  type JWTPayload,
  type JWTVerifyGetKey,
} from "jose";

export type HumanRole = "owner" | "operator" | "spectator" | "automation";
export type AccessPermission = "read" | "operate" | "admin";

export interface AccessIdentity {
  readonly subject: string;
  readonly email?: string;
  readonly role: HumanRole;
  readonly serviceToken: boolean;
  readonly permissions?: readonly AccessPermission[];
  readonly claims: JWTPayload;
}

export interface AccessConfig {
  readonly environment: "local" | "preview" | "production";
  readonly teamDomain: string;
  readonly audience: string;
  readonly devEmail?: string;
  readonly automationPermissions?: readonly AccessPermission[];
}

export class AccessAuthError extends Data.TaggedError("AccessAuthError")<{
  readonly reason: "missing" | "invalid" | "misconfigured" | "forbidden";
  readonly message: string;
}> {}

export type AccessKeyResolver = JWTVerifyGetKey;

const normalizeTeamDomain = (value: string): string => value.replace(/\/$/, "");

const isLoopbackHttpRequest = (request: Request): boolean => {
  const url = new URL(request.url);
  return url.protocol === "http:" &&
    (url.hostname === "localhost" ||
      url.hostname === "127.0.0.1" ||
      url.hostname === "[::1]" ||
      url.hostname === "::1");
};

const remoteKeyResolvers = new Map<string, AccessKeyResolver>();

/** Reuse jose's remote-set cache across HTTP and WebSocket verification calls. */
export const remoteAccessKeys = (teamDomain: string): AccessKeyResolver => {
  const normalized = normalizeTeamDomain(teamDomain);
  const cached = remoteKeyResolvers.get(normalized);
  if (cached !== undefined) return cached;
  const resolver = createRemoteJWKSet(new URL(`${normalized}/cdn-cgi/access/certs`));
  remoteKeyResolvers.set(normalized, resolver);
  return resolver;
};

const identityFromPayload = (
  payload: JWTPayload,
  automationPermissions: readonly AccessPermission[] = ["read"],
): AccessIdentity => {
  const serviceToken =
    typeof payload.common_name === "string" && (payload.sub === undefined || payload.sub === "");
  const subject = serviceToken
    ? String(payload.common_name)
    : String(payload.sub ?? payload.email ?? "unknown");
  return {
    subject,
    ...(typeof payload.email === "string" ? { email: payload.email } : {}),
    role: serviceToken ? "automation" : "owner",
    serviceToken,
    ...(serviceToken ? { permissions: [...new Set(automationPermissions)] } : {}),
    claims: payload,
  };
};

export const verifyAccessRequest = (
  request: Request,
  config: AccessConfig,
  keys?: AccessKeyResolver,
): Effect.Effect<AccessIdentity, AccessAuthError> => {
  if (config.environment === "local") {
    if (!config.devEmail) {
      return Effect.fail(
        new AccessAuthError({
          reason: "misconfigured",
          message: "DEV_ACCESS_EMAIL is required in local mode",
        }),
      );
    }
    if (!isLoopbackHttpRequest(request)) {
      return Effect.fail(
        new AccessAuthError({
          reason: "forbidden",
          message: "Synthetic Access identity is restricted to loopback HTTP requests",
        }),
      );
    }
    return Effect.succeed({
      subject: `dev:${config.devEmail}`,
      email: config.devEmail,
      role: "owner",
      serviceToken: false,
      claims: { sub: `dev:${config.devEmail}`, email: config.devEmail },
    });
  }

  if (!config.teamDomain || !config.audience) {
    return Effect.fail(
      new AccessAuthError({
        reason: "misconfigured",
        message: "Access team domain and audience are required outside local mode",
      }),
    );
  }

  const token = request.headers.get("cf-access-jwt-assertion");
  if (!token) {
    return Effect.fail(
      new AccessAuthError({ reason: "missing", message: "Missing Cloudflare Access JWT" }),
    );
  }

  const options: JWTClaimVerificationOptions = {
    issuer: normalizeTeamDomain(config.teamDomain),
    audience: config.audience,
  };
  return Effect.tryPromise({
    try: () => jwtVerify(token, keys ?? remoteAccessKeys(config.teamDomain), options),
    catch: () =>
      new AccessAuthError({ reason: "invalid", message: "Invalid Cloudflare Access JWT" }),
  }).pipe(Effect.map(({ payload }) => identityFromPayload(payload, config.automationPermissions)));
};

export interface AccessAuthService {
  readonly verify: (request: Request) => Effect.Effect<AccessIdentity, AccessAuthError>;
}

export class AccessAuth extends Context.Service<AccessAuth, AccessAuthService>()(
  "@stavka/AccessAuth",
) {}

export const AccessAuthLive = (config: AccessConfig): Layer.Layer<AccessAuth> =>
  Layer.succeed(AccessAuth, {
    verify: (request) => verifyAccessRequest(request, config),
  });

const permissions: Record<HumanRole, ReadonlySet<string>> = {
  owner: new Set(["read", "operate", "admin"]),
  operator: new Set(["read", "operate"]),
  spectator: new Set(["read"]),
  automation: new Set(["read"]),
};

export const can = (identity: AccessIdentity, permission: string): boolean =>
  (identity.permissions ? new Set(identity.permissions) : permissions[identity.role]).has(
    permission,
  );
