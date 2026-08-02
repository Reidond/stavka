import { describe, expect, it } from "vitest";
import type { AccessIdentity, HumanRole } from "@stavka/access-auth";

import {
  decodeConfigureSimWorldInput,
  decodePaused,
  decodeTimeScale,
  hasControlPermission,
} from "../src/sim-world-contract";

const identity = (
  role: HumanRole,
  permissions?: AccessIdentity["permissions"],
): AccessIdentity => ({
  subject: `test:${role}`,
  role,
  serviceToken: role === "automation",
  ...(permissions ? { permissions } : {}),
  claims: {},
});

describe("SimWorld callable contract", () => {
  it("allows operators, owners, and explicit admins while keeping spectators readonly", () => {
    expect(hasControlPermission(identity("owner"))).toBe(true);
    expect(hasControlPermission(identity("operator"))).toBe(true);
    expect(hasControlPermission(identity("spectator"))).toBe(false);
    expect(hasControlPermission(identity("automation", ["read"]))).toBe(false);
    expect(hasControlPermission(identity("automation", ["read", "admin"]))).toBe(true);
  });

  it("decodes valid control inputs at the callable boundary", () => {
    expect(
      decodeConfigureSimWorldInput({
        scenario: "mechanized",
        seed: 42,
        faction: "OPFOR",
        doctrine: "defensive",
        timeScale: 100,
        mode: "versus",
      }),
    ).toEqual({
      scenario: "mechanized",
      seed: 42,
      faction: "OPFOR",
      doctrine: "defensive",
      timeScale: 100,
      mode: "versus",
    });
    expect(decodePaused(false)).toBe(false);
    expect(decodeTimeScale(10)).toBe(10);
  });

  it("rejects malformed or out-of-range RPC inputs", () => {
    expect(() => decodeConfigureSimWorldInput({ scenario: "unknown", seed: 42 })).toThrow();
    expect(() => decodeConfigureSimWorldInput({ scenario: "movement", seed: 0 })).toThrow();
    expect(() => decodeConfigureSimWorldInput({ scenario: "movement", seed: 42.5 })).toThrow();
    expect(() =>
      decodeConfigureSimWorldInput({ scenario: "movement", seed: 42, faction: "" }),
    ).toThrow();
    expect(() => decodePaused("false")).toThrow();
    expect(() => decodeTimeScale(5)).toThrow();
    expect(() =>
      decodeConfigureSimWorldInput({ scenario: "movement", seed: 42, mode: "coop" }),
    ).toThrow();
  });
});
