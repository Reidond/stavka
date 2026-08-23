import type {
  ProviderAccountPublic,
  ProviderCredential,
  ProviderId,
  ProvisionProviderAccountPayload,
} from "@stavka/provider-auth";
import { Effect, Schema } from "effect";

import { ProviderCredentialSchema } from "@stavka/provider-auth";
import { GatewayRepositoryError, repositoryEffect } from "./gateway-repository-error";

interface ProviderAccountRow extends Record<string, SqlStorageValue> {
  readonly provider: string;
  readonly name: string;
  readonly label: string;
  readonly auth_kind: string;
  readonly ciphertext: string;
  readonly iv: string;
  readonly remote_account_id: string | null;
  readonly remote_workspace_id: string | null;
  readonly revision: number;
  readonly created_at: number;
  readonly updated_at: number;
  readonly active: number;
}

export interface PersistedProviderAccount extends ProviderAccountPublic {
  readonly credential: ProviderCredential;
}

const base64 = (bytes: Uint8Array): string => {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
};

const fromBase64 = (value: string): Uint8Array => {
  const normalized = value.replace(/-/gu, "+").replace(/_/gu, "/");
  const binary = atob(normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "="));
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
};

const asArrayBuffer = (bytes: Uint8Array): ArrayBuffer => bytes.slice().buffer as ArrayBuffer;

const vaultError = (operation: string, cause: unknown): GatewayRepositoryError =>
  new GatewayRepositoryError({
    operation,
    message: cause instanceof Error ? cause.message : String(cause),
  });

const importVaultKey = (encoded: string): Effect.Effect<CryptoKey, GatewayRepositoryError> =>
  Effect.tryPromise({
    try: async () => {
      const raw = fromBase64(encoded.trim());
      if (raw.byteLength !== 32) throw new Error("STAVKA_PROVIDER_VAULT_KEY must encode 32 bytes");
      return crypto.subtle.importKey("raw", asArrayBuffer(raw), { name: "AES-GCM" }, false, [
        "encrypt",
        "decrypt",
      ]);
    },
    catch: (cause) => vaultError("provider-accounts.key", cause),
  });

const additionalData = (provider: ProviderId, name: string): Uint8Array =>
  new TextEncoder().encode(`stavka-provider-account:v1:${provider}/${name}`);

const encryptCredential = (
  provider: ProviderId,
  name: string,
  credential: ProviderCredential,
  key: CryptoKey,
): Effect.Effect<{ readonly ciphertext: string; readonly iv: string }, GatewayRepositoryError> =>
  Effect.tryPromise({
    try: async () => {
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const plaintext = new TextEncoder().encode(JSON.stringify(credential));
      const ciphertext = await crypto.subtle.encrypt(
        {
          name: "AES-GCM",
          iv: asArrayBuffer(iv),
          additionalData: asArrayBuffer(additionalData(provider, name)),
          tagLength: 128,
        },
        key,
        plaintext,
      );
      return { ciphertext: base64(new Uint8Array(ciphertext)), iv: base64(iv) };
    },
    catch: (cause) => vaultError("provider-accounts.encrypt", cause),
  });

const decryptCredential = (
  row: ProviderAccountRow,
  key: CryptoKey,
): Effect.Effect<ProviderCredential, GatewayRepositoryError> =>
  Effect.tryPromise({
    try: async () => {
      const plaintext = await crypto.subtle.decrypt(
        {
          name: "AES-GCM",
          iv: asArrayBuffer(fromBase64(row.iv)),
          additionalData: asArrayBuffer(additionalData(row.provider as ProviderId, row.name)),
          tagLength: 128,
        },
        key,
        asArrayBuffer(fromBase64(row.ciphertext)),
      );
      return Schema.decodeUnknownSync(ProviderCredentialSchema)(
        JSON.parse(new TextDecoder().decode(plaintext)) as unknown,
      );
    },
    catch: (cause) => vaultError("provider-accounts.decrypt", cause),
  });

const publicFromRow = (row: ProviderAccountRow): ProviderAccountPublic => ({
  provider: row.provider as ProviderId,
  name: row.name,
  label: row.label,
  authKind: row.auth_kind as ProviderAccountPublic["authKind"],
  ...(row.remote_account_id ? { remoteAccountId: row.remote_account_id } : {}),
  ...(row.remote_workspace_id ? { remoteWorkspaceId: row.remote_workspace_id } : {}),
  active: row.active === 1,
  revision: row.revision,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

export class DurableProviderAccountRepository {
  constructor(
    private readonly sql: SqlStorage,
    private readonly vaultKey: string | undefined,
  ) {}

  readonly initialize = repositoryEffect("provider-accounts.initialize", () => {
    this.sql.exec(`CREATE TABLE IF NOT EXISTS provider_accounts (
      provider TEXT NOT NULL,
      name TEXT NOT NULL,
      label TEXT NOT NULL,
      auth_kind TEXT NOT NULL,
      ciphertext TEXT NOT NULL,
      iv TEXT NOT NULL,
      remote_account_id TEXT,
      remote_workspace_id TEXT,
      revision INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY(provider, name)
    )`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS active_provider_accounts (
      provider TEXT PRIMARY KEY,
      name TEXT NOT NULL
    )`);
  });

  private rows(where = "", ...bindings: SqlStorageValue[]): readonly ProviderAccountRow[] {
    return this.sql
      .exec<ProviderAccountRow>(
        `SELECT a.provider, a.name, a.label, a.auth_kind, a.ciphertext, a.iv,
                a.remote_account_id, a.remote_workspace_id, a.revision,
                a.created_at, a.updated_at,
                CASE WHEN active.name = a.name THEN 1 ELSE 0 END AS active
         FROM provider_accounts a
         LEFT JOIN active_provider_accounts active ON active.provider = a.provider
         ${where}
         ORDER BY a.provider, a.name`,
        ...bindings,
      )
      .toArray();
  }

  readonly list: Effect.Effect<readonly ProviderAccountPublic[], GatewayRepositoryError> =
    repositoryEffect("provider-accounts.list", () => this.rows().map(publicFromRow));

  read(
    provider: ProviderId,
    name: string,
  ): Effect.Effect<PersistedProviderAccount | undefined, GatewayRepositoryError> {
    return Effect.gen({ self: this }, function* () {
      const row = yield* repositoryEffect(
        "provider-accounts.read",
        () => this.rows("WHERE a.provider = ? AND a.name = ?", provider, name)[0],
      );
      if (!row) return undefined;
      if (!this.vaultKey)
        return yield* Effect.fail(
          new GatewayRepositoryError({
            operation: "provider-accounts.read",
            message: "STAVKA_PROVIDER_VAULT_KEY is not configured",
          }),
        );
      const key = yield* importVaultKey(this.vaultKey);
      const credential = yield* decryptCredential(row, key);
      return { ...publicFromRow(row), credential };
    });
  }

  active(
    provider: ProviderId,
  ): Effect.Effect<PersistedProviderAccount | undefined, GatewayRepositoryError> {
    return Effect.gen({ self: this }, function* () {
      const name = yield* repositoryEffect(
        "provider-accounts.active",
        () =>
          this.sql
            .exec<{ readonly name: string }>(
              `SELECT name FROM active_provider_accounts WHERE provider = ? LIMIT 1`,
              provider,
            )
            .toArray()[0]?.name,
      );
      return name ? yield* this.read(provider, name) : undefined;
    });
  }

  put(
    provider: ProviderId,
    name: string,
    payload: ProvisionProviderAccountPayload,
  ): Effect.Effect<ProviderAccountPublic, GatewayRepositoryError> {
    return Effect.gen({ self: this }, function* () {
      if (!this.vaultKey)
        return yield* Effect.fail(
          new GatewayRepositoryError({
            operation: "provider-accounts.put",
            message: "STAVKA_PROVIDER_VAULT_KEY is not configured",
          }),
        );
      const key = yield* importVaultKey(this.vaultKey);
      const encrypted = yield* encryptCredential(provider, name, payload.credential, key);
      const now = Date.now();
      yield* repositoryEffect("provider-accounts.put", () => {
        this.sql.exec(
          `INSERT INTO provider_accounts (
             provider, name, label, auth_kind, ciphertext, iv,
             remote_account_id, remote_workspace_id, revision, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
           ON CONFLICT(provider, name) DO UPDATE SET
             label = excluded.label,
             auth_kind = excluded.auth_kind,
             ciphertext = excluded.ciphertext,
             iv = excluded.iv,
             remote_account_id = excluded.remote_account_id,
             remote_workspace_id = excluded.remote_workspace_id,
             revision = provider_accounts.revision + 1,
             updated_at = excluded.updated_at`,
          provider,
          name,
          payload.label,
          payload.authKind,
          encrypted.ciphertext,
          encrypted.iv,
          payload.remoteAccountId ?? null,
          payload.remoteWorkspaceId ?? null,
          now,
          now,
        );
        if (payload.activate === true) {
          this.sql.exec(
            `INSERT INTO active_provider_accounts (provider, name) VALUES (?, ?)
             ON CONFLICT(provider) DO UPDATE SET name = excluded.name`,
            provider,
            name,
          );
        }
        // Retire the former plaintext token table only after encrypted persistence succeeds.
        this.sql.exec(`DROP TABLE IF EXISTS gateway_auth_state`);
      });
      const stored = yield* repositoryEffect(
        "provider-accounts.put.read",
        () => this.rows("WHERE a.provider = ? AND a.name = ?", provider, name)[0],
      );
      if (!stored)
        return yield* Effect.fail(
          new GatewayRepositoryError({
            operation: "provider-accounts.put",
            message: "Provider account was unavailable after persistence",
          }),
        );
      return publicFromRow(stored);
    });
  }

  activate(
    provider: ProviderId,
    name: string,
  ): Effect.Effect<ProviderAccountPublic, GatewayRepositoryError> {
    return Effect.gen({ self: this }, function* () {
      const exists = yield* repositoryEffect(
        "provider-accounts.activate.read",
        () => this.rows("WHERE a.provider = ? AND a.name = ?", provider, name)[0],
      );
      if (!exists)
        return yield* Effect.fail(
          new GatewayRepositoryError({
            operation: "provider-accounts.activate",
            message: `Unknown provider account ${provider}/${name}`,
          }),
        );
      yield* repositoryEffect("provider-accounts.activate", () => {
        this.sql.exec(
          `INSERT INTO active_provider_accounts (provider, name) VALUES (?, ?)
           ON CONFLICT(provider) DO UPDATE SET name = excluded.name`,
          provider,
          name,
        );
      });
      return { ...publicFromRow(exists), active: true };
    });
  }

  delete(provider: ProviderId, name: string): Effect.Effect<void, GatewayRepositoryError> {
    return repositoryEffect("provider-accounts.delete", () => {
      this.sql.exec(
        `DELETE FROM active_provider_accounts WHERE provider = ? AND name = ?`,
        provider,
        name,
      );
      this.sql.exec(
        `DELETE FROM provider_accounts WHERE provider = ? AND name = ?`,
        provider,
        name,
      );
    });
  }
}
