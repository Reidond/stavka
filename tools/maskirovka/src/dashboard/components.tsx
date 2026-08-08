import { Badge } from "@cloudflare/kumo/components/badge";
import { Button } from "@cloudflare/kumo/components/button";
import { Field } from "@cloudflare/kumo/components/field";
import { Input } from "@cloudflare/kumo/components/input";
import { LayerCard } from "@cloudflare/kumo/components/layer-card";
import { Meter } from "@cloudflare/kumo/components/meter";
import { Select } from "@cloudflare/kumo/components/select";
import { useForm } from "@tanstack/react-form";
import { useVirtualizer } from "@tanstack/react-virtual";
import type { StandardSchemaV1 } from "@standard-schema/spec";
import { Schema } from "effect";
import { useRef, type ReactNode } from "react";

export type MaskirovkaStatus = "success" | "error" | "warning" | "info" | "neutral";

export const MaskirovkaBadge = ({
  children,
  status = "neutral",
}: {
  readonly children: ReactNode;
  readonly status?: MaskirovkaStatus;
}) => <Badge variant={status === "neutral" ? "secondary" : status}>{children}</Badge>;

export const MaskirovkaSeatOverview = ({
  name,
  provider,
  healthy,
  mode,
  budgetUsed,
  budgetTotal,
  models,
}: {
  readonly name: string;
  readonly provider: string;
  readonly healthy: boolean;
  readonly mode: string;
  readonly budgetUsed: number;
  readonly budgetTotal: number;
  readonly models: readonly string[];
}) => (
  <LayerCard className="space-y-4 p-4">
    <div className="flex items-start justify-between gap-3">
      <div>
        <h3 className="m-0 text-xl font-semibold text-kumo-strong uppercase">{name}</h3>
        <p className="m-0 text-xs text-kumo-subtle uppercase">
          {provider} · {mode}
        </p>
      </div>
      <MaskirovkaBadge status={healthy ? "success" : "error"}>
        {healthy ? "healthy" : "offline"}
      </MaskirovkaBadge>
    </div>
    <Meter
      label="Budget used"
      value={budgetTotal <= 0 ? 0 : Math.min(100, (budgetUsed / budgetTotal) * 100)}
      customValue={`$${budgetUsed.toFixed(2)} / $${budgetTotal.toFixed(2)}`}
      indicatorClassName="bg-kumo-info"
    />
    <div className="flex flex-wrap gap-1">
      {models.map((model) => (
        <MaskirovkaBadge key={model}>{model}</MaskirovkaBadge>
      ))}
    </div>
  </LayerCard>
);

export interface MaskirovkaFormField {
  readonly name: string;
  readonly label: string;
  readonly type?: "text" | "number" | "password" | "select";
  readonly placeholder?: string;
  readonly options?: readonly { readonly value: string; readonly label: string }[];
}

export const MaskirovkaSettingsForm = <
  TOutput extends Record<string, unknown>,
  TInput extends Record<string, unknown>,
>({
  schema,
  defaultValues,
  fields,
  submitLabel = "Submit",
  onSubmit,
}: {
  readonly schema: Schema.Codec<TOutput, TInput>;
  readonly defaultValues: TInput;
  readonly fields: readonly MaskirovkaFormField[];
  readonly submitLabel?: string;
  readonly onSubmit: (value: TOutput) => void | Promise<void>;
}) => {
  const validator: StandardSchemaV1<TInput, TOutput> = Schema.toStandardSchemaV1(schema);
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

export const MaskirovkaLogFeed = <T,>({
  items,
  renderItem,
  getKey,
  height = 320,
  estimateSize = 52,
}: {
  readonly items: readonly T[];
  readonly renderItem: (item: T, index: number) => ReactNode;
  readonly getKey: (item: T, index: number) => string;
  readonly height?: number;
  readonly estimateSize?: number;
}) => {
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
      className="overflow-auto rounded-sm border border-kumo-line bg-kumo-contrast text-kumo-inverse"
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
              className="absolute top-0 left-0 w-full border-b border-kumo-base/20 px-3 py-2 text-xs"
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
