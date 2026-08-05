import { Effect } from "effect";

import type { SeatInvocation, SeatResult } from "../domain/types";
import { contentHash } from "../domain/canonical";
import { estimateTokens, type SeatAdapter } from "./seat-adapter";

const valueForSchema = (schema: Readonly<Record<string, unknown>>, seed: string): unknown => {
  if (schema.const !== undefined) return schema.const;
  if (Array.isArray(schema.enum) && schema.enum.length > 0) return schema.enum[0];
  if (schema.default !== undefined) return schema.default;
  if (Array.isArray(schema.anyOf) && schema.anyOf.length > 0) {
    const first = schema.anyOf[0];
    return typeof first === "object" && first !== null
      ? valueForSchema(first as Record<string, unknown>, seed)
      : null;
  }
  if (schema.type === "object" || typeof schema.properties === "object") {
    const properties =
      schema.properties && typeof schema.properties === "object"
        ? (schema.properties as Record<string, unknown>)
        : {};
    const required = Array.isArray(schema.required)
      ? new Set(schema.required.filter((key): key is string => typeof key === "string"))
      : new Set(Object.keys(properties));
    return Object.fromEntries(
      Object.entries(properties)
        .filter(([key]) => required.has(key))
        .map(([key, child]) => [
          key,
          typeof child === "object" && child !== null
            ? valueForSchema(child as Record<string, unknown>, `${seed}:${key}`)
            : null,
        ]),
    );
  }
  if (schema.type === "array") return [];
  if (schema.type === "boolean") return false;
  if (schema.type === "integer" || schema.type === "number") return 0;
  if (schema.type === "null") return null;
  return `mock-${seed.slice(0, 8)}`;
};

export class MockSeat implements SeatAdapter {
  readonly id = "mock" as const;

  invoke(request: SeatInvocation): Effect.Effect<SeatResult> {
    return Effect.sync(() => {
      const hash = contentHash({ tier: request.tier, prompt: request.prompt });
      const structured = request.outputSchema
        ? valueForSchema(request.outputSchema, hash)
        : undefined;
      const text =
        structured === undefined
          ? `Deterministic mock decision ${hash.slice(0, 12)}: hold position.`
          : JSON.stringify(structured);
      return {
        text,
        ...(structured !== undefined ? { structured } : {}),
        usage: {
          inputTokens: estimateTokens(`${request.system ?? ""}\n${request.prompt}`),
          outputTokens: estimateTokens(text),
          actualCostUsd: 0,
          planCreditUsd: 0,
        },
      };
    });
  }
}
