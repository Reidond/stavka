import { describe, expect, it } from "vitest";

import { hostedAccessConfig, type GatewayEnv } from "../src/config";

describe("gateway Access roles", () => {
  it("maps explicit comma-separated owner and operator subjects", () => {
    const config = hostedAccessConfig({
      ENVIRONMENT: "production",
      ACCESS_TEAM_DOMAIN: "https://team.cloudflareaccess.com",
      ACCESS_AUD: "audience",
      ACCESS_OWNER_SUBJECTS: "owner-sub, owner@example.test",
      ACCESS_OPERATOR_SUBJECTS: "operator-sub",
    } as unknown as GatewayEnv);

    expect(config.ownerSubjects).toEqual(["owner-sub", "owner@example.test"]);
    expect(config.operatorSubjects).toEqual(["operator-sub"]);
    expect(config.automationPermissions).toEqual(["read"]);
  });
});
