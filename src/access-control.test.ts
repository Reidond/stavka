import type { JWTPayload } from "jose";
import { describe, expect, it, vi } from "vitest";
import { authorizeOwner, ownerObjectName, type OwnerAccessEnv } from "./access-control";

const ownerSub = "ae27d994-4919-5cb1-8d45-c3b776a64c48";
const otherSub = "7335d417-61da-459d-899c-0a01c76a2f94";
const accessAud = "7".repeat(64);
const env: OwnerAccessEnv = {
  WAR_BENCH_ACCESS_AUD: accessAud,
  WAR_BENCH_ACCESS_TEAM_DOMAIN: "https://team.cloudflareaccess.com",
  WAR_BENCH_OWNER_SUB: ownerSub,
};

const accessFor = (aud = accessAud): CloudflareAccessContext => ({
  aud,
  getIdentity: vi.fn(async () => ({ email: "owner@example.test" })),
});
const requestFor = (token = "signed-access-jwt") =>
  new Request("https://warbench.example", {
    headers: { "cf-access-jwt-assertion": token },
  });
const verifyAs = (payload: JWTPayload) => vi.fn(async () => payload);

describe("Cloudflare Access owner authorization", () => {
  it("routes the validated owner sub to a deterministic per-user object", async () => {
    const verifyJwt = verifyAs({ sub: ownerSub, type: "app" });

    await expect(authorizeOwner(requestFor(), accessFor(), env, verifyJwt)).resolves.toEqual({
      authorized: true,
      objectName: ownerObjectName(ownerSub),
      sub: ownerSub,
    });
    expect(verifyJwt).toHaveBeenCalledWith("signed-access-jwt", env);
  });

  it("rejects a validated Access JWT with the wrong sub", async () => {
    await expect(
      authorizeOwner(requestFor(), accessFor(), env, verifyAs({ sub: otherSub, type: "app" })),
    ).resolves.toEqual({
      authorized: false,
      reason: "wrong-owner",
      status: 403,
    });
  });

  it("rejects missing Access context, headers, and another audience", async () => {
    await expect(
      authorizeOwner(requestFor(), undefined, env, verifyAs({ sub: ownerSub, type: "app" })),
    ).resolves.toMatchObject({ reason: "missing-access", status: 403 });
    await expect(
      authorizeOwner(new Request("https://warbench.example"), accessFor(), env),
    ).resolves.toMatchObject({ reason: "missing-token", status: 403 });
    await expect(
      authorizeOwner(
        requestFor(),
        accessFor("8".repeat(64)),
        env,
        verifyAs({ sub: ownerSub, type: "app" }),
      ),
    ).resolves.toMatchObject({ reason: "wrong-audience", status: 403 });
  });

  it("rejects an invalid signature and non-application JWT", async () => {
    const invalidSignature = vi.fn(async (): Promise<JWTPayload> => {
      throw new Error("signature verification failed");
    });
    await expect(
      authorizeOwner(requestFor(), accessFor(), env, invalidSignature),
    ).resolves.toMatchObject({ reason: "invalid-token", status: 403 });
    await expect(
      authorizeOwner(requestFor(), accessFor(), env, verifyAs({ sub: ownerSub, type: "org" })),
    ).resolves.toMatchObject({ reason: "invalid-token", status: 403 });
  });
});
