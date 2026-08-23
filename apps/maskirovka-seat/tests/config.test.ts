import { describe, expect, it } from "vitest";

import { hostedAccessConfig, type SeatEnv } from "../src/config";

describe("hosted seat Access roles", () => {
  it("maps explicit owners while keeping automation read-only", () => {
    const config = hostedAccessConfig({
      ENVIRONMENT: "production",
      ACCESS_TEAM_DOMAIN: "https://team.cloudflareaccess.com",
      ACCESS_AUD: "audience",
      ACCESS_OWNER_SUBJECTS: "owner-sub, owner@example.test",
    } as unknown as SeatEnv);

    expect(config.ownerSubjects).toEqual(["owner-sub", "owner@example.test"]);
    expect(config.automationPermissions).toEqual(["read"]);
  });
});
