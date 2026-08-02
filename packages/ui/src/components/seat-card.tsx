import { StatusChip } from "./display";

export interface SeatCardProps {
  readonly name: string;
  readonly provider: string;
  readonly healthy: boolean;
  readonly mode: string;
  readonly budgetUsed: number;
  readonly budgetTotal: number;
  readonly models: readonly string[];
}

export const SeatCard = ({
  name,
  provider,
  healthy,
  mode,
  budgetUsed,
  budgetTotal,
  models,
}: SeatCardProps) => {
  const percentage = budgetTotal <= 0 ? 0 : Math.min(100, (budgetUsed / budgetTotal) * 100);
  return (
    <article className="stavka-panel p-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="m-0 font-display text-xl uppercase">{name}</h3>
          <p className="m-0 font-data text-xs text-ink/70 uppercase">
            {provider} · {mode}
          </p>
        </div>
        <StatusChip tone={healthy ? "works" : "broken"}>
          {healthy ? "healthy" : "offline"}
        </StatusChip>
      </div>
      <div
        className="mt-4 h-2 border border-contour bg-paper"
        aria-label={`${percentage.toFixed(0)}% budget used`}
      >
        <div className="h-full bg-ultramarine" style={{ width: `${percentage}%` }} />
      </div>
      <p className="font-data text-xs">
        ${budgetUsed.toFixed(2)} / ${budgetTotal.toFixed(2)}
      </p>
      <div className="flex flex-wrap gap-1">
        {models.map((model) => (
          <StatusChip key={model}>{model}</StatusChip>
        ))}
      </div>
    </article>
  );
};
