import type { CommanderCostAggregate } from "@stavka/protocol";

export const recordCostAggregate = (
  aggregates: readonly CommanderCostAggregate[],
  agentTier: CommanderCostAggregate["agent_tier"],
  model: string,
  usage: { readonly input: number; readonly output: number },
  costUsd: number,
): CommanderCostAggregate[] => {
  const index = aggregates.findIndex((item) =>
    item.agent_tier === agentTier && item.model === model);
  if (index === -1) {
    return [...aggregates, {
      agent_tier: agentTier,
      model,
      calls: 1,
      input_tokens: usage.input,
      output_tokens: usage.output,
      cost_usd: costUsd,
    }];
  }
  return aggregates.map((item, itemIndex) => itemIndex === index
    ? {
        ...item,
        calls: item.calls + 1,
        input_tokens: item.input_tokens + usage.input,
        output_tokens: item.output_tokens + usage.output,
        cost_usd: item.cost_usd + costUsd,
      }
    : item);
};
