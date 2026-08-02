import { Effect, Schema } from "effect";

import type { SeatProvider } from "./config";
import type { HostedSeatRequestLog } from "./hosted-seat-runtime";

interface AuthRow extends Record<string, SqlStorageValue> {
  readonly provider: string;
  readonly token: string;
  readonly bootstrap_fingerprint: string;
  readonly revision: number;
  readonly updated_at: number;
}

interface LifecycleRow extends Record<string, SqlStorageValue> {
  readonly status: string;
  readonly last_change: number;
  readonly last_error: string | null;
}

interface ContainerRuntimeRow extends Record<string, SqlStorageValue> {
  readonly auth_fingerprint: string;
}

interface ControlsRow extends Record<string, SqlStorageValue> {
  readonly killed: number;
  readonly alias_overrides_json: string;
  readonly updated_at: number;
}

interface RequestLogRow extends Record<string, SqlStorageValue> {
  readonly request_id: string;
  readonly timestamp: number;
  readonly dialect: string;
  readonly alias: string;
  readonly model: string;
  readonly status: number;
  readonly latency_ms: number;
  readonly queue_depth: number;
}

export interface PersistedAuthState {
  readonly provider: SeatProvider;
  readonly token: string;
  readonly bootstrapFingerprint: string;
  readonly revision: number;
  readonly updatedAt: number;
}

export interface PersistedLifecycle {
  readonly status: string;
  readonly lastChange: number;
  readonly lastError?: string;
}

interface PersistedControlState {
  readonly killed: boolean;
  readonly aliasOverrides: Readonly<Record<string, string>>;
  readonly updatedAt: number;
}

export interface HostedSeatControls {
  readonly killed: boolean;
  readonly aliases: Readonly<Record<string, string>>;
  readonly updatedAt: number;
}

export const HOSTED_REQUEST_LOG_LIMIT = 200;

const AliasNameSchema = Schema.String.pipe(
  Schema.check(Schema.isTrimmed(), Schema.isNonEmpty(), Schema.isMaxLength(128)),
);
const ModelNameSchema = Schema.String.pipe(
  Schema.check(Schema.isTrimmed(), Schema.isNonEmpty(), Schema.isMaxLength(256)),
);
const AliasOverridesSchema = Schema.Record(AliasNameSchema, ModelNameSchema);
const RequestLogRowSchema = Schema.Struct({
  request_id: Schema.String,
  timestamp: Schema.Number,
  dialect: Schema.Literals(["openai-responses", "anthropic-messages"]),
  alias: Schema.String,
  model: Schema.String,
  status: Schema.Number,
  latency_ms: Schema.Number,
  queue_depth: Schema.Number,
});

export class SeatStateRepositoryError extends Schema.TaggedErrorClass<SeatStateRepositoryError>(
  "stavka/maskirovka-seat/SeatStateRepositoryError",
)("SeatStateRepositoryError", {
  operation: Schema.String,
  cause: Schema.Defect(),
}) {}

const repositoryEffect = <A>(operation: string, evaluate: () => A) =>
  Effect.try({
    try: evaluate,
    catch: (cause) => new SeatStateRepositoryError({ operation, cause }),
  });

/** The only hosted-seat module allowed to know the Durable Object SQL schema. */
export class SeatStateRepository {
  constructor(private readonly sql: SqlStorage) {}

  readonly initialize = repositoryEffect("initialize", () => {
    this.sql.exec(`CREATE TABLE IF NOT EXISTS seat_auth_state (
      provider TEXT PRIMARY KEY,
      token TEXT NOT NULL,
      bootstrap_fingerprint TEXT NOT NULL,
      revision INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS seat_lifecycle (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      status TEXT NOT NULL,
      last_change INTEGER NOT NULL,
        last_error TEXT
      )`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS seat_container_runtime (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        auth_fingerprint TEXT NOT NULL
      )`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS seat_controls (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        killed INTEGER NOT NULL CHECK (killed IN (0, 1)),
        alias_overrides_json TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      )`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS seat_request_log (
        request_id TEXT PRIMARY KEY,
        timestamp INTEGER NOT NULL,
        dialect TEXT NOT NULL,
        alias TEXT NOT NULL,
        model TEXT NOT NULL,
        status INTEGER NOT NULL,
        latency_ms INTEGER NOT NULL,
        queue_depth INTEGER NOT NULL
      )`);
    this.sql.exec(
      `CREATE INDEX IF NOT EXISTS seat_request_log_timestamp
       ON seat_request_log (timestamp DESC)`,
    );
  });

  readAuth(
    provider: SeatProvider,
  ): Effect.Effect<PersistedAuthState | undefined, SeatStateRepositoryError> {
    return repositoryEffect("readAuth", () => {
      const row = this.sql
        .exec<AuthRow>(
          `SELECT provider, token, bootstrap_fingerprint, revision, updated_at
         FROM seat_auth_state WHERE provider = ? LIMIT 1`,
          provider,
        )
        .toArray()[0];
      if (!row) return undefined;
      return {
        provider: row.provider as SeatProvider,
        token: row.token,
        bootstrapFingerprint: row.bootstrap_fingerprint,
        revision: row.revision,
        updatedAt: row.updated_at,
      };
    });
  }

  replaceAuth(
    provider: SeatProvider,
    token: string,
    bootstrapFingerprint: string,
    updatedAt: number,
  ): Effect.Effect<PersistedAuthState, SeatStateRepositoryError> {
    return Effect.gen({ self: this }, function* () {
      yield* repositoryEffect("replaceAuth", () => {
        this.sql.exec(
          `INSERT INTO seat_auth_state (provider, token, bootstrap_fingerprint, revision, updated_at)
           VALUES (?, ?, ?, 1, ?)
           ON CONFLICT(provider) DO UPDATE SET
             token = excluded.token,
             bootstrap_fingerprint = excluded.bootstrap_fingerprint,
             revision = seat_auth_state.revision + 1,
             updated_at = excluded.updated_at`,
          provider,
          token,
          bootstrapFingerprint,
          updatedAt,
        );
      });
      const state = yield* this.readAuth(provider);
      if (!state) {
        return yield* Effect.fail(
          new SeatStateRepositoryError({
            operation: "replaceAuth",
            cause: new Error("Failed to persist seat auth state"),
          }),
        );
      }
      return state;
    });
  }

  checkpointAuth(
    provider: SeatProvider,
    token: string,
    updatedAt: number,
  ): Effect.Effect<PersistedAuthState, SeatStateRepositoryError> {
    return Effect.gen({ self: this }, function* () {
      const existing = yield* this.readAuth(provider);
      if (!existing) {
        return yield* Effect.fail(
          new SeatStateRepositoryError({
            operation: "checkpointAuth",
            cause: new Error("Cannot checkpoint auth before bootstrap"),
          }),
        );
      }
      if (existing.token === token) return existing;
      return yield* this.replaceAuth(provider, token, existing.bootstrapFingerprint, updatedAt);
    });
  }

  readonly readContainerAuthFingerprint: Effect.Effect<
    string | undefined,
    SeatStateRepositoryError
  > = repositoryEffect("readContainerAuthFingerprint", () => {
    const row = this.sql
      .exec<ContainerRuntimeRow>(
        `SELECT auth_fingerprint FROM seat_container_runtime WHERE singleton = 1`,
      )
      .toArray()[0];
    return row?.auth_fingerprint;
  });

  writeContainerAuthFingerprint(
    authFingerprint: string,
  ): Effect.Effect<void, SeatStateRepositoryError> {
    return repositoryEffect("writeContainerAuthFingerprint", () => {
      this.sql.exec(
        `INSERT INTO seat_container_runtime (singleton, auth_fingerprint)
         VALUES (1, ?)
         ON CONFLICT(singleton) DO UPDATE SET
           auth_fingerprint = excluded.auth_fingerprint`,
        authFingerprint,
      );
    });
  }

  recordLifecycle(
    status: string,
    changedAt: number,
    lastError?: string,
  ): Effect.Effect<void, SeatStateRepositoryError> {
    return repositoryEffect("recordLifecycle", () => {
      this.sql.exec(
        `INSERT INTO seat_lifecycle (singleton, status, last_change, last_error)
         VALUES (1, ?, ?, ?)
         ON CONFLICT(singleton) DO UPDATE SET
           status = excluded.status,
           last_change = excluded.last_change,
           last_error = excluded.last_error`,
        status,
        changedAt,
        lastError ?? null,
      );
    });
  }

  readonly readLifecycle: Effect.Effect<PersistedLifecycle | undefined, SeatStateRepositoryError> =
    repositoryEffect("readLifecycle", () => {
      const row = this.sql
        .exec<LifecycleRow>(
          `SELECT status, last_change, last_error FROM seat_lifecycle WHERE singleton = 1`,
        )
        .toArray()[0];
      if (!row) return undefined;
      return {
        status: row.status,
        lastChange: row.last_change,
        ...(row.last_error ? { lastError: row.last_error } : {}),
      };
    });

  private readonly readControlState: Effect.Effect<
    PersistedControlState,
    SeatStateRepositoryError
  > = Effect.gen({ self: this }, function* () {
    const row = yield* repositoryEffect(
      "readControls",
      () =>
        this.sql
          .exec<ControlsRow>(
            `SELECT killed, alias_overrides_json, updated_at
           FROM seat_controls WHERE singleton = 1 LIMIT 1`,
          )
          .toArray()[0],
    );
    if (!row) return { killed: false, aliasOverrides: {}, updatedAt: 0 };
    const parsed = yield* Effect.try({
      try: () => JSON.parse(row.alias_overrides_json) as unknown,
      catch: (cause) => new SeatStateRepositoryError({ operation: "readControls", cause }),
    });
    const aliasOverrides = yield* Schema.decodeUnknownEffect(AliasOverridesSchema)(parsed).pipe(
      Effect.mapError(
        (cause) => new SeatStateRepositoryError({ operation: "readControls", cause }),
      ),
    );
    return {
      killed: row.killed === 1,
      aliasOverrides,
      updatedAt: row.updated_at,
    };
  });

  readControls(
    configuredAliases: Readonly<Record<string, string>>,
  ): Effect.Effect<HostedSeatControls, SeatStateRepositoryError> {
    return this.readControlState.pipe(
      Effect.map((state) => ({
        killed: state.killed,
        aliases: Object.freeze({
          ...configuredAliases,
          ...Object.fromEntries(
            Object.entries(state.aliasOverrides).filter(([alias]) =>
              Object.hasOwn(configuredAliases, alias),
            ),
          ),
        }),
        updatedAt: state.updatedAt,
      })),
    );
  }

  setKilled(enabled: boolean, updatedAt: number): Effect.Effect<void, SeatStateRepositoryError> {
    return Effect.gen({ self: this }, function* () {
      const state = yield* this.readControlState;
      yield* this.writeControlState({ ...state, killed: enabled, updatedAt });
    });
  }

  remapAlias(
    alias: string,
    model: string,
    configuredAliases: Readonly<Record<string, string>>,
    updatedAt: number,
  ): Effect.Effect<void, SeatStateRepositoryError> {
    return Effect.gen({ self: this }, function* () {
      if (!Object.hasOwn(configuredAliases, alias)) {
        return yield* Effect.fail(
          new SeatStateRepositoryError({
            operation: "remapAlias",
            cause: new Error(`Unknown configured alias: ${alias}`),
          }),
        );
      }
      const checked = yield* Schema.decodeUnknownEffect(ModelNameSchema)(model).pipe(
        Effect.mapError(
          (cause) => new SeatStateRepositoryError({ operation: "remapAlias", cause }),
        ),
      );
      const state = yield* this.readControlState;
      yield* this.writeControlState({
        ...state,
        aliasOverrides: { ...state.aliasOverrides, [alias]: checked },
        updatedAt,
      });
    });
  }

  recordRequest(log: HostedSeatRequestLog): Effect.Effect<void, SeatStateRepositoryError> {
    return repositoryEffect("recordRequest", () => {
      this.sql.exec(
        `INSERT INTO seat_request_log (
           request_id, timestamp, dialect, alias, model, status, latency_ms, queue_depth
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(request_id) DO UPDATE SET
           timestamp = excluded.timestamp,
           dialect = excluded.dialect,
           alias = excluded.alias,
           model = excluded.model,
           status = excluded.status,
           latency_ms = excluded.latency_ms,
           queue_depth = excluded.queue_depth`,
        log.request_id,
        log.timestamp,
        log.dialect,
        log.alias,
        log.model,
        log.status,
        log.latency_ms,
        log.queue_depth,
      );
      this.sql.exec(
        `DELETE FROM seat_request_log
         WHERE request_id NOT IN (
           SELECT request_id FROM seat_request_log
           ORDER BY timestamp DESC, request_id DESC LIMIT ?
         )`,
        HOSTED_REQUEST_LOG_LIMIT,
      );
    });
  }

  listRecentRequests(
    limit: number,
  ): Effect.Effect<readonly HostedSeatRequestLog[], SeatStateRepositoryError> {
    const bounded = Math.max(1, Math.min(HOSTED_REQUEST_LOG_LIMIT, Math.trunc(limit)));
    return Effect.gen({ self: this }, function* () {
      const rows = yield* repositoryEffect("listRecentRequests", () =>
        this.sql
          .exec<RequestLogRow>(
            `SELECT request_id, timestamp, dialect, alias, model, status, latency_ms, queue_depth
             FROM seat_request_log
             ORDER BY timestamp DESC, request_id DESC LIMIT ?`,
            bounded,
          )
          .toArray(),
      );
      return yield* Effect.forEach(rows, (row) =>
        Schema.decodeUnknownEffect(RequestLogRowSchema)(row).pipe(
          Effect.mapError(
            (cause) => new SeatStateRepositoryError({ operation: "listRecentRequests", cause }),
          ),
        ),
      );
    });
  }

  readonly countRequests: Effect.Effect<number, SeatStateRepositoryError> = repositoryEffect(
    "countRequests",
    () => {
      const row = this.sql
        .exec<{ readonly count: number }>(`SELECT COUNT(*) AS count FROM seat_request_log`)
        .toArray()[0];
      return row?.count ?? 0;
    },
  );

  private writeControlState(
    state: PersistedControlState,
  ): Effect.Effect<void, SeatStateRepositoryError> {
    return repositoryEffect("writeControls", () => {
      this.sql.exec(
        `INSERT INTO seat_controls (singleton, killed, alias_overrides_json, updated_at)
         VALUES (1, ?, ?, ?)
         ON CONFLICT(singleton) DO UPDATE SET
           killed = excluded.killed,
           alias_overrides_json = excluded.alias_overrides_json,
           updated_at = excluded.updated_at`,
        state.killed ? 1 : 0,
        JSON.stringify(state.aliasOverrides),
        state.updatedAt,
      );
    });
  }
}
