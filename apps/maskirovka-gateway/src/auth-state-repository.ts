import { Context, Effect } from "effect";

import { gatewayProviders, type GatewayProvider } from "./config";
import { GatewayRepositoryError, repositoryEffect } from "./gateway-repository-error";

interface AuthRow extends Record<string, SqlStorageValue> {
  readonly provider: string;
  readonly token: string;
  readonly fingerprint: string;
  readonly revision: number;
  readonly updated_at: number;
}

export interface PersistedGatewayAuth {
  readonly provider: GatewayProvider;
  readonly token: string;
  readonly fingerprint: string;
  readonly revision: number;
  readonly updatedAt: number;
}

export interface GatewayAuthMetadata {
  readonly provider: GatewayProvider;
  readonly configured: boolean;
  readonly persisted: boolean;
  readonly revision: number;
  readonly updated_at?: number;
}

export class AuthStateRepository extends Context.Service<
  AuthStateRepository,
  AuthStateRepositoryService
>()("stavka/maskirovka-gateway/AuthStateRepository") {}

export interface AuthStateRepositoryService {
  readonly initialize: Effect.Effect<void, GatewayRepositoryError>;
  readonly read: (
    provider: GatewayProvider,
  ) => Effect.Effect<PersistedGatewayAuth | undefined, GatewayRepositoryError>;
  readonly list: Effect.Effect<readonly PersistedGatewayAuth[], GatewayRepositoryError>;
  readonly replace: (
    provider: GatewayProvider,
    token: string,
    fingerprint: string,
    updatedAt: number,
  ) => Effect.Effect<PersistedGatewayAuth, GatewayRepositoryError>;
  readonly clear: (provider: GatewayProvider) => Effect.Effect<void, GatewayRepositoryError>;
}

export class DurableAuthStateRepository implements AuthStateRepositoryService {
  constructor(private readonly sql: SqlStorage) {}

  readonly initialize = repositoryEffect("auth.initialize", () => {
    this.sql.exec(`CREATE TABLE IF NOT EXISTS gateway_auth_state (
      provider TEXT PRIMARY KEY,
      token TEXT NOT NULL,
      fingerprint TEXT NOT NULL,
      revision INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )`);
  });

  read(
    provider: GatewayProvider,
  ): Effect.Effect<PersistedGatewayAuth | undefined, GatewayRepositoryError> {
    return repositoryEffect("auth.read", () => {
      const row = this.sql
        .exec<AuthRow>(
          `SELECT provider, token, fingerprint, revision, updated_at
           FROM gateway_auth_state WHERE provider = ? LIMIT 1`,
          provider,
        )
        .toArray()[0];
      if (!row) return undefined;
      return {
        provider: row.provider as GatewayProvider,
        token: row.token,
        fingerprint: row.fingerprint,
        revision: row.revision,
        updatedAt: row.updated_at,
      };
    });
  }

  readonly list: Effect.Effect<readonly PersistedGatewayAuth[], GatewayRepositoryError> =
    repositoryEffect("auth.list", () =>
      this.sql
        .exec<AuthRow>(
          `SELECT provider, token, fingerprint, revision, updated_at
           FROM gateway_auth_state ORDER BY provider`,
        )
        .toArray()
        .filter((row) => gatewayProviders.includes(row.provider as GatewayProvider))
        .map((row) => ({
          provider: row.provider as GatewayProvider,
          token: row.token,
          fingerprint: row.fingerprint,
          revision: row.revision,
          updatedAt: row.updated_at,
        })),
    );

  replace(
    provider: GatewayProvider,
    token: string,
    fingerprint: string,
    updatedAt: number,
  ): Effect.Effect<PersistedGatewayAuth, GatewayRepositoryError> {
    return Effect.gen({ self: this }, function* () {
      yield* repositoryEffect("auth.replace", () => {
        this.sql.exec(
          `INSERT INTO gateway_auth_state (provider, token, fingerprint, revision, updated_at)
           VALUES (?, ?, ?, 1, ?)
           ON CONFLICT(provider) DO UPDATE SET
             token = excluded.token,
             fingerprint = excluded.fingerprint,
             revision = gateway_auth_state.revision + 1,
             updated_at = excluded.updated_at`,
          provider,
          token,
          fingerprint,
          updatedAt,
        );
      });
      const persisted = yield* this.read(provider);
      if (!persisted) {
        return yield* Effect.fail(
          new GatewayRepositoryError({
            operation: "auth.replace",
            message: "Auth state was not available after persistence",
          }),
        );
      }
      return persisted;
    });
  }

  clear(provider: GatewayProvider): Effect.Effect<void, GatewayRepositoryError> {
    return repositoryEffect("auth.clear", () => {
      this.sql.exec(`DELETE FROM gateway_auth_state WHERE provider = ?`, provider);
    });
  }
}
