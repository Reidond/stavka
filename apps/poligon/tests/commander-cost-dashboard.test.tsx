import { renderToStaticMarkup } from "react-dom/server";
import type { CommanderCostAggregate } from "@stavka/protocol";
import { describe, expect, it } from "vitest";

import {
  aggregateCommanderCosts,
  CommanderCostDashboard,
} from "../src/components/commander-cost-dashboard";

const aggregate = (overrides: Partial<CommanderCostAggregate> = {}): CommanderCostAggregate => ({
  agent_tier: "commander",
  model: "stavka/commander",
  calls: 1,
  input_tokens: 500,
  output_tokens: 100,
  cost_usd: 0.005,
  ...overrides,
});

describe("CommanderCostDashboard", () => {
  it("groups current-session usage by faction, agent tier, and model", () => {
    const rows = aggregateCommanderCosts([
      {
        faction: "OPFOR",
        aggregates: [aggregate(), aggregate({ calls: 2, input_tokens: 1_000 })],
      },
      {
        faction: "BLUFOR",
        aggregates: [aggregate(), aggregate({ agent_tier: "sergeant" })],
      },
    ]);

    expect(rows).toHaveLength(3);
    expect(rows.find((row) => row.faction === "OPFOR")).toMatchObject({
      agent_tier: "commander",
      model: "stavka/commander",
      calls: 3,
      input_tokens: 1_500,
      output_tokens: 200,
      cost_usd: 0.01,
    });
  });

  it("renders compact calls, token, and cost totals using shared UI components", () => {
    const markup = renderToStaticMarkup(
      <CommanderCostDashboard
        sources={[
          {
            faction: "OPFOR",
            aggregates: [aggregate({ calls: 3, input_tokens: 1_500, output_tokens: 300 })],
          },
        ]}
      />,
    );

    expect(markup).toContain("Commander session cost dashboard");
    expect(markup).toContain("Current commander session usage");
    expect(markup).toContain("OPFOR");
    expect(markup).toContain("stavka/commander");
    expect(markup).toContain("3 calls");
    expect(markup).toContain("1,800 tokens");
    expect(markup).toContain("$0.0050");
  });

  it("renders an explicit empty state for legacy commander responses", () => {
    const markup = renderToStaticMarkup(
      <CommanderCostDashboard sources={[{ faction: "OPFOR" }]} />,
    );

    expect(markup).toContain("No model usage reported for this session");
    expect(markup).toContain("0 calls");
    expect(markup).toContain("0 tokens");
  });
});
