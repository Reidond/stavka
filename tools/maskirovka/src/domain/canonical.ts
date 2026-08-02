import { createHash } from "node:crypto";

const sortValue = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, child]) => child !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, sortValue(child)]),
    );
  }
  return value;
};

export const canonicalJson = (value: unknown): string => JSON.stringify(sortValue(value));

export const contentHash = (value: unknown): string =>
  createHash("sha256").update(canonicalJson(value)).digest("hex");
