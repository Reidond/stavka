import type { ReactNode } from "react";

import { cn, legendSwatchVariants, orderVariants, statusVariants } from "../variants";

export type StatusTone = "works" | "broken" | "pending" | "neutral";

export const Stamp = ({
  children,
  tone = "neutral",
  className = "",
}: {
  readonly children: ReactNode;
  readonly tone?: StatusTone;
  readonly className?: string;
}) => (
  <span
    className={statusVariants({
      tone,
      class: cn(
        `inline-flex -rotate-2 border-2 px-2 py-1 font-display text-sm font-bold tracking-widest uppercase`,
        className,
      ),
    })}
  >
    {children}
  </span>
);

export const StatusChip = ({
  children,
  tone = "neutral",
}: {
  readonly children: ReactNode;
  readonly tone?: StatusTone;
}) => (
  <span
    className={statusVariants({
      tone,
      class:
        "inline-flex rounded-full border px-2 py-0.5 font-data text-[0.65rem] uppercase tracking-wider",
    })}
  >
    {children}
  </span>
);

export const OrderCallout = ({
  title,
  children,
  priority = "normal",
}: {
  readonly title: ReactNode;
  readonly children: ReactNode;
  readonly priority?: "normal" | "urgent";
}) => (
  <aside className={orderVariants({ priority })}>
    <h3 className="font-display text-lg uppercase">{title}</h3>
    <div className="mt-1 text-sm">{children}</div>
  </aside>
);

export const FigureFrame = ({
  caption,
  children,
  className = "",
}: {
  readonly caption: ReactNode;
  readonly children: ReactNode;
  readonly className?: string;
}) => (
  <figure className={cn("stavka-panel overflow-hidden", className)}>
    <div className="min-h-0">{children}</div>
    <figcaption className="border-t border-contour px-3 py-2 font-data text-xs tracking-wider uppercase">
      {caption}
    </figcaption>
  </figure>
);

export interface LegendItem {
  readonly label: string;
  readonly tone: "friendly" | "enemy" | "terrain" | "objective";
}

export const MapLegend = ({ items }: { readonly items: readonly LegendItem[] }) => (
  <div className="stavka-panel flex flex-wrap gap-3 p-3" aria-label="Map legend">
    {items.map((item) => (
      <span
        key={`${item.tone}:${item.label}`}
        className="inline-flex items-center gap-1.5 font-data text-xs uppercase"
      >
        <span className={legendSwatchVariants({ tone: item.tone })} aria-hidden="true" />
        {item.label}
      </span>
    ))}
  </div>
);
