import { Schema } from "effect";

/** Doctrine presets that may cross the v1 wire boundary. */
export const DoctrineId = Schema.Literals(["aggressive", "balanced", "defensive"]);
export type DoctrineId = typeof DoctrineId.Type;
