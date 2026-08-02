import { useVirtualizer } from "@tanstack/react-virtual";
import { useRef, type ReactNode } from "react";

export interface LogFeedProps<T> {
  readonly items: readonly T[];
  readonly renderItem: (item: T, index: number) => ReactNode;
  readonly getKey: (item: T, index: number) => string;
  readonly height?: number;
  readonly estimateSize?: number;
}

export const LogFeed = <T,>({
  items,
  renderItem,
  getKey,
  height = 320,
  estimateSize = 52,
}: LogFeedProps<T>) => {
  const parent = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => parent.current,
    estimateSize: () => estimateSize,
    getItemKey: (index) => {
      const item = items[index];
      return item === undefined ? index : getKey(item, index);
    },
    overscan: 8,
  });
  return (
    <div
      ref={parent}
      className="overflow-auto border border-contour bg-ink text-paper"
      style={{ height }}
      role="log"
      aria-live="polite"
    >
      <div className="relative w-full" style={{ height: virtualizer.getTotalSize() }}>
        {virtualizer.getVirtualItems().map((virtualRow) => {
          const item = items[virtualRow.index];
          if (item === undefined) return null;
          return (
            <div
              key={getKey(item, virtualRow.index)}
              className="absolute top-0 left-0 w-full border-b border-paper/15 px-3 py-2 font-data text-xs"
              style={{ transform: `translateY(${virtualRow.start}px)` }}
            >
              {renderItem(item, virtualRow.index)}
            </div>
          );
        })}
      </div>
    </div>
  );
};
