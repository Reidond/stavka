import { describe, expect, it } from "vitest";

import { readConfig } from "../src/config";

describe("Maskirovka Access environment", () => {
  it("keeps the CLI Sergeant cap closed unless hosted admission is explicit", () => {
    expect(readConfig({}, "/tmp/maskirovka-config").liveSergeantBudget).toBe(0);
    expect(
      readConfig({ MASKIROVKA_LIVE_SERGEANTS: "hosted" }, "/tmp/maskirovka-config")
        .liveSergeantBudget,
    ).toBe("hosted");
    expect(
      readConfig({ MASKIROVKA_LIVE_SERGEANTS: "typo" }, "/tmp/maskirovka-config")
        .liveSergeantBudget,
    ).toBe(0);
  });
  it("rejects an invalid gateway mode instead of silently enabling live traffic", () => {
    expect(() => readConfig({ MASKIROVKA_MODE: "replaay" }, "/tmp/maskirovka-config")).toThrow(
      /MASKIROVKA_MODE must be live, record, or replay/u,
    );
  });

  it("fails closed when ENVIRONMENT is missing or misspelled", () => {
    expect(readConfig({}, "/tmp/maskirovka-config").access?.environment).toBe("production");
    expect(readConfig({ ENVIRONMENT: "locla" }, "/tmp/maskirovka-config").access?.environment).toBe(
      "production",
    );
  });

  it("enables synthetic identity only for exact local", () => {
    expect(
      readConfig(
        { ENVIRONMENT: "local", DEV_ACCESS_EMAIL: "operator@example.test" },
        "/tmp/maskirovka-config",
      ).access,
    ).toMatchObject({
      environment: "local",
      devEmail: "operator@example.test",
    });
  });
});
