import type { CommanderCostAggregate } from "@stavka/protocol";
import { DataTable, FigureFrame, StatusChip, type ColumnDef } from "@stavka/ui";

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
    cell: ({ row }) => <StatusChip>{row.original.faction}</StatusChip>,
  },
  {
    id: "agent",
    header: "Agent / model",
    cell: ({ row }) => (
      <div className="min-w-36">
        <StatusChip>{row.original.agent_tier}</StatusChip>
        <span className="mt-1 block font-data text-xs">{row.original.model}</span>
      </div>
    ),
  },
  {
    accessorKey: "calls",
    header: "Calls",
    cell: ({ row }) => <span className="font-data">{formatInteger(row.original.calls)}</span>,
  },
  {
    id: "tokens",
    header: "Tokens",
    cell: ({ row }) => (
      <span className="font-data">
        {formatInteger(row.original.input_tokens + row.original.output_tokens)}
        <span className="block text-[0.65rem] text-ink/60">
          {formatInteger(row.original.input_tokens)} in ·{" "}
          {formatInteger(row.original.output_tokens)} out
        </span>
      </span>
    ),
  },
  {
    accessorKey: "cost_usd",
    header: "Cost",
    cell: ({ row }) => <span className="font-data">{formatCost(row.original.cost_usd)}</span>,
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
    <FigureFrame caption="Current commander session usage">
      <section aria-label="Commander session cost dashboard" className="space-y-3 p-3">
        <header className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="m-0 font-display text-2xl uppercase">Session cost</h2>
          <div className="flex flex-wrap gap-1.5">
            <StatusChip>{formatInteger(totals.calls)} calls</StatusChip>
            <StatusChip>{formatInteger(totals.tokens)} tokens</StatusChip>
            <StatusChip>{formatCost(totals.cost)}</StatusChip>
          </div>
        </header>
        <DataTable
          data={rows}
          columns={columns}
          emptyLabel="No model usage reported for this session"
          getRowId={(row) => row.key}
        />
      </section>
    </FigureFrame>
  );
};
