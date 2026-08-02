import { Data, Effect, Schema } from "effect";

import { DecisionLogEntry } from "./types";

export interface SqlRepositoryHost {
  sql<T = Record<string, string | number | boolean | null>>(
    strings: TemplateStringsArray,
    ...values: (string | number | boolean | null)[]
  ): T[];
}

export class DecisionLogRepositoryError extends Data.TaggedError(
  "DecisionLogRepositoryError",
)<{
  readonly operation:
    | "initialize"
    | "save"
    | "list"
    | "count"
    | "snapshot"
    | "snapshotPage";
  readonly cause: unknown;
}> {}

/**
 * A stable, append-safe boundary for a long-running export. `rowid` is
 * deliberately captured rather than a timestamp: callers may submit events
 * with historical timestamps, but SQLite assigns every inserted row a newer
 * rowid. Export pages then exclude all rows that appeared after this point.
 */
export interface DecisionLogExportSnapshot {
  readonly highWaterRowId: number;
  readonly count: number;
}

export interface DecisionLogExportCursor {
  readonly done: boolean;
  readonly timestamp?: string;
  readonly id?: string;
}

export interface DecisionLogExportPage {
  readonly entries: readonly DecisionLogEntry[];
  readonly cursor: DecisionLogExportCursor;
}

export const initialDecisionLogExportCursor = (): DecisionLogExportCursor => ({ done: false });

export interface DecisionLogRepository {
  readonly initialize: Effect.Effect<void, DecisionLogRepositoryError>;
  readonly save: (entry: DecisionLogEntry) => Effect.Effect<void, DecisionLogRepositoryError>;
  readonly list: (limit: number) => Effect.Effect<DecisionLogEntry[], DecisionLogRepositoryError>;
  readonly count: Effect.Effect<number, DecisionLogRepositoryError>;
  readonly exportSnapshot: Effect.Effect<DecisionLogExportSnapshot, DecisionLogRepositoryError>;
  readonly pageFromSnapshot: (
    snapshot: DecisionLogExportSnapshot,
    cursor: DecisionLogExportCursor,
    limit: number,
  ) => Effect.Effect<DecisionLogExportPage, DecisionLogRepositoryError>;
}

/** The only Commander module allowed to know the decision-log SQL schema. */
export class SqlDecisionLogRepository implements DecisionLogRepository {
  constructor(private readonly host: SqlRepositoryHost) {}

  readonly initialize = Effect.try({
    try: () => {
      void this.host.sql`CREATE TABLE IF NOT EXISTS decision_logs (
        id TEXT PRIMARY KEY,
        timestamp TEXT NOT NULL,
        agent TEXT NOT NULL,
        trigger TEXT NOT NULL,
        payload TEXT NOT NULL
      )`;
      void this.host.sql`CREATE INDEX IF NOT EXISTS decision_logs_timestamp ON decision_logs(timestamp)`;
    },
    catch: (cause) => new DecisionLogRepositoryError({ operation: "initialize", cause }),
  });

  readonly save = (
    entry: DecisionLogEntry,
  ): Effect.Effect<void, DecisionLogRepositoryError> =>
    Effect.try({
      try: () => {
        void this.host.sql`INSERT OR IGNORE INTO decision_logs (id, timestamp, agent, trigger, payload)
          VALUES (${entry.id}, ${entry.timestamp}, ${entry.agent}, ${entry.trigger}, ${JSON.stringify(entry)})`;
      },
      catch: (cause) => new DecisionLogRepositoryError({ operation: "save", cause }),
    });

  readonly list = (
    limit: number,
  ): Effect.Effect<DecisionLogEntry[], DecisionLogRepositoryError> =>
    Effect.try({
      try: () => {
        const safeLimit = Math.min(500, Math.max(1, Math.floor(limit)));
        return this.host.sql<{ payload: string }>`
          SELECT payload FROM decision_logs ORDER BY timestamp DESC LIMIT ${safeLimit}
        `;
      },
      catch: (cause) => new DecisionLogRepositoryError({ operation: "list", cause }),
    }).pipe(
      Effect.flatMap((rows) =>
        Effect.forEach(rows, (row) =>
          Schema.decodeUnknownEffect(Schema.fromJsonString(DecisionLogEntry))(row.payload)),
      ),
      Effect.mapError((cause) =>
        cause instanceof DecisionLogRepositoryError
          ? cause
          : new DecisionLogRepositoryError({ operation: "list", cause }),
      ),
    );

  readonly count: Effect.Effect<number, DecisionLogRepositoryError> = Effect.try({
    try: () => this.host.sql<{ total: number }>`SELECT COUNT(*) AS total FROM decision_logs`,
    catch: (cause) => new DecisionLogRepositoryError({ operation: "count", cause }),
  }).pipe(Effect.map((rows) => rows[0]?.total ?? 0));

  readonly exportSnapshot: Effect.Effect<DecisionLogExportSnapshot, DecisionLogRepositoryError> =
    Effect.try({
      try: () => {
        const row = this.host.sql<{ readonly high_water_rowid: number; readonly total: number }>`
          WITH watermark(high_water_rowid) AS (
            SELECT COALESCE(MAX(rowid), 0) FROM decision_logs
          )
          SELECT high_water_rowid,
            (SELECT COUNT(*) FROM decision_logs WHERE rowid <= high_water_rowid) AS total
          FROM watermark
        `[0];
        return {
          highWaterRowId: row?.high_water_rowid ?? 0,
          count: row?.total ?? 0,
        };
      },
      catch: (cause) => new DecisionLogRepositoryError({ operation: "snapshot", cause }),
    });

  readonly pageFromSnapshot = (
    snapshot: DecisionLogExportSnapshot,
    cursor: DecisionLogExportCursor,
    limit: number,
  ): Effect.Effect<DecisionLogExportPage, DecisionLogRepositoryError> =>
    Effect.try({
      try: () => {
        const safeLimit = Math.min(500, Math.max(1, Math.floor(limit)));
        if (cursor.done || snapshot.highWaterRowId === 0) return [];
        if (cursor.timestamp === undefined || cursor.id === undefined) {
          return this.host.sql<{
            readonly id: string;
            readonly timestamp: string;
            readonly payload: string;
          }>`
            SELECT id, timestamp, payload FROM decision_logs
            WHERE rowid <= ${snapshot.highWaterRowId}
            ORDER BY timestamp ASC, id ASC
            LIMIT ${safeLimit + 1}
          `;
        }
        return this.host.sql<{
          readonly id: string;
          readonly timestamp: string;
          readonly payload: string;
        }>`
          SELECT id, timestamp, payload FROM decision_logs
          WHERE rowid <= ${snapshot.highWaterRowId}
            AND (timestamp > ${cursor.timestamp}
              OR (timestamp = ${cursor.timestamp} AND id > ${cursor.id}))
          ORDER BY timestamp ASC, id ASC
          LIMIT ${safeLimit + 1}
        `;
      },
      catch: (cause) => new DecisionLogRepositoryError({ operation: "snapshotPage", cause }),
    }).pipe(
      Effect.flatMap((rows) => {
        const safeLimit = Math.min(500, Math.max(1, Math.floor(limit)));
        const pageRows = rows.slice(0, safeLimit);
        const hasMore = rows.length > safeLimit;
        const last = pageRows.at(-1);
        return Effect.forEach(pageRows, (row) =>
          Schema.decodeUnknownEffect(Schema.fromJsonString(DecisionLogEntry))(row.payload)).pipe(
          Effect.map((entries): DecisionLogExportPage => ({
            entries,
            cursor: hasMore && last !== undefined
              ? { done: false, timestamp: last.timestamp, id: last.id }
              : { done: true, ...(last === undefined
                ? {}
                : { timestamp: last.timestamp, id: last.id }) },
          })),
        );
      }),
      Effect.mapError((cause) =>
        cause instanceof DecisionLogRepositoryError
          ? cause
          : new DecisionLogRepositoryError({ operation: "snapshotPage", cause }),
      ),
    );
}
