export interface OwnerAccessEnv {
  readonly WAR_BENCH_ACCESS_AUD: string;
  readonly WAR_BENCH_OWNER_USER_UUID: string;
}

export type OwnerAuthorization =
  | {
      readonly authorized: true;
      readonly objectName: string;
      readonly userUuid: string;
    }
  | {
      readonly authorized: false;
      readonly reason: "misconfigured" | "missing-access" | "wrong-audience" | "wrong-owner";
      readonly status: 403 | 503;
    };

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const audiencePattern = /^[0-9a-f]{64}$/i;

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

export const ownerObjectName = (userUuid: string): string => `access-user:${userUuid}`;

export const authorizeOwner = async (
  access: CloudflareAccessContext | undefined,
  env: OwnerAccessEnv,
): Promise<OwnerAuthorization> => {
  if (
    !audiencePattern.test(env.WAR_BENCH_ACCESS_AUD) ||
    !uuidPattern.test(env.WAR_BENCH_OWNER_USER_UUID)
  ) {
    return { authorized: false, reason: "misconfigured", status: 503 };
  }
  if (!access) return { authorized: false, reason: "missing-access", status: 403 };
  if (access.aud !== env.WAR_BENCH_ACCESS_AUD) {
    return { authorized: false, reason: "wrong-audience", status: 403 };
  }

  const identity = await access.getIdentity();
  const userUuid = identity?.user_uuid;
  if (
    typeof userUuid !== "string" ||
    !uuidPattern.test(userUuid) ||
    !(await securelyEqual(userUuid, env.WAR_BENCH_OWNER_USER_UUID))
  ) {
    return { authorized: false, reason: "wrong-owner", status: 403 };
  }

  return { authorized: true, objectName: ownerObjectName(userUuid), userUuid };
};
