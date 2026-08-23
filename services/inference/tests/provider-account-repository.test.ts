import { DatabaseSync } from "node:sqlite";
import { Effect } from "effect";
import { afterEach, describe, expect, it } from "vitest";

import { DurableProviderAccountRepository } from "../src/provider-account-repository";

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
  const repository = new DurableProviderAccountRepository(makeSql(database), vaultKey);
  Effect.runSync(repository.initialize);
  return { database, repository };
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
    const { database, repository } = makeRepository();
    database.exec("CREATE TABLE gateway_auth_state (provider TEXT, token TEXT)");
    database.exec("INSERT INTO gateway_auth_state VALUES ('codex', 'legacy-plaintext')");
    const metadata = await Effect.runPromise(
      repository.put("codex", "personal", codexPayload("access-secret")),
    );

    expect(metadata).toMatchObject({
      provider: "codex",
      name: "personal",
      active: true,
      revision: 1,
    });
    await expect(Effect.runPromise(repository.list)).resolves.toEqual([metadata]);
    await expect(Effect.runPromise(repository.active("codex"))).resolves.toMatchObject({
      credential: { accessToken: "access-secret", refreshToken: "refresh-secret" },
    });
    const row = database.prepare("SELECT ciphertext FROM provider_accounts").get() as {
      ciphertext: string;
    };
    expect(row.ciphertext).not.toContain("access-secret");
    expect(row.ciphertext).not.toContain("refresh-secret");
    expect(
      database.prepare("SELECT name FROM sqlite_master WHERE name = 'gateway_auth_state'").get(),
    ).toBeUndefined();
  });

  it("increments revisions and deletes the active mapping with the account", async () => {
    const { repository } = makeRepository();
    await Effect.runPromise(repository.put("codex", "personal", codexPayload("first")));
    const second = await Effect.runPromise(
      repository.put("codex", "personal", codexPayload("second")),
    );
    expect(second.revision).toBe(2);

    await Effect.runPromise(repository.delete("codex", "personal"));
    await expect(Effect.runPromise(repository.list)).resolves.toEqual([]);
    await expect(Effect.runPromise(repository.active("codex"))).resolves.toBeUndefined();
  });

  it("fails closed when the vault key is missing", async () => {
    const database = new DatabaseSync(":memory:");
    databases.push(database);
    const repository = new DurableProviderAccountRepository(makeSql(database), undefined);
    Effect.runSync(repository.initialize);
    await expect(
      Effect.runPromise(repository.put("codex", "personal", codexPayload("secret"))),
    ).rejects.toMatchObject({ _tag: "GatewayRepositoryError" });
  });
});
