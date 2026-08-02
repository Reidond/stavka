import { describe, expect, it } from "vitest";

import {
  commanderSessionId,
  parseSimWorldAgentName,
  simWorldAgentName,
} from "../src/scenario-identity";

const base = {
  scenario: "engagement",
  seed: 12,
  doctrine: "balanced",
  timeScale: 10,
  mode: "single",
} as const;

describe("Poligon scenario identity", () => {
  it("isolates every simulation-affecting URL selector", () => {
    expect(simWorldAgentName(base)).toBe("engagement-12-balanced-x10-single");
    expect(simWorldAgentName({ ...base, scenario: "movement" })).not.toBe(simWorldAgentName(base));
    expect(simWorldAgentName({ ...base, seed: 13 })).not.toBe(simWorldAgentName(base));
    expect(simWorldAgentName({ ...base, doctrine: "aggressive" })).not.toBe(
      simWorldAgentName(base),
    );
    expect(simWorldAgentName({ ...base, timeScale: 100 })).not.toBe(simWorldAgentName(base));
    expect(simWorldAgentName({ ...base, mode: "versus" })).not.toBe(simWorldAgentName(base));
  });

  it("round-trips the canonical Agent name into validated selectors", () => {
    expect(parseSimWorldAgentName(simWorldAgentName(base))).toEqual(base);
    expect(parseSimWorldAgentName("mechanized-2147483647-defensive-x100-versus")).toEqual({
      scenario: "mechanized",
      seed: 2_147_483_647,
      doctrine: "defensive",
      timeScale: 100,
      mode: "versus",
    });
  });

  it.each([
    "engagement-0-balanced-x10-single",
    "engagement-2147483648-balanced-x10-single",
    "engagement-012-balanced-x10-single",
    "engagement-1e2-balanced-x10-single",
    "engagement-12.5-balanced-x10-single",
    "unknown-12-balanced-x10-single",
    "engagement-12-unknown-x10-single",
    "engagement-12-balanced-x2-single",
    "engagement-12-balanced-x10-unknown",
    "engagement-12-balanced-10-single",
    "engagement-12-balanced-x10",
    "engagement-12-balanced-x10-single-browser",
    "engagement-12-balanced-x10-single-extra",
  ])("fails closed for invalid or non-canonical Agent name %s", (name) => {
    expect(() => parseSimWorldAgentName(name)).toThrow("Invalid SimWorld agent name");
  });

  it("isolates commander sessions by faction as well as scenario selectors", () => {
    expect(commanderSessionId({ ...base, faction: "OPFOR" })).toBe(
      "poligon-engagement-12-opfor-balanced-x10-single",
    );
    expect(commanderSessionId({ ...base, faction: "BLUFOR" })).not.toBe(
      commanderSessionId({ ...base, faction: "OPFOR" }),
    );
  });
});
