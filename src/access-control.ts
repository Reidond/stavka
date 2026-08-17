import { createRemoteJWKSet, jwtVerify, type JWTPayload } from "jose";

export interface OwnerAccessEnv {
  readonly WAR_BENCH_ACCESS_AUD: string;
  readonly WAR_BENCH_ACCESS_TEAM_DOMAIN: string;
  readonly WAR_BENCH_OWNER_SUB: string;
}

export type OwnerAuthorization =
  | {
      readonly authorized: true;
      readonly objectName: string;
      readonly sub: string;
    }
  | {
      readonly authorized: false;
      readonly reason:
        | "misconfigured"
        | "missing-access"
        | "missing-token"
        | "wrong-audience"
        | "invalid-token"
        | "wrong-owner";
      readonly status: 403 | 503;
    };

type AccessJwtVerifier = (token: string, env: OwnerAccessEnv) => Promise<JWTPayload>;

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const audiencePattern = /^[0-9a-f]{64}$/i;
const remoteJwks = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

const issuerFor = (teamDomain: string): string | undefined => {
  try {
    const issuer = new URL(teamDomain);
    if (
      issuer.protocol !== "https:" ||
      !issuer.hostname.endsWith(".cloudflareaccess.com") ||
      issuer.pathname !== "/" ||
      issuer.search ||
      issuer.hash
    ) {
      return undefined;
    }
    return issuer.origin;
  } catch {
    return undefined;
  }
};

const hash = (value: string) => crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));

const securelyEqual = async (left: string, right: string): Promise<boolean> => {
  const [leftHash, rightHash] = await Promise.all([hash(left), hash(right)]);
  const leftBytes = new Uint8Array(leftHash);
  const rightBytes = new Uint8Array(rightHash);
  let difference = 0;
  for (let index = 0; index < leftBytes.length; index += 1) {
    difference |= leftBytes[index] ^ rightBytes[index];
  }
  return difference === 0;
};

const verifyAccessJwt: AccessJwtVerifier = async (token, env) => {
  const issuer = issuerFor(env.WAR_BENCH_ACCESS_TEAM_DOMAIN);
  if (!issuer) throw new Error("invalid Access issuer");
  let jwks = remoteJwks.get(issuer);
  if (!jwks) {
    jwks = createRemoteJWKSet(new URL(`${issuer}/cdn-cgi/access/certs`));
    remoteJwks.set(issuer, jwks);
  }
  const verified = await jwtVerify(token, jwks, {
    issuer,
    audience: env.WAR_BENCH_ACCESS_AUD,
  });
  return verified.payload;
};

export const ownerObjectName = (sub: string): string => `access-user:${sub}`;

export const authorizeOwner = async (
  request: Request,
  access: CloudflareAccessContext | undefined,
  env: OwnerAccessEnv,
  verifyJwt: AccessJwtVerifier = verifyAccessJwt,
): Promise<OwnerAuthorization> => {
  if (
    !audiencePattern.test(env.WAR_BENCH_ACCESS_AUD) ||
    !issuerFor(env.WAR_BENCH_ACCESS_TEAM_DOMAIN) ||
    !uuidPattern.test(env.WAR_BENCH_OWNER_SUB)
  ) {
    return { authorized: false, reason: "misconfigured", status: 503 };
  }
  if (!access) return { authorized: false, reason: "missing-access", status: 403 };
  if (access.aud !== env.WAR_BENCH_ACCESS_AUD) {
    return { authorized: false, reason: "wrong-audience", status: 403 };
  }

  const token = request.headers.get("cf-access-jwt-assertion");
  if (!token) return { authorized: false, reason: "missing-token", status: 403 };

  let payload: JWTPayload;
  try {
    payload = await verifyJwt(token, env);
  } catch {
    return { authorized: false, reason: "invalid-token", status: 403 };
  }
  if (payload.type !== "app" || typeof payload.sub !== "string" || !uuidPattern.test(payload.sub)) {
    return { authorized: false, reason: "invalid-token", status: 403 };
  }
  if (!(await securelyEqual(payload.sub, env.WAR_BENCH_OWNER_SUB))) {
    return { authorized: false, reason: "wrong-owner", status: 403 };
  }

  const objectName = ownerObjectName(payload.sub);
  return {
    authorized: true,
    objectName,
    sub: payload.sub,
  };
};
