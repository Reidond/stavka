import { Badge } from "@cloudflare/kumo/components/badge";
import { Button } from "@cloudflare/kumo/components/button";
import { Field } from "@cloudflare/kumo/components/field";
import { Input } from "@cloudflare/kumo/components/input";
import { LayerCard } from "@cloudflare/kumo/components/layer-card";
import { Select } from "@cloudflare/kumo/components/select";
import { Table } from "@cloudflare/kumo/components/table";
import { Slider } from "@cloudflare/kumo/primitives/slider";
import type { StandardSchemaV1 } from "@standard-schema/spec";
import { flexRender, getCoreRowModel, useReactTable, type ColumnDef } from "@tanstack/react-table";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useForm } from "@tanstack/react-form";
import { Schema } from "effect";
import { useMemo, useRef, type ReactNode } from "react";

export const poligonVisualizationPalette = {
  canvas: "#f9fafb",
  terrain: "#64748b",
  friendly: "#2563eb",
  hostile: "#dc2626",
  objective: "#d97706",
  grid: "#94a3b8",
} as const;

export type PoligonStatus = "success" | "error" | "warning" | "info" | "neutral";

export const statusVariant = (
  status: PoligonStatus,
): "success" | "error" | "warning" | "info" | "secondary" =>
  status === "neutral" ? "secondary" : status;

export const PoligonBadge = ({
  children,
  status = "neutral",
}: {
  readonly children: ReactNode;
  readonly status?: PoligonStatus;
}) => <Badge variant={statusVariant(status)}>{children}</Badge>;

export const PoligonFigure = ({
  caption,
  children,
  className,
}: {
  readonly caption: ReactNode;
  readonly children: ReactNode;
  readonly className?: string;
}) => (
  <LayerCard render={<figure />} className={className ?? "overflow-hidden p-0"}>
    <div className="min-h-0">{children}</div>
    <figcaption className="border-t border-kumo-hairline px-3 py-2 text-xs tracking-wider text-kumo-subtle uppercase">
      {caption}
    </figcaption>
  </LayerCard>
);

export interface PoligonLegendItem {
  readonly label: string;
  readonly tone: "friendly" | "hostile" | "terrain" | "objective";
}

export const PoligonLegend = ({ items }: { readonly items: readonly PoligonLegendItem[] }) => (
  <LayerCard className="flex flex-wrap gap-3 p-3" aria-label="Map legend">
    {items.map((item) => (
      <span
        key={`${item.tone}:${item.label}`}
        className="inline-flex items-center gap-1.5 text-xs text-kumo-subtle uppercase"
      >
        <span
          className="size-2.5 rounded-full"
          style={{ backgroundColor: poligonVisualizationPalette[item.tone] }}
          aria-hidden="true"
        />
        {item.label}
      </span>
    ))}
  </LayerCard>
);

export interface PoligonTableProps<TData> {
  readonly data: readonly TData[];
  readonly columns: readonly ColumnDef<TData, unknown>[];
  readonly emptyLabel?: string;
  readonly getRowId?: (row: TData, index: number) => string;
}

export const PoligonDataTable = <TData,>({
  data,
  columns,
  emptyLabel = "No records",
  getRowId,
}: PoligonTableProps<TData>) => {
  const tableData = useMemo(() => [...data], [data]);
  const tableColumns = useMemo(() => [...columns], [columns]);
  const table = useReactTable({
    data: tableData,
    columns: tableColumns,
    getCoreRowModel: getCoreRowModel(),
    ...(getRowId ? { getRowId } : {}),
  });

  return (
    <LayerCard className="overflow-x-auto p-0">
      <Table>
        <Table.Header variant="compact">
          {table.getHeaderGroups().map((group) => (
            <Table.Row key={group.id}>
              {group.headers.map((header) => (
                <Table.Head key={header.id}>
                  {header.isPlaceholder
                    ? null
                    : flexRender(header.column.columnDef.header, header.getContext())}
                </Table.Head>
              ))}
            </Table.Row>
          ))}
        </Table.Header>
        <Table.Body>
          {table.getRowModel().rows.map((row) => (
            <Table.Row key={row.id}>
              {row.getVisibleCells().map((cell) => (
                <Table.Cell key={cell.id}>
                  {flexRender(cell.column.columnDef.cell, cell.getContext())}
                </Table.Cell>
              ))}
            </Table.Row>
          ))}
        </Table.Body>
      </Table>
      {data.length === 0 ? (
        <p className="m-0 px-3 py-6 text-center text-xs text-kumo-subtle uppercase">{emptyLabel}</p>
      ) : null}
    </LayerCard>
  );
};

export interface PoligonLogFeedProps<T> {
  readonly items: readonly T[];
  readonly renderItem: (item: T, index: number) => ReactNode;
  readonly getKey: (item: T, index: number) => string;
  readonly height?: number;
  readonly estimateSize?: number;
}

export const PoligonLogFeed = <T,>({
  items,
  renderItem,
  getKey,
  height = 320,
  estimateSize = 52,
}: PoligonLogFeedProps<T>) => {
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
      className="overflow-auto rounded-lg border border-kumo-hairline bg-kumo-base text-kumo-default"
      style={{ height: items.length ? height : 120 }}
      role="log"
      aria-live="polite"
    >
      {items.length === 0 ? (
        <div className="stavka-empty min-h-0">
          <p>No events recorded yet.</p>
        </div>
      ) : null}
      <div className="relative w-full" style={{ height: virtualizer.getTotalSize() }}>
        {virtualizer.getVirtualItems().map((virtualRow) => {
          const item = items[virtualRow.index];
          if (item === undefined) return null;
          return (
            <div
              key={getKey(item, virtualRow.index)}
              data-index={virtualRow.index}
              ref={virtualizer.measureElement}
              className="absolute top-0 left-0 w-full border-b border-kumo-hairline p-4 text-xs/5"
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

export interface PoligonFormField {
  readonly name: string;
  readonly label: string;
  readonly type?: "text" | "number" | "password" | "select";
  readonly placeholder?: string;
  readonly options?: readonly { readonly value: string; readonly label: string }[];
}

export interface PoligonSchemaFormProps<
  TOutput extends Record<string, unknown>,
  TInput extends Record<string, unknown>,
> {
  readonly schema: Schema.Codec<TOutput, TInput>;
  readonly defaultValues: TInput;
  readonly fields: readonly PoligonFormField[];
  readonly submitLabel?: string;
  readonly onSubmit: (value: TOutput) => void | Promise<void>;
}

export const poligonEffectFormValidator = <A, I extends Record<string, unknown>>(
  schema: Schema.Codec<A, I>,
): StandardSchemaV1<I, A> => Schema.toStandardSchemaV1(schema);

export const PoligonSettingsForm = <
  TOutput extends Record<string, unknown>,
  TInput extends Record<string, unknown>,
>({
  schema,
  defaultValues,
  fields,
  submitLabel = "Submit",
  onSubmit,
}: PoligonSchemaFormProps<TOutput, TInput>) => {
  const validator = poligonEffectFormValidator(schema);
  const form = useForm({
    defaultValues,
    validators: { onSubmit: validator },
    onSubmit: async ({ value }) => {
      const result = await validator["~standard"].validate(value);
      if ("value" in result) await onSubmit(result.value);
    },
  });

  return (
    <form
      className="space-y-3"
      onSubmit={(event) => {
        event.preventDefault();
        event.stopPropagation();
        void form.handleSubmit();
      }}
    >
      {fields.map((definition) => (
        <form.Field key={definition.name} name={definition.name as never}>
          {(field) => {
            const errors = field.state.meta.errors.map(String).join(", ");
            if (definition.type === "select") {
              return (
                <Field
                  label={definition.label}
                  {...(errors ? { error: { message: errors, match: true } } : {})}
                >
                  <Select
                    aria-label={definition.label}
                    value={String(field.state.value ?? "")}
                    onValueChange={(value) => field.handleChange((value ?? "") as never)}
                    items={Object.fromEntries(
                      (definition.options ?? []).map((option) => [option.value, option.label]),
                    )}
                    disabled={field.state.meta.isValidating}
                  />
                </Field>
              );
            }
            return (
              <Input
                label={definition.label}
                type={definition.type ?? "text"}
                value={String(field.state.value ?? "")}
                {...(definition.placeholder === undefined
                  ? {}
                  : { placeholder: definition.placeholder })}
                onBlur={field.handleBlur}
                onChange={(event) => {
                  const value =
                    definition.type === "number"
                      ? Number(event.currentTarget.value)
                      : event.currentTarget.value;
                  field.handleChange(value as never);
                }}
                {...(errors ? { error: errors } : {})}
              />
            );
          }}
        </form.Field>
      ))}
      <form.Subscribe selector={(state) => [state.canSubmit, state.isSubmitting]}>
        {([canSubmit, isSubmitting]) => (
          <Button
            type="submit"
            variant="primary"
            disabled={!(canSubmit ?? false) || Boolean(isSubmitting)}
          >
            {isSubmitting ? "Working…" : submitLabel}
          </Button>
        )}
      </form.Subscribe>
    </form>
  );
};

const speeds = [1, 10, 100] as const;

export const PoligonTimeScrubber = ({
  paused,
  speed,
  time,
  maxTime,
  onPausedChange,
  onStep,
  onSpeedChange,
  onSeek,
}: {
  readonly paused: boolean;
  readonly speed: number;
  readonly time: number;
  readonly maxTime: number;
  readonly onPausedChange: (paused: boolean) => void;
  readonly onStep: () => void;
  readonly onSpeedChange: (speed: number) => void;
  readonly onSeek?: (time: number) => void;
}) => (
  <LayerCard className="space-y-3 p-3">
    <div className="flex flex-wrap items-center gap-2">
      <Button
        variant={paused ? "primary" : "secondary"}
        onClick={() => onPausedChange(!paused)}
        aria-pressed={paused}
      >
        {paused ? "Resume" : "Pause"}
      </Button>
      <Button variant="secondary" onClick={onStep} disabled={!paused}>
        Step
      </Button>
      {speeds.map((item) => (
        <Button
          key={item}
          size="sm"
          variant={speed === item ? "primary" : "secondary"}
          onClick={() => onSpeedChange(item)}
          aria-pressed={speed === item}
        >
          ×{item}
        </Button>
      ))}
      <output className="ml-auto text-xs text-kumo-subtle">T+{time.toFixed(1)}s</output>
    </div>
    <Slider.Root
      value={time}
      min={0}
      max={Math.max(1, maxTime)}
      step={0.1}
      disabled={!onSeek}
      onValueChange={(value) => onSeek?.(typeof value === "number" ? value : (value[0] ?? 0))}
    >
      <Slider.Control className="flex h-5 touch-none items-center">
        <Slider.Track className="relative h-1 w-full rounded-sm bg-kumo-line">
          <Slider.Indicator className="absolute h-full rounded-sm bg-kumo-danger" />
          <Slider.Thumb className="size-4 rounded-full border border-kumo-line bg-kumo-base" />
        </Slider.Track>
      </Slider.Control>
    </Slider.Root>
  </LayerCard>
);
