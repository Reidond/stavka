import { Effect, Schema } from "effect";
import type {
  ProviderAccountPublic,
  ProviderId,
  ProvisionProviderAccountPayload,
} from "@stavka/provider-auth";

import type { SeatProvider } from "./config";
import type { HostedSeatRequestLog } from "./hosted-seat-runtime";

interface AuthRow extends Record<string, SqlStorageValue> {
  readonly provider: string;
  readonly ciphertext: string;
  readonly iv: string;
  readonly bootstrap_fingerprint: string;
  readonly revision: number;
  readonly updated_at: number;
}

interface AccountMetadataRow extends Record<string, SqlStorageValue> {
  readonly provider: string;
  readonly name: string;
  readonly label: string;
  readonly auth_kind: string;
  readonly remote_account_id: string | null;
  readonly remote_workspace_id: string | null;
  readonly created_at: number;
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

const fromBase64 = (value: string): ArrayBuffer => {
  const bytes = Uint8Array.from(atob(value), (character) => character.charCodeAt(0));
  return bytes.buffer as ArrayBuffer;
};

const toBase64 = (value: ArrayBuffer): string => {
  const bytes = new Uint8Array(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
};

const vaultOperation = <A>(operation: string, evaluate: () => PromiseLike<A>) =>
  Effect.tryPromise({
    try: evaluate,
    catch: (cause) => new SeatStateRepositoryError({ operation, cause }),
  });

/** The only hosted-seat module allowed to know the Durable Object SQL schema. */
export class SeatStateRepository {
  constructor(
    private readonly sql: SqlStorage,
    private readonly vaultKey: string | undefined,
  ) {}

  private key(): Effect.Effect<CryptoKey, SeatStateRepositoryError> {
    return vaultOperation("auth.key", async () => {
      if (!this.vaultKey) throw new Error("STAVKA_PROVIDER_VAULT_KEY is not configured");
      const raw = fromBase64(this.vaultKey.replace(/-/gu, "+").replace(/_/gu, "/").padEnd(44, "="));
      if (raw.byteLength !== 32) throw new Error("STAVKA_PROVIDER_VAULT_KEY must encode 32 bytes");
      return crypto.subtle.importKey("raw", raw, { name: "AES-GCM" }, false, [
        "encrypt",
        "decrypt",
      ]);
    });
  }

  readonly initialize = repositoryEffect("initialize", () => {
    this.sql.exec(`CREATE TABLE IF NOT EXISTS seat_provider_account (
      provider TEXT PRIMARY KEY,
      ciphertext TEXT NOT NULL,
      iv TEXT NOT NULL,
      bootstrap_fingerprint TEXT NOT NULL,
      revision INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS seat_provider_account_metadata (
      provider TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      label TEXT NOT NULL,
      auth_kind TEXT NOT NULL,
      remote_account_id TEXT,
      remote_workspace_id TEXT,
      created_at INTEGER NOT NULL
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
    return Effect.gen({ self: this }, function* () {
      const row = yield* repositoryEffect(
        "readAuth",
        () =>
          this.sql
            .exec<AuthRow>(
              `SELECT provider, ciphertext, iv, bootstrap_fingerprint, revision, updated_at
         FROM seat_provider_account WHERE provider = ? LIMIT 1`,
              provider,
            )
            .toArray()[0],
      );
      if (!row) return undefined;
      const key = yield* this.key();
      const token = yield* vaultOperation("auth.decrypt", async () => {
        const plaintext = await crypto.subtle.decrypt(
          {
            name: "AES-GCM",
            iv: fromBase64(row.iv),
            additionalData: new TextEncoder().encode(`stavka-hosted-seat:v1:${provider}`),
          },
          key,
          fromBase64(row.ciphertext),
        );
        return new TextDecoder().decode(plaintext);
      });
      return {
        provider: row.provider as SeatProvider,
        token,
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
      const key = yield* this.key();
      const encrypted = yield* vaultOperation("auth.encrypt", async () => {
        const iv = crypto.getRandomValues(new Uint8Array(12));
        const ciphertext = await crypto.subtle.encrypt(
          {
            name: "AES-GCM",
            iv: iv.buffer as ArrayBuffer,
            additionalData: new TextEncoder().encode(`stavka-hosted-seat:v1:${provider}`),
          },
          key,
          new TextEncoder().encode(token),
        );
        return { ciphertext: toBase64(ciphertext), iv: toBase64(iv.buffer as ArrayBuffer) };
      });
      yield* repositoryEffect("replaceAuth", () => {
        this.sql.exec(
          `INSERT INTO seat_provider_account (provider, ciphertext, iv, bootstrap_fingerprint, revision, updated_at)
           VALUES (?, ?, ?, ?, 1, ?)
           ON CONFLICT(provider) DO UPDATE SET
             ciphertext = excluded.ciphertext,
             iv = excluded.iv,
             bootstrap_fingerprint = excluded.bootstrap_fingerprint,
             revision = seat_provider_account.revision + 1,
             updated_at = excluded.updated_at`,
          provider,
          encrypted.ciphertext,
          encrypted.iv,
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

  putProviderAccount(
    provider: ProviderId,
    name: string,
    payload: ProvisionProviderAccountPayload,
    encodedCredential: string,
    credentialFingerprint: string,
    updatedAt: number,
  ): Effect.Effect<ProviderAccountPublic, SeatStateRepositoryError> {
    return Effect.gen({ self: this }, function* () {
      const existing = yield* repositoryEffect(
        "providerAccount.metadata.read",
        () =>
          this.sql
            .exec<AccountMetadataRow>(
              `SELECT provider, name, label, auth_kind, remote_account_id,
                    remote_workspace_id, created_at
             FROM seat_provider_account_metadata WHERE provider = ? LIMIT 1`,
              provider,
            )
            .toArray()[0],
      );
      const auth = yield* this.replaceAuth(
        provider as SeatProvider,
        encodedCredential,
        credentialFingerprint,
        updatedAt,
      );
      const createdAt = existing?.created_at ?? updatedAt;
      yield* repositoryEffect("providerAccount.metadata.write", () => {
        this.sql.exec(
          `INSERT INTO seat_provider_account_metadata (
             provider, name, label, auth_kind, remote_account_id,
             remote_workspace_id, created_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(provider) DO UPDATE SET
             name = excluded.name,
             label = excluded.label,
             auth_kind = excluded.auth_kind,
             remote_account_id = excluded.remote_account_id,
             remote_workspace_id = excluded.remote_workspace_id`,
          provider,
          name,
          payload.label,
          payload.authKind,
          payload.remoteAccountId ?? null,
          payload.remoteWorkspaceId ?? null,
          createdAt,
        );
        // The former plaintext bootstrap table is no longer part of the runtime contract.
        this.sql.exec(`DROP TABLE IF EXISTS seat_auth_state`);
      });
      return {
        provider,
        name,
        label: payload.label,
        authKind: payload.authKind,
        ...(payload.remoteAccountId ? { remoteAccountId: payload.remoteAccountId } : {}),
        ...(payload.remoteWorkspaceId ? { remoteWorkspaceId: payload.remoteWorkspaceId } : {}),
        active: true,
        revision: auth.revision,
        createdAt,
        updatedAt: auth.updatedAt,
      };
    });
  }

  listProviderAccounts(): Effect.Effect<
    readonly ProviderAccountPublic[],
    SeatStateRepositoryError
  > {
    return Effect.gen({ self: this }, function* () {
      const rows = yield* repositoryEffect("providerAccount.list", () =>
        this.sql
          .exec<AccountMetadataRow & Pick<AuthRow, "revision" | "updated_at">>(
            `SELECT metadata.provider, metadata.name, metadata.label, metadata.auth_kind,
                    metadata.remote_account_id, metadata.remote_workspace_id,
                    metadata.created_at, account.revision, account.updated_at
             FROM seat_provider_account_metadata metadata
             INNER JOIN seat_provider_account account ON account.provider = metadata.provider
             ORDER BY metadata.provider, metadata.name`,
          )
          .toArray(),
      );
      return rows.map((row) => ({
        provider: row.provider as ProviderId,
        name: row.name,
        label: row.label,
        authKind: row.auth_kind as ProviderAccountPublic["authKind"],
        ...(row.remote_account_id ? { remoteAccountId: row.remote_account_id } : {}),
        ...(row.remote_workspace_id ? { remoteWorkspaceId: row.remote_workspace_id } : {}),
        active: true,
        revision: row.revision,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      }));
    });
  }

  deleteProviderAccount(provider: ProviderId): Effect.Effect<void, SeatStateRepositoryError> {
    return repositoryEffect("providerAccount.delete", () => {
      this.sql.exec(`DELETE FROM seat_provider_account_metadata WHERE provider = ?`, provider);
      this.sql.exec(`DELETE FROM seat_provider_account WHERE provider = ?`, provider);
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
