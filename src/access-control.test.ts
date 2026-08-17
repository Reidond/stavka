import { describe, expect, it, vi } from "vitest";
import { authorizeOwner, ownerObjectName, type OwnerAccessEnv } from "./access-control";

const ownerUuid = "57cf8cf2-f55a-4588-9ac9-f5e41e9f09b4";
const otherUuid = "7335d417-61da-459d-899c-0a01c76a2f94";
const accessAud = "7".repeat(64);
const env: OwnerAccessEnv = {
  WAR_BENCH_ACCESS_AUD: accessAud,
  WAR_BENCH_OWNER_USER_UUID: ownerUuid,
};

const accessFor = (userUuid: string, aud = accessAud): CloudflareAccessContext => ({
  aud,
  getIdentity: vi.fn(async () => ({ email: "owner@example.test", user_uuid: userUuid })),
});

describe("Cloudflare Access owner authorization", () => {
  it("routes the configured owner to a deterministic per-user object", async () => {
    await expect(authorizeOwner(accessFor(ownerUuid), env)).resolves.toEqual({
      authorized: true,
      objectName: ownerObjectName(ownerUuid),
      userUuid: ownerUuid,
    });
  });

  it("rejects a valid Access identity with the wrong user UUID", async () => {
    await expect(authorizeOwner(accessFor(otherUuid), env)).resolves.toEqual({
      authorized: false,
      reason: "wrong-owner",
      status: 403,
    });
  });

  it("rejects missing Access context and a token for another audience", async () => {
    await expect(authorizeOwner(undefined, env)).resolves.toMatchObject({
      authorized: false,
      reason: "missing-access",
      status: 403,
    });
    await expect(authorizeOwner(accessFor(ownerUuid, "8".repeat(64)), env)).resolves.toMatchObject({
      authorized: false,
      reason: "wrong-audience",
      status: 403,
    });
  });
});
