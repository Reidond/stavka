import type { StandardSchemaV1 } from "@standard-schema/spec";
import { useForm } from "@tanstack/react-form";
import { Schema } from "effect";
import type { JSX } from "react";

import { Button } from "./primitives";

export const effectFormValidator = <A, I extends Record<string, unknown>>(
  schema: Schema.Codec<A, I>,
): StandardSchemaV1<I, A> => Schema.toStandardSchemaV1(schema);

export interface SchemaFormField {
  readonly name: string;
  readonly label: string;
  readonly type?: "text" | "number" | "password" | "select";
  readonly placeholder?: string;
  readonly options?: readonly { readonly value: string; readonly label: string }[];
}

export interface SchemaFormProps<
  TOutput extends Record<string, unknown>,
  TInput extends Record<string, unknown>,
> {
  readonly schema: Schema.Codec<TOutput, TInput>;
  readonly defaultValues: TInput;
  readonly fields: readonly SchemaFormField[];
  readonly submitLabel?: string;
  readonly onSubmit: (value: TOutput) => void | Promise<void>;
}

export const SchemaForm = <
  TOutput extends Record<string, unknown>,
  TInput extends Record<string, unknown>,
>({
  schema,
  defaultValues,
  fields,
  submitLabel = "Submit",
  onSubmit,
}: SchemaFormProps<TOutput, TInput>): JSX.Element => {
  const validator = effectFormValidator(schema);
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
          {(field) => (
            <label className="block space-y-1">
              <span className="stavka-grid-label">{definition.label}</span>
              {definition.type === "select" ? (
                <select
                  name={definition.name}
                  value={String(field.state.value ?? "")}
                  onBlur={field.handleBlur}
                  onChange={(event) => field.handleChange(event.currentTarget.value as never)}
                  className="w-full border border-contour bg-paper px-3 py-2 font-data text-sm"
                >
                  {definition.options?.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              ) : (
                <input
                  name={definition.name}
                  type={definition.type ?? "text"}
                  value={String(field.state.value ?? "")}
                  placeholder={definition.placeholder}
                  onBlur={field.handleBlur}
                  onChange={(event) => {
                    const value =
                      definition.type === "number"
                        ? Number(event.currentTarget.value)
                        : event.currentTarget.value;
                    field.handleChange(value as never);
                  }}
                  className="w-full border border-contour bg-paper px-3 py-2 font-data text-sm"
                />
              )}
              {field.state.meta.errors.length > 0 ? (
                <span className="block font-data text-xs text-carmine">
                  {field.state.meta.errors.map(String).join(", ")}
                </span>
              ) : null}
            </label>
          )}
        </form.Field>
      ))}
      <form.Subscribe selector={(state) => [state.canSubmit, state.isSubmitting]}>
        {([canSubmit, isSubmitting]) => (
          <Button type="submit" disabled={!(canSubmit ?? false) || Boolean(isSubmitting)}>
            {isSubmitting ? "Working…" : submitLabel}
          </Button>
        )}
      </form.Subscribe>
    </form>
  );
};
