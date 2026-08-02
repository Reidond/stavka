import {
  GameEvent,
  GameSnapshot,
  SessionExport as SharedSessionExportSchema,
  TickRequest,
  type GameEvent as GameEventType,
  type GameSnapshot as GameSnapshotType,
  type SessionExport as SharedSessionExport,
  type TickRequest as TickRequestType,
} from "@stavka/protocol";
import { Data, Effect, Schema } from "effect";

import {
  CommanderSessionStateSchema,
  type CommanderSessionState,
} from "../state/types";
import type { SqlRepositoryHost } from "./decision-log-repository";

export interface ArchivedTick {
  readonly tickId: number;
  readonly timestamp: number;
  readonly kind: TickRequestType["type"];
  readonly request: TickRequestType;
}

export interface ArchivedSnapshot {
  readonly tickId: number;
  readonly timestamp: number;
  readonly snapshot: GameSnapshotType;
}

export interface SessionArchive {
  readonly ticks: readonly ArchivedTick[];
  readonly events: readonly GameEventType[];
  readonly snapshots: readonly ArchivedSnapshot[];
}

export interface SessionArchiveCounts {
  readonly ticks: number;
  readonly events: number;
  readonly snapshots: number;
}

/** A rowid-bound view keeps a long R2 export stable while ticks keep arriving. */
export interface SessionArchiveExportSnapshot {
  readonly tickHighWaterRowId: number;
  readonly eventHighWaterRowId: number;
  readonly snapshotHighWaterRowId: number;
  readonly counts: SessionArchiveCounts;
}

export interface ArchiveNumericCursor {
  readonly done: boolean;
  readonly after?: number;
}

export interface ArchiveEventCursor {
  readonly done: boolean;
  readonly timestamp?: number;
  readonly id?: string;
}

export interface SessionArchiveExportCursor {
  readonly ticks: ArchiveNumericCursor;
  readonly events: ArchiveEventCursor;
  readonly snapshots: ArchiveNumericCursor;
}

export interface SessionArchiveExportPage {
  readonly archive: SessionArchive;
  readonly cursor: SessionArchiveExportCursor;
}

export const initialSessionArchiveExportCursor = (): SessionArchiveExportCursor => ({
  ticks: { done: false },
  events: { done: false },
  snapshots: { done: false },
});

export const ArchivedTickSchema = Schema.Struct({
  tickId: Schema.Number,
  timestamp: Schema.Number,
  kind: Schema.Literals(["full", "delta"]),
  request: TickRequest,
});

export const ArchivedSnapshotSchema = Schema.Struct({
  tickId: Schema.Number,
  timestamp: Schema.Number,
  snapshot: GameSnapshot,
});

export const SessionArchiveSchema = Schema.Struct({
  ticks: Schema.Array(ArchivedTickSchema),
  events: Schema.Array(GameEvent),
  snapshots: Schema.Array(ArchivedSnapshotSchema),
});

export const SessionExportSchema = SharedSessionExportSchema;
export type SessionExport = SharedSessionExport;

const PersistedSnapshotSchema = Schema.Union([
  GameSnapshot,
  CommanderSessionStateSchema,
]);

const decodeArchivedSnapshot = (row: {
  readonly tick_id: number;
  readonly timestamp: number;
  readonly payload: string;
}): Effect.Effect<ArchivedSnapshot, unknown> =>
  Schema.decodeUnknownEffect(Schema.fromJsonString(PersistedSnapshotSchema))(row.payload).pipe(
    Effect.flatMap((persisted) => {
      const snapshot = "mission" in persisted ? persisted : persisted.snapshot;
      return snapshot === undefined
        ? Effect.fail(new Error(`Snapshot history row ${row.tick_id} has no game snapshot`))
        : Effect.succeed({
            tickId: row.tick_id,
            timestamp: row.timestamp,
            snapshot,
          });
    }),
  );

export class SessionArchiveRepositoryError extends Data.TaggedError(
  "SessionArchiveRepositoryError",
)<{
  readonly operation:
    | "initialize"
    | "saveTick"
    | "export"
    | "count"
    | "snapshot"
    | "snapshotPage";
  readonly cause: unknown;
}> {}

export interface SessionArchiveRepository {
  readonly initialize: Effect.Effect<void, SessionArchiveRepositoryError>;
  readonly saveTick: (
    request: TickRequestType,
    state: CommanderSessionState,
  ) => Effect.Effect<void, SessionArchiveRepositoryError>;
  readonly export: (limit: number) => Effect.Effect<SessionArchive, SessionArchiveRepositoryError>;
  readonly count: Effect.Effect<SessionArchiveCounts, SessionArchiveRepositoryError>;
  readonly exportSnapshot: Effect.Effect<
    SessionArchiveExportSnapshot,
    SessionArchiveRepositoryError
  >;
  readonly pageFromSnapshot: (
    snapshot: SessionArchiveExportSnapshot,
    cursor: SessionArchiveExportCursor,
    limit: number,
  ) => Effect.Effect<SessionArchiveExportPage, SessionArchiveRepositoryError>;
}

/** Owns the complete tick, event, and state-snapshot SQLite schema. */
export class SqlSessionArchiveRepository implements SessionArchiveRepository {
  constructor(private readonly host: SqlRepositoryHost) {}

  readonly initialize = Effect.try({
    try: () => {
      void this.host.sql`CREATE TABLE IF NOT EXISTS tick_history (
        tick_id INTEGER PRIMARY KEY,
        timestamp REAL NOT NULL,
        kind TEXT NOT NULL,
        payload TEXT NOT NULL
      )`;
      void this.host.sql`CREATE TABLE IF NOT EXISTS event_history (
        id TEXT PRIMARY KEY,
        timestamp REAL NOT NULL,
        payload TEXT NOT NULL
      )`;
      void this.host.sql`CREATE TABLE IF NOT EXISTS snapshot_history (
        tick_id INTEGER PRIMARY KEY,
        timestamp REAL NOT NULL,
        payload TEXT NOT NULL
      )`;
      void this.host.sql`CREATE INDEX IF NOT EXISTS event_history_timestamp ON event_history(timestamp)`;
      void this.host.sql`CREATE INDEX IF NOT EXISTS snapshot_history_timestamp ON snapshot_history(timestamp)`;
    },
    catch: (cause) => new SessionArchiveRepositoryError({ operation: "initialize", cause }),
  });

  readonly saveTick = (
    request: TickRequestType,
    state: CommanderSessionState,
  ): Effect.Effect<void, SessionArchiveRepositoryError> =>
    Effect.try({
      try: () => {
        void this.host.sql`INSERT OR IGNORE INTO tick_history (tick_id, timestamp, kind, payload)
          VALUES (${request.tick_id}, ${request.timestamp}, ${request.type}, ${JSON.stringify(request)})`;
        for (const event of request.events) {
          void this.host.sql`INSERT OR IGNORE INTO event_history (id, timestamp, payload)
            VALUES (${event.id}, ${event.timestamp}, ${JSON.stringify(event)})`;
        }
        if (state.snapshot !== undefined) {
          void this.host.sql`INSERT OR IGNORE INTO snapshot_history (tick_id, timestamp, payload)
            VALUES (${request.tick_id}, ${request.timestamp}, ${JSON.stringify(state.snapshot)})`;
        }
      },
      catch: (cause) => new SessionArchiveRepositoryError({ operation: "saveTick", cause }),
    });

  readonly export = (
    limit: number,
  ): Effect.Effect<SessionArchive, SessionArchiveRepositoryError> =>
    Effect.try({
      try: () => {
        const safeLimit = Math.min(10_000, Math.max(1, Math.floor(limit)));
        return {
          tickRows: this.host.sql<{
          tick_id: number;
          timestamp: number;
          payload: string;
          }>`SELECT tick_id, timestamp, payload
            FROM tick_history ORDER BY tick_id ASC LIMIT ${safeLimit}`,
          eventRows: this.host.sql<{ payload: string }>`SELECT payload
            FROM event_history ORDER BY timestamp ASC LIMIT ${safeLimit}`,
          snapshotRows: this.host.sql<{
          tick_id: number;
          timestamp: number;
          payload: string;
          }>`SELECT tick_id, timestamp, payload
            FROM snapshot_history ORDER BY tick_id ASC LIMIT ${safeLimit}`,
        };
      },
      catch: (cause) => new SessionArchiveRepositoryError({ operation: "export", cause }),
    }).pipe(
      Effect.flatMap(({ eventRows, snapshotRows, tickRows }) =>
        Effect.all({
          ticks: Effect.forEach(tickRows, (row) =>
            Schema.decodeUnknownEffect(Schema.fromJsonString(TickRequest))(row.payload).pipe(
              Effect.map((request): ArchivedTick => ({
                tickId: row.tick_id,
                timestamp: row.timestamp,
                kind: request.type,
                request,
              })),
            )),
          events: Effect.forEach(eventRows, (row) =>
            Schema.decodeUnknownEffect(Schema.fromJsonString(GameEvent))(row.payload)),
          snapshots: Effect.forEach(snapshotRows, decodeArchivedSnapshot),
        }),
      ),
      Effect.mapError((cause) =>
        cause instanceof SessionArchiveRepositoryError
          ? cause
          : new SessionArchiveRepositoryError({ operation: "export", cause }),
      ),
    );

  readonly count: Effect.Effect<SessionArchiveCounts, SessionArchiveRepositoryError> =
    Effect.try({
      try: () => ({
        ticks: this.host.sql<{ total: number }>`SELECT COUNT(*) AS total FROM tick_history`[0]
          ?.total ?? 0,
        events: this.host.sql<{ total: number }>`SELECT COUNT(*) AS total FROM event_history`[0]
          ?.total ?? 0,
        snapshots: this.host.sql<{ total: number }>`SELECT COUNT(*) AS total FROM snapshot_history`[0]
          ?.total ?? 0,
      }),
      catch: (cause) => new SessionArchiveRepositoryError({ operation: "count", cause }),
    });

  readonly exportSnapshot: Effect.Effect<
    SessionArchiveExportSnapshot,
    SessionArchiveRepositoryError
  > = Effect.try({
    try: () => {
      const ticks = this.host.sql<{ readonly high_water_rowid: number; readonly total: number }>`
        WITH watermark(high_water_rowid) AS (
          SELECT COALESCE(MAX(rowid), 0) FROM tick_history
        )
        SELECT high_water_rowid,
          (SELECT COUNT(*) FROM tick_history WHERE rowid <= high_water_rowid) AS total
        FROM watermark
      `[0];
      const events = this.host.sql<{ readonly high_water_rowid: number; readonly total: number }>`
        WITH watermark(high_water_rowid) AS (
          SELECT COALESCE(MAX(rowid), 0) FROM event_history
        )
        SELECT high_water_rowid,
          (SELECT COUNT(*) FROM event_history WHERE rowid <= high_water_rowid) AS total
        FROM watermark
      `[0];
      const snapshots = this.host.sql<{ readonly high_water_rowid: number; readonly total: number }>`
        WITH watermark(high_water_rowid) AS (
          SELECT COALESCE(MAX(rowid), 0) FROM snapshot_history
        )
        SELECT high_water_rowid,
          (SELECT COUNT(*) FROM snapshot_history WHERE rowid <= high_water_rowid) AS total
        FROM watermark
      `[0];
      return {
        tickHighWaterRowId: ticks?.high_water_rowid ?? 0,
        eventHighWaterRowId: events?.high_water_rowid ?? 0,
        snapshotHighWaterRowId: snapshots?.high_water_rowid ?? 0,
        counts: {
          ticks: ticks?.total ?? 0,
          events: events?.total ?? 0,
          snapshots: snapshots?.total ?? 0,
        },
      };
    },
    catch: (cause) => new SessionArchiveRepositoryError({ operation: "snapshot", cause }),
  });

  readonly pageFromSnapshot = (
    snapshot: SessionArchiveExportSnapshot,
    cursor: SessionArchiveExportCursor,
    limit: number,
  ): Effect.Effect<SessionArchiveExportPage, SessionArchiveRepositoryError> =>
    Effect.try({
      try: () => {
        const safeLimit = Math.min(500, Math.max(1, Math.floor(limit)));
        const tickRows = cursor.ticks.done || snapshot.tickHighWaterRowId === 0
          ? []
          : cursor.ticks.after === undefined
          ? this.host.sql<{
              readonly tick_id: number;
              readonly timestamp: number;
              readonly payload: string;
            }>`SELECT tick_id, timestamp, payload FROM tick_history
              WHERE rowid <= ${snapshot.tickHighWaterRowId}
              ORDER BY tick_id ASC LIMIT ${safeLimit + 1}`
          : this.host.sql<{
              readonly tick_id: number;
              readonly timestamp: number;
              readonly payload: string;
            }>`SELECT tick_id, timestamp, payload FROM tick_history
              WHERE rowid <= ${snapshot.tickHighWaterRowId} AND tick_id > ${cursor.ticks.after}
              ORDER BY tick_id ASC LIMIT ${safeLimit + 1}`;
        const eventRows = cursor.events.done || snapshot.eventHighWaterRowId === 0
          ? []
          : cursor.events.timestamp === undefined || cursor.events.id === undefined
          ? this.host.sql<{
              readonly id: string;
              readonly timestamp: number;
              readonly payload: string;
            }>`SELECT id, timestamp, payload FROM event_history
              WHERE rowid <= ${snapshot.eventHighWaterRowId}
              ORDER BY timestamp ASC, id ASC LIMIT ${safeLimit + 1}`
          : this.host.sql<{
              readonly id: string;
              readonly timestamp: number;
              readonly payload: string;
            }>`SELECT id, timestamp, payload FROM event_history
              WHERE rowid <= ${snapshot.eventHighWaterRowId}
                AND (timestamp > ${cursor.events.timestamp}
                  OR (timestamp = ${cursor.events.timestamp} AND id > ${cursor.events.id}))
              ORDER BY timestamp ASC, id ASC LIMIT ${safeLimit + 1}`;
        const snapshotRows = cursor.snapshots.done || snapshot.snapshotHighWaterRowId === 0
          ? []
          : cursor.snapshots.after === undefined
          ? this.host.sql<{
              readonly tick_id: number;
              readonly timestamp: number;
              readonly payload: string;
            }>`SELECT tick_id, timestamp, payload FROM snapshot_history
              WHERE rowid <= ${snapshot.snapshotHighWaterRowId}
              ORDER BY tick_id ASC LIMIT ${safeLimit + 1}`
          : this.host.sql<{
              readonly tick_id: number;
              readonly timestamp: number;
              readonly payload: string;
            }>`SELECT tick_id, timestamp, payload FROM snapshot_history
              WHERE rowid <= ${snapshot.snapshotHighWaterRowId}
                AND tick_id > ${cursor.snapshots.after}
              ORDER BY tick_id ASC LIMIT ${safeLimit + 1}`;
        return {
          tickRows,
          eventRows,
          snapshotRows,
        };
      },
      catch: (cause) => new SessionArchiveRepositoryError({ operation: "snapshotPage", cause }),
    }).pipe(
      Effect.flatMap(({ eventRows, snapshotRows, tickRows }) => {
        const safeLimit = Math.min(500, Math.max(1, Math.floor(limit)));
        const pageTicks = tickRows.slice(0, safeLimit);
        const pageEvents = eventRows.slice(0, safeLimit);
        const pageSnapshots = snapshotRows.slice(0, safeLimit);
        const tickLast = pageTicks.at(-1);
        const eventLast = pageEvents.at(-1);
        const snapshotLast = pageSnapshots.at(-1);
        const nextCursor: SessionArchiveExportCursor = {
          ticks: tickRows.length > safeLimit && tickLast !== undefined
            ? { done: false, after: tickLast.tick_id }
            : { done: true, ...(tickLast === undefined ? {} : { after: tickLast.tick_id }) },
          events: eventRows.length > safeLimit && eventLast !== undefined
            ? { done: false, timestamp: eventLast.timestamp, id: eventLast.id }
            : {
                done: true,
                ...(eventLast === undefined
                  ? {}
                  : { timestamp: eventLast.timestamp, id: eventLast.id }),
              },
          snapshots: snapshotRows.length > safeLimit && snapshotLast !== undefined
            ? { done: false, after: snapshotLast.tick_id }
            : {
                done: true,
                ...(snapshotLast === undefined ? {} : { after: snapshotLast.tick_id }),
              },
        };
        return Effect.all({
          ticks: Effect.forEach(pageTicks, (row) =>
            Schema.decodeUnknownEffect(Schema.fromJsonString(TickRequest))(row.payload).pipe(
              Effect.map((request): ArchivedTick => ({
                tickId: row.tick_id,
                timestamp: row.timestamp,
                kind: request.type,
                request,
              })),
            )),
          events: Effect.forEach(pageEvents, (row) =>
            Schema.decodeUnknownEffect(Schema.fromJsonString(GameEvent))(row.payload)),
          snapshots: Effect.forEach(pageSnapshots, decodeArchivedSnapshot),
        }).pipe(
          Effect.map((archive): SessionArchiveExportPage => ({ archive, cursor: nextCursor })),
        );
      }),
      Effect.mapError((cause) =>
        cause instanceof SessionArchiveRepositoryError
          ? cause
          : new SessionArchiveRepositoryError({ operation: "snapshotPage", cause }),
      ),
    );
}
