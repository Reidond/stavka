import { Context, Effect, Schema } from "effect";

import { GatewayRepositoryError, repositoryEffect } from "./gateway-repository-error";

export const GatewayWindowSnapshot = Schema.Struct({
  version: Schema.Literal(1),
  trackedSince: Schema.String,
  requests: Schema.Number,
  cacheHits: Schema.Number,
  reservations: Schema.Number,
  updatedAt: Schema.Number,
});
export type GatewayWindowSnapshot = typeof GatewayWindowSnapshot.Type;

interface WindowRow extends Record<string, SqlStorageValue> {
  readonly snapshot_json: string;
}

export interface WindowTrackerRepositoryService {
  readonly initialize: Effect.Effect<void, GatewayRepositoryError>;
  readonly read: Effect.Effect<GatewayWindowSnapshot | undefined, GatewayRepositoryError>;
  readonly save: (snapshot: GatewayWindowSnapshot) => Effect.Effect<void, GatewayRepositoryError>;
}

export class WindowTrackerRepository extends Context.Service<
  WindowTrackerRepository,
  WindowTrackerRepositoryService
>()("stavka/maskirovka-gateway/WindowTrackerRepository") {}

export class DurableWindowTrackerRepository implements WindowTrackerRepositoryService {
  constructor(private readonly sql: SqlStorage) {}

  readonly initialize = repositoryEffect("window.initialize", () => {
    this.sql.exec(`CREATE TABLE IF NOT EXISTS gateway_window_tracker (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      snapshot_json TEXT NOT NULL
    )`);
  });

  readonly read: Effect.Effect<GatewayWindowSnapshot | undefined, GatewayRepositoryError> =
    repositoryEffect("window.read", () => {
      const row = this.sql
        .exec<WindowRow>(`SELECT snapshot_json FROM gateway_window_tracker WHERE singleton = 1`)
        .toArray()[0];
      if (!row) return undefined;
      return Schema.decodeUnknownSync(GatewayWindowSnapshot)(
        JSON.parse(row.snapshot_json) as unknown,
      );
    });

  save(snapshot: GatewayWindowSnapshot): Effect.Effect<void, GatewayRepositoryError> {
    return repositoryEffect("window.save", () => {
      this.sql.exec(
        `INSERT INTO gateway_window_tracker (singleton, snapshot_json)
         VALUES (1, ?)
         ON CONFLICT(singleton) DO UPDATE SET snapshot_json = excluded.snapshot_json`,
        JSON.stringify(snapshot),
      );
    });
  }
}

export const initialGatewayWindowSnapshot = (): GatewayWindowSnapshot => ({
  version: 1,
  trackedSince: new Date().toISOString(),
  requests: 0,
  cacheHits: 0,
  reservations: 0,
  updatedAt: Date.now(),
});
