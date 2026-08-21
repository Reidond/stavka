import { generateKeyPair, exportJWK, SignJWT, createLocalJWKSet } from "jose";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import {
  AccessAuth,
  AccessAuthLive,
  authorizeMachine,
  can,
  constantTimeEqual,
  remoteAccessKeys,
  verifyAccessRequest,
  type AccessConfig,
} from "../src";

describe("machine authentication", () => {
  it("accepts only the exact bearer token", async () => {
    const valid = new Request("https://example.test/api/tick", {
      headers: { authorization: "Bearer sk-stavka-secret" },
    });
    const wrong = new Request("https://example.test/api/tick", {
      headers: { authorization: "Bearer sk-stavka-wrong" },
    });
    expect(await Effect.runPromise(authorizeMachine(valid, "sk-stavka-secret"))).toBe(true);
    expect(await Effect.runPromise(authorizeMachine(wrong, "sk-stavka-secret"))).toBe(false);
    expect(await Effect.runPromise(constantTimeEqual("short", "a-much-longer-secret"))).toBe(false);
  });
});

describe("Cloudflare Access", () => {
  it("reuses the remote JWKS resolver for the same normalized team domain", () => {
    expect(remoteAccessKeys("https://team.cloudflareaccess.com")).toBe(
      remoteAccessKeys("https://team.cloudflareaccess.com/"),
    );
  });

  it("creates a synthetic identity only in local mode", async () => {
    const identity = await Effect.runPromise(
      verifyAccessRequest(new Request("http://localhost"), {
        environment: "local",
        teamDomain: "",
        audience: "",
        devEmail: "developer@localhost",
      }),
    );
    expect(identity.role).toBe("owner");
  });

  it.each([
    "http://localhost:8787/admin",
    "http://127.0.0.1:8787/admin",
    "http://[::1]:8787/admin",
  ])("accepts synthetic identity on loopback HTTP at %s", async (url) => {
    await expect(
      Effect.runPromise(
        verifyAccessRequest(new Request(url), {
          environment: "local",
          teamDomain: "",
          audience: "",
          devEmail: "developer@localhost",
        }),
      ),
    ).resolves.toMatchObject({ role: "owner", email: "developer@localhost" });
  });

  it.each([
    "https://localhost:8787/admin",
    "http://commander.example.test/admin",
    "https://commander.example.test/admin",
  ])("refuses synthetic identity outside loopback HTTP at %s", async (url) => {
    await expect(
      Effect.runPromise(
        verifyAccessRequest(new Request(url), {
          environment: "local",
          teamDomain: "",
          audience: "",
          devEmail: "developer@localhost",
        }),
      ),
    ).rejects.toMatchObject({ reason: "forbidden" });
  });

  it("provides request verification through the AccessAuth layer", async () => {
    const identity = await Effect.runPromise(
      Effect.gen(function* () {
        const auth = yield* AccessAuth;
        return yield* auth.verify(new Request("http://localhost"));
      }).pipe(
        Effect.provide(
          AccessAuthLive({
            environment: "local",
            teamDomain: "",
            audience: "",
            devEmail: "layer@localhost",
          }),
        ),
      ),
    );
    expect(identity.email).toBe("layer@localhost");
  });

  it("verifies issuer, audience, signature, and service-token role", async () => {
    const { privateKey, publicKey } = await generateKeyPair("RS256");
    const publicJwk = await exportJWK(publicKey);
    publicJwk.kid = "access-test";
    const keys = createLocalJWKSet({ keys: [publicJwk] });
    const token = await new SignJWT({ common_name: "ci-service", sub: "" })
      .setProtectedHeader({ alg: "RS256", kid: "access-test" })
      .setIssuer("https://team.cloudflareaccess.com")
      .setAudience("aud-poligon")
      .setIssuedAt()
      .setExpirationTime("5m")
      .sign(privateKey);
    const request = new Request("https://poligon.example.test", {
      headers: { "cf-access-jwt-assertion": token },
    });
    const identity = await Effect.runPromise(
      verifyAccessRequest(
        request,
        {
          environment: "production",
          teamDomain: "https://team.cloudflareaccess.com",
          audience: "aud-poligon",
        },
        keys,
      ),
    );
    expect(identity.role).toBe("automation");
    expect(can(identity, "read")).toBe(true);
    expect(can(identity, "admin")).toBe(false);
  });

  it("grants service-token mutations only when the surface opts in", async () => {
    const { privateKey, publicKey } = await generateKeyPair("RS256");
    const publicJwk = await exportJWK(publicKey);
    publicJwk.kid = "automation-admin";
    const keys = createLocalJWKSet({ keys: [publicJwk] });
    const token = await new SignJWT({ common_name: "commander-automation", sub: "" })
      .setProtectedHeader({ alg: "RS256", kid: "automation-admin" })
      .setIssuer("https://team.cloudflareaccess.com")
      .setAudience("aud-commander")
      .setIssuedAt()
      .setExpirationTime("5m")
      .sign(privateKey);
    const identity = await Effect.runPromise(
      verifyAccessRequest(
        new Request("https://commander.example.test/admin", {
          headers: { "cf-access-jwt-assertion": token },
        }),
        {
          environment: "production",
          teamDomain: "https://team.cloudflareaccess.com",
          audience: "aud-commander",
          automationPermissions: ["read", "admin"],
        },
        keys,
      ),
    );
    expect(can(identity, "admin")).toBe(true);
    expect(can(identity, "operate")).toBe(false);
  });

  it("defaults a verified human to spectator with read-only permissions", async () => {
    const { privateKey, publicKey } = await generateKeyPair("RS256");
    const publicJwk = await exportJWK(publicKey);
    publicJwk.kid = "human-default";
    const keys = createLocalJWKSet({ keys: [publicJwk] });
    const sign = (sub: string, email?: string) =>
      new SignJWT(email === undefined ? { sub } : { sub, email })
        .setProtectedHeader({ alg: "RS256", kid: "human-default" })
        .setIssuer("https://team.cloudflareaccess.com")
        .setAudience("aud-stavka")
        .setIssuedAt()
        .setExpirationTime("5m")
        .sign(privateKey);

    const identityFor = async (
      config: AccessConfig,
      claims: { readonly sub: string; readonly email?: string },
    ) =>
      Effect.runPromise(
        verifyAccessRequest(
          new Request("https://stavka.example.test", {
            headers: {
              "cf-access-jwt-assertion": await sign(claims.sub, claims.email),
            },
          }),
          config,
          keys,
        ),
      );

    const base: AccessConfig = {
      environment: "production",
      teamDomain: "https://team.cloudflareaccess.com",
      audience: "aud-stavka",
    };
    const ownerSub = "ae27d994-4919-5cb1-8d45-c3b776a64c48";

    const unlisted = await identityFor(base, {
      sub: ownerSub,
      email: "nobody@example.test",
    });
    expect(unlisted.role).toBe("spectator");
    expect(can(unlisted, "read")).toBe(true);
    expect(can(unlisted, "operate")).toBe(false);
    expect(can(unlisted, "admin")).toBe(false);

    const operator = await identityFor(
      { ...base, operatorSubjects: ["operator@example.test"] },
      { sub: "7335d417-61da-459d-899c-0a01c76a2f94", email: "operator@example.test" },
    );
    expect(operator.role).toBe("operator");
    expect(can(operator, "operate")).toBe(true);
    expect(can(operator, "admin")).toBe(false);

    // Owner matching works by Access subject...
    const ownerBySub = await identityFor(
      {
        ...base,
        operatorSubjects: ["operator@example.test"],
        ownerSubjects: [ownerSub],
      },
      { sub: ownerSub, email: "owner@example.test" },
    );
    expect(ownerBySub.role).toBe("owner");
    expect(can(ownerBySub, "admin")).toBe(true);

    // ...and by verified email.
    const ownerByEmail = await identityFor(
      { ...base, ownerSubjects: ["owner@example.test"] },
      { sub: ownerSub, email: "owner@example.test" },
    );
    expect(ownerByEmail.role).toBe("owner");

    // A listed operator does not escalate to owner implicitly.
    const operatorNotOwner = await identityFor(
      { ...base, operatorSubjects: ["operator@example.test"] },
      { sub: ownerSub, email: "owner@example.test" },
    );
    expect(operatorNotOwner.role).toBe("spectator");
  });
});
