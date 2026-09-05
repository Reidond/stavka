import { describe, expect, it } from "vitest";
import { commanderPresentation, decisionSource } from "../src/components/simulation-inspector";
import type { PoligonCommanderState, PoligonDecision } from "../src/sim-world";
const commander: PoligonCommanderState = {
  connected: true,
  tickRateHint: 1000,
  mode: "llm",
  lastTickId: 1,
};
const decision = (model: string): PoligonDecision => ({
  key: "1",
  faction: "OPFOR",
  id: "1",
  timestamp: "2026-09-05T12:00:00Z",
  summary: "Hold",
  model,
  latency_ms: 5,
  cost_usd: 0,
});
describe("Commander status evidence", () => {
  it("does not treat LLM configuration as a recorded model response", () => {
    expect(commanderPresentation(commander, undefined).label).toBe("Awaiting decision");
    expect(commanderPresentation(undefined, decision("real-model")).label).toBe("Not connected");
    expect(
      commanderPresentation({ ...commander, lastError: "Unavailable" }, decision("real-model"))
        .label,
    ).toBe("Error");
  });
  it("separates rule and mock decisions from recorded model decisions", () => {
    for (const model of [
      "rule-planner",
      "mock:commander",
      "mock/opfor-commander",
      "mock-commander",
    ]) {
      expect(decisionSource(model)).toBe("Rule decisions");
      expect(commanderPresentation(commander, decision(model)).variant).toBe("warning");
    }
    expect(commanderPresentation(commander, decision("stavka/commander"))).toMatchObject({
      label: "Model decisions",
      variant: "success",
    });
  });
});
