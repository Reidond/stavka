import type { CommanderCostAggregate } from "@stavka/protocol";
import { Badge } from "@cloudflare/kumo/components/badge";
import { LayerCard } from "@cloudflare/kumo/components/layer-card";
import type { ColumnDef } from "@tanstack/react-table";

import { PoligonDataTable } from "./poligon-ui";

export interface CommanderCostSource {
  readonly faction: string;
  readonly aggregates?: readonly CommanderCostAggregate[];
}

export type CommanderCostRow = CommanderCostAggregate & {
  readonly faction: string;
  readonly key: string;
};

const integerFormat = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });

const formatInteger = (value: number): string => integerFormat.format(value);
const formatCost = (value: number): string => `$${value.toFixed(4)}`;

export const aggregateCommanderCosts = (
  sources: readonly CommanderCostSource[],
): readonly CommanderCostRow[] => {
  const grouped = new Map<string, CommanderCostRow>();
  for (const source of sources) {
    for (const aggregate of source.aggregates ?? []) {
      const key = JSON.stringify([source.faction, aggregate.agent_tier, aggregate.model]);
      const current = grouped.get(key);
      grouped.set(key, {
        key,
        faction: source.faction,
        agent_tier: aggregate.agent_tier,
        model: aggregate.model,
        calls: (current?.calls ?? 0) + aggregate.calls,
        input_tokens: (current?.input_tokens ?? 0) + aggregate.input_tokens,
        output_tokens: (current?.output_tokens ?? 0) + aggregate.output_tokens,
        cost_usd: (current?.cost_usd ?? 0) + aggregate.cost_usd,
      });
    }
  }

  return [...grouped.values()].sort(
    (left, right) =>
      left.faction.localeCompare(right.faction) ||
      left.agent_tier.localeCompare(right.agent_tier) ||
      left.model.localeCompare(right.model),
  );
};

const columns: ColumnDef<CommanderCostRow, unknown>[] = [
  {
    accessorKey: "faction",
    header: "Faction",
    cell: ({ row }) => <Badge variant="secondary">{row.original.faction}</Badge>,
  },
  {
    id: "agent",
    header: "Agent / model",
    cell: ({ row }) => (
      <div className="min-w-36">
        <Badge variant="secondary">{row.original.agent_tier}</Badge>
        <span className="mt-1 block text-xs text-kumo-subtle">{row.original.model}</span>
      </div>
    ),
  },
  {
    accessorKey: "calls",
    header: "Calls",
    cell: ({ row }) => <span>{formatInteger(row.original.calls)}</span>,
  },
  {
    id: "tokens",
    header: "Tokens",
    cell: ({ row }) => (
      <span>
        {formatInteger(row.original.input_tokens + row.original.output_tokens)}
        <span className="block text-[0.65rem] text-kumo-subtle">
          {formatInteger(row.original.input_tokens)} in ·{" "}
          {formatInteger(row.original.output_tokens)} out
        </span>
      </span>
    ),
  },
  {
    accessorKey: "cost_usd",
    header: "Cost",
    cell: ({ row }) => <span>{formatCost(row.original.cost_usd)}</span>,
  },
];

export const CommanderCostDashboard = ({
  sources,
}: {
  readonly sources: readonly CommanderCostSource[];
}) => {
  const rows = aggregateCommanderCosts(sources);
  const totals = rows.reduce(
    (current, row) => ({
      calls: current.calls + row.calls,
      tokens: current.tokens + row.input_tokens + row.output_tokens,
      cost: current.cost + row.cost_usd,
    }),
    { calls: 0, tokens: 0, cost: 0 },
  );

  return (
    <LayerCard className="overflow-hidden p-0">
      <p className="border-b border-kumo-hairline px-3 py-2 text-xs tracking-wider text-kumo-subtle uppercase">
        Current commander session usage
      </p>
      <section aria-label="Commander session cost dashboard" className="space-y-3 p-3">
        <header className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="m-0 text-2xl font-semibold text-kumo-strong uppercase">Session cost</h2>
          <div className="flex flex-wrap gap-1.5">
            <Badge variant="secondary">{formatInteger(totals.calls)} calls</Badge>
            <Badge variant="secondary">{formatInteger(totals.tokens)} tokens</Badge>
            <Badge variant="secondary">{formatCost(totals.cost)}</Badge>
          </div>
        </header>
        <PoligonDataTable
          data={rows}
          columns={columns}
          emptyLabel="No model usage reported for this session"
          getRowId={(row) => row.key}
        />
      </section>
    </LayerCard>
  );
};
