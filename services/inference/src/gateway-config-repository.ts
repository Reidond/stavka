import { Context, Effect, Schema } from "effect";

import type { GatewayAlias, GatewaySeat, GatewayTier } from "./config";
import { GatewayRepositoryError, repositoryEffect } from "./gateway-repository-error";

interface ConfigRow extends Record<string, SqlStorageValue> {
  readonly singleton: number;
  readonly aliases_json: string;
  readonly killed: number;
  readonly revision: number;
  readonly updated_at: number;
}

interface RuntimeRow extends Record<string, SqlStorageValue> {
  readonly singleton: number;
  readonly auth_fingerprint: string | null;
  readonly lifecycle: string;
  readonly last_change: number;
}

const AliasSchema = Schema.Struct({
  tier: Schema.String,
  seat: Schema.String,
  model: Schema.String,
});
const PersistedConfigSchema = Schema.Struct({
  aliases: Schema.Array(AliasSchema),
  killed: Schema.Boolean,
  revision: Schema.Number,
  updatedAt: Schema.Number,
});

export interface PersistedGatewayConfig {
  readonly aliases: readonly GatewayAlias[];
  readonly killed: boolean;
  readonly revision: number;
  readonly updatedAt: number;
}

export interface GatewayConfigRepositoryService {
  readonly initialize: Effect.Effect<void, GatewayRepositoryError>;
  readonly load: Effect.Effect<PersistedGatewayConfig | undefined, GatewayRepositoryError>;
  readonly save: (config: PersistedGatewayConfig) => Effect.Effect<void, GatewayRepositoryError>;
  readonly runtime: Effect.Effect<
    { readonly fingerprint?: string; readonly lifecycle: string; readonly lastChange: number },
    GatewayRepositoryError
  >;
  readonly saveRuntime: (
    fingerprint: string,
    lifecycle: string,
    lastChange: number,
  ) => Effect.Effect<void, GatewayRepositoryError>;
}

export class GatewayConfigRepository extends Context.Service<
  GatewayConfigRepository,
  GatewayConfigRepositoryService
>()("stavka/maskirovka-gateway/GatewayConfigRepository") {}

export class DurableGatewayConfigRepository implements GatewayConfigRepositoryService {
  constructor(private readonly sql: SqlStorage) {}

  readonly initialize = repositoryEffect("config.initialize", () => {
    this.sql.exec(`CREATE TABLE IF NOT EXISTS gateway_config (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      aliases_json TEXT NOT NULL,
      killed INTEGER NOT NULL CHECK (killed IN (0, 1)),
      revision INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS gateway_container_runtime (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      auth_fingerprint TEXT,
      lifecycle TEXT NOT NULL,
      last_change INTEGER NOT NULL
    )`);
  });

  readonly load: Effect.Effect<PersistedGatewayConfig | undefined, GatewayRepositoryError> =
    repositoryEffect("config.load", () => {
      const row = this.sql
        .exec<ConfigRow>(
          `SELECT singleton, aliases_json, killed, revision, updated_at
           FROM gateway_config WHERE singleton = 1`,
        )
        .toArray()[0];
      if (!row) return undefined;
      const decoded = Schema.decodeUnknownSync(PersistedConfigSchema)({
        aliases: JSON.parse(row.aliases_json) as unknown,
        killed: row.killed === 1,
        revision: row.revision,
        updatedAt: row.updated_at,
      });
      return {
        aliases: decoded.aliases as GatewayAlias[],
        killed: row.killed === 1,
        revision: row.revision,
        updatedAt: row.updated_at,
      };
    });

  save(config: PersistedGatewayConfig): Effect.Effect<void, GatewayRepositoryError> {
    return repositoryEffect("config.save", () => {
      this.sql.exec(
        `INSERT INTO gateway_config (singleton, aliases_json, killed, revision, updated_at)
         VALUES (1, ?, ?, ?, ?)
         ON CONFLICT(singleton) DO UPDATE SET
           aliases_json = excluded.aliases_json,
           killed = excluded.killed,
           revision = excluded.revision,
           updated_at = excluded.updated_at`,
        JSON.stringify(config.aliases),
        config.killed ? 1 : 0,
        config.revision,
        config.updatedAt,
      );
    });
  }

  readonly runtime: Effect.Effect<
    { readonly fingerprint?: string; readonly lifecycle: string; readonly lastChange: number },
    GatewayRepositoryError
  > = repositoryEffect("config.runtime", () => {
    const row = this.sql
      .exec<RuntimeRow>(
        `SELECT auth_fingerprint, lifecycle, last_change
         FROM gateway_container_runtime WHERE singleton = 1`,
      )
      .toArray()[0];
    return {
      ...(row?.auth_fingerprint ? { fingerprint: row.auth_fingerprint } : {}),
      lifecycle: row?.lifecycle ?? "stopped",
      lastChange: row?.last_change ?? 0,
    };
  });

  saveRuntime(
    fingerprint: string,
    lifecycle: string,
    lastChange: number,
  ): Effect.Effect<void, GatewayRepositoryError> {
    return repositoryEffect("config.saveRuntime", () => {
      this.sql.exec(
        `INSERT INTO gateway_container_runtime (singleton, auth_fingerprint, lifecycle, last_change)
         VALUES (1, ?, ?, ?)
         ON CONFLICT(singleton) DO UPDATE SET
           auth_fingerprint = excluded.auth_fingerprint,
           lifecycle = excluded.lifecycle,
           last_change = excluded.last_change`,
        fingerprint,
        lifecycle,
        lastChange,
      );
    });
  }
}

export const aliasConfig = (
  aliases: readonly GatewayAlias[],
  killed: boolean,
  revision: number,
  updatedAt: number,
): PersistedGatewayConfig => ({ aliases, killed, revision, updatedAt });

export type GatewayAliasOverride = {
  readonly tier: GatewayTier;
  readonly seat: GatewaySeat;
  readonly model: string;
};
