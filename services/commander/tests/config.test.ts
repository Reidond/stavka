import { describe, expect, it } from "vitest";

import { accessConfig, type Env } from "../src/config";

const env = (environment?: string): Env => ({
  ORCHESTRATOR: {} as Env["ORCHESTRATOR"],
  TERRAIN_CACHE: {} as Env["TERRAIN_CACHE"],
  API_KEY: "machine-secret",
  DEV_ACCESS_EMAIL: "operator@example.test",
  ...(environment === undefined ? {} : { ENVIRONMENT: environment }),
});

describe("Commander Access posture", () => {
  it("enables synthetic development identity only for an explicit local environment", () => {
    expect(accessConfig(env("local")).environment).toBe("local");
  });

  it("fails closed to production for missing or mistyped environments", () => {
    expect(accessConfig(env()).environment).toBe("production");
    expect(accessConfig(env("loacl")).environment).toBe("production");
  });
});
