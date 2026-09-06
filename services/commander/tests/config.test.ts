import { describe, expect, it } from "vitest";
import { can, verifyAccessRequest } from "@stavka/access-auth";
import { Effect } from "effect";

import { accessConfig, readConfig, type Env } from "../src/config";

const env = (environment?: string): Env => ({
  ORCHESTRATOR: {} as Env["ORCHESTRATOR"],
  TERRAIN_CACHE: {} as Env["TERRAIN_CACHE"],
  API_KEY: "machine-secret",
  DEV_ACCESS_EMAIL: "operator@example.test",
  ...(environment === undefined ? {} : { ENVIRONMENT: environment }),
});

describe("Commander Access posture", () => {
  it("authorizes only explicitly configured owners to administer session exports", async () => {
    const config = accessConfig({
      ...env("production"),
      ACCESS_TEAM_DOMAIN: "https://team.cloudflareaccess.com",
      ACCESS_AUD: "commander-test",
      ACCESS_OWNER_SUBJECTS: " owner@example.test, ",
      ACCESS_OPERATOR_SUBJECTS: "operator@example.test",
    });
    const keys = await crypto.subtle.generateKey(
      {
        name: "RSASSA-PKCS1-v1_5",
        modulusLength: 2048,
        publicExponent: new Uint8Array([1, 0, 1]),
        hash: "SHA-256",
      },
      false,
      ["sign", "verify"],
    );
    const identity = async (claims: Record<string, string>) => {
      const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
      const unsigned = `${encode({ alg: "RS256" })}.${encode({ ...claims, iss: config.teamDomain, aud: config.audience, exp: Math.floor(Date.now() / 1000) + 300 })}`;
      const signature = await crypto.subtle.sign(
        "RSASSA-PKCS1-v1_5",
        keys.privateKey,
        new TextEncoder().encode(unsigned),
      );
      return Effect.runPromise(
        verifyAccessRequest(
          new Request("https://stavka.example.test/admin/export", {
            headers: {
              "cf-access-jwt-assertion": `${unsigned}.${Buffer.from(signature).toString("base64url")}`,
            },
          }),
          config,
          async () => keys.publicKey,
        ),
      );
    };
    const owner = await identity({ sub: "owner-id", email: "owner@example.test" });
    const operator = await identity({ sub: "operator-id", email: "operator@example.test" });
    const spectator = await identity({ sub: "other-id", email: "other@example.test" });
    expect(can(owner, "admin")).toBe(true);
    expect(can(operator, "operate")).toBe(true);
    expect(can(operator, "admin")).toBe(false);
    expect(can(spectator, "admin")).toBe(false);
    expect(can(await identity({ common_name: "machine-token" }), "admin")).toBe(false);
  });
  it("defaults model requests to the private Cloudflare service origin", () => {
    expect(readConfig(env("production")).aiBaseUrl).toBe("https://inference.internal");
  });

  it("enables synthetic development identity only for an explicit local environment", () => {
    expect(accessConfig(env("local")).environment).toBe("local");
  });

  it("fails closed to production for missing or mistyped environments", () => {
    expect(accessConfig(env()).environment).toBe("production");
    expect(accessConfig(env("loacl")).environment).toBe("production");
  });
});
