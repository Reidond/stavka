import { DatabaseSync } from "node:sqlite";
import { Effect } from "effect";
import { afterEach, describe, expect, it } from "vitest";

import { DurableProviderAccountRepository } from "../src/provider-account-repository";
import { DurableOrganizationRepository } from "../src/organization-repository";

const databases: DatabaseSync[] = [];
const vaultKey = Buffer.alloc(32, 7).toString("base64url");

const makeSql = (database: DatabaseSync): SqlStorage =>
  ({
    exec<T extends Record<string, SqlStorageValue>>(query: string, ...bindings: SqlStorageValue[]) {
      const statement = database.prepare(query);
      const command = query.trimStart().split(/\s/u, 1)[0]?.toUpperCase();
      const sqliteBindings = bindings.map((value) =>
        value instanceof ArrayBuffer ? new Uint8Array(value) : value,
      );
      const rows = command === "SELECT" ? statement.all(...sqliteBindings) : [];
      if (command !== "SELECT") statement.run(...sqliteBindings);
      return { toArray: () => rows as T[] };
    },
  }) as unknown as SqlStorage;

const makeRepository = () => {
  const database = new DatabaseSync(":memory:");
  databases.push(database);
  const sql = makeSql(database);
  const storage = {
    sql,
    transactionSync<T>(closure: () => T): T {
      database.exec("BEGIN");
      try {
        const result = closure();
        database.exec("COMMIT");
        return result;
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      }
    },
  };
  const organizations = new DurableOrganizationRepository(storage);
  Effect.runSync(organizations.initialize);
  database.exec(`
    INSERT INTO organizations VALUES ('organization-1', 'stavka', 'stavka-org', 'Stavka', 1, 1);
    INSERT INTO stavka_users VALUES ('user-1', 'access-owner', 'owner@example.test', 'Owner', 1, 1);
    INSERT INTO organization_memberships VALUES ('organization-1', 'user-1', 'owner', 1);
  `);
  const repository = new DurableProviderAccountRepository(sql, vaultKey);
  Effect.runSync(repository.initialize);
  return {
    database,
    repository,
    scope: { organizationId: "organization-1", userId: "user-1" },
  };
};

const codexPayload = (accessToken: string) => ({
  label: "Personal",
  authKind: "chatgpt-oauth" as const,
  credential: {
    kind: "codex-chatgpt-oauth" as const,
    accessToken,
    refreshToken: "refresh-secret",
    expiresAt: Date.now() + 60_000,
    accountId: "account-1",
  },
  activate: true,
});

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

describe("encrypted provider account repository", () => {
  it("encrypts credentials and exposes only public metadata when listing", async () => {
    const { database, repository, scope } = makeRepository();
    database.exec("CREATE TABLE gateway_auth_state (provider TEXT, token TEXT)");
    database.exec("INSERT INTO gateway_auth_state VALUES ('codex', 'legacy-plaintext')");
    database.exec(
      "CREATE TABLE provider_accounts (provider TEXT, name TEXT, ciphertext TEXT, iv TEXT)",
    );
    database.exec("CREATE TABLE active_provider_accounts (provider TEXT, name TEXT)");
    const metadata = await Effect.runPromise(
      repository.put(scope, "codex", "personal", codexPayload("access-secret")),
    );

    expect(metadata).toMatchObject({
      provider: "codex",
      name: "personal",
      active: true,
      revision: 1,
      owner: { id: "user-1", displayName: "Owner", email: "owner@example.test" },
      organization: { id: "organization-1", name: "Stavka" },
    });
    await expect(Effect.runPromise(repository.list(scope))).resolves.toEqual([metadata]);
    await expect(Effect.runPromise(repository.active(scope, "codex"))).resolves.toMatchObject({
      credential: { accessToken: "access-secret", refreshToken: "refresh-secret" },
    });
    const row = database.prepare("SELECT ciphertext FROM organization_provider_accounts").get() as {
      ciphertext: string;
    };
    expect(row.ciphertext).not.toContain("access-secret");
    expect(row.ciphertext).not.toContain("refresh-secret");
    expect(
      database.prepare("SELECT name FROM sqlite_master WHERE name = 'gateway_auth_state'").get(),
    ).toBeUndefined();
    expect(
      database.prepare("SELECT name FROM sqlite_master WHERE name = 'provider_accounts'").get(),
    ).toBeUndefined();
    expect(
      database
        .prepare("SELECT name FROM sqlite_master WHERE name = 'active_provider_accounts'")
        .get(),
    ).toBeUndefined();
  });

  it("increments revisions and deletes the active mapping with the account", async () => {
    const { repository, scope } = makeRepository();
    await Effect.runPromise(repository.put(scope, "codex", "personal", codexPayload("first")));
    const second = await Effect.runPromise(
      repository.put(scope, "codex", "personal", codexPayload("second")),
    );
    expect(second.revision).toBe(2);

    await Effect.runPromise(repository.delete(scope, "codex", "personal"));
    await expect(Effect.runPromise(repository.list(scope))).resolves.toEqual([]);
    await expect(Effect.runPromise(repository.active(scope, "codex"))).resolves.toBeUndefined();
  });

  it("isolates provider accounts by organization membership owner", async () => {
    const { database, repository, scope } = makeRepository();
    database.exec(`
      INSERT INTO stavka_users VALUES ('user-2', 'access-user-2', 'user2@example.test', 'User Two', 1, 1);
      INSERT INTO organization_memberships VALUES ('organization-1', 'user-2', 'member', 1);
    `);
    const otherScope = { organizationId: "organization-1", userId: "user-2" };

    await Effect.runPromise(repository.put(scope, "codex", "personal", codexPayload("owner")));
    await Effect.runPromise(repository.put(otherScope, "codex", "personal", codexPayload("other")));

    await expect(Effect.runPromise(repository.list(scope))).resolves.toHaveLength(1);
    await expect(Effect.runPromise(repository.list(otherScope))).resolves.toMatchObject([
      { owner: { id: "user-2", displayName: "User Two" } },
    ]);
    await expect(
      Effect.runPromise(
        repository.read(
          { organizationId: "organization-1", userId: "missing-user" },
          "codex",
          "personal",
        ),
      ),
    ).resolves.toBeUndefined();
    await expect(Effect.runPromise(repository.activeForRuntime("codex"))).rejects.toMatchObject({
      _tag: "GatewayRepositoryError",
    });
  });

  it("fails closed when the vault key is missing", async () => {
    const database = new DatabaseSync(":memory:");
    databases.push(database);
    const sql = makeSql(database);
    database.exec(`
      CREATE TABLE organizations (id TEXT PRIMARY KEY, name TEXT);
      CREATE TABLE stavka_users (id TEXT PRIMARY KEY, display_name TEXT, email TEXT);
      INSERT INTO organizations VALUES ('organization-1', 'Stavka');
      INSERT INTO stavka_users VALUES ('user-1', 'Owner', 'owner@example.test');
    `);
    const repository = new DurableProviderAccountRepository(sql, undefined);
    Effect.runSync(repository.initialize);
    await expect(
      Effect.runPromise(
        repository.put(
          { organizationId: "organization-1", userId: "user-1" },
          "codex",
          "personal",
          codexPayload("secret"),
        ),
      ),
    ).rejects.toMatchObject({ _tag: "GatewayRepositoryError" });
  });
});
