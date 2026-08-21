import { describe, expect, it } from "vitest";

import { recordCostAggregate } from "../src/state/cost-aggregates";

describe("commander cost aggregates", () => {
  it("groups calls by agent tier and resolved model while accumulating usage", () => {
    const first = recordCostAggregate(
      [],
      "commander",
      "claude-sonnet-4-5",
      { input: 120, output: 30 },
      0.012,
    );
    const repeated = recordCostAggregate(
      first,
      "commander",
      "claude-sonnet-4-5",
      { input: 80, output: 20 },
      0.008,
    );
    const sergeant = recordCostAggregate(
      repeated,
      "sergeant",
      "claude-sonnet-4-5",
      { input: 40, output: 10 },
      0.004,
    );
    const otherModel = recordCostAggregate(
      sergeant,
      "commander",
      "gpt-5-mini",
      { input: 50, output: 5 },
      0.002,
    );

    expect(otherModel).toHaveLength(3);
    expect(otherModel[0]).toMatchObject({
      agent_tier: "commander",
      model: "claude-sonnet-4-5",
      calls: 2,
      input_tokens: 200,
      output_tokens: 50,
    });
    expect(otherModel[0]?.cost_usd).toBeCloseTo(0.02);
    expect(otherModel[1]).toEqual({
      agent_tier: "sergeant",
      model: "claude-sonnet-4-5",
      calls: 1,
      input_tokens: 40,
      output_tokens: 10,
      cost_usd: 0.004,
    });
    expect(otherModel[2]).toEqual({
      agent_tier: "commander",
      model: "gpt-5-mini",
      calls: 1,
      input_tokens: 50,
      output_tokens: 5,
      cost_usd: 0.002,
    });
  });
});
