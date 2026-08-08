import { DatabaseSync } from "node:sqlite";
import { Effect } from "effect";
import { afterEach, describe, expect, it } from "vitest";

import { DurableAuthStateRepository } from "../src/auth-state-repository";

const databases: DatabaseSync[] = [];

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

const makeRepository = (): {
  readonly database: DatabaseSync;
  readonly repository: DurableAuthStateRepository;
} => {
  const database = new DatabaseSync(":memory:");
  databases.push(database);
  const repository = new DurableAuthStateRepository(makeSql(database));
  Effect.runSync(repository.initialize);
  return { database, repository };
};

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

describe("gateway auth state repository", () => {
  it("persists provider credentials privately and lists them for restart injection", async () => {
    const { repository } = makeRepository();

    const persisted = await Effect.runPromise(
      repository.replace("claude", "subscription-secret", "a".repeat(64), 10),
    );
    expect(persisted).toMatchObject({
      provider: "claude",
      token: "subscription-secret",
      fingerprint: "a".repeat(64),
      revision: 1,
      updatedAt: 10,
    });

    await expect(Effect.runPromise(repository.read("claude"))).resolves.toEqual(persisted);
    await expect(Effect.runPromise(repository.list)).resolves.toEqual([persisted]);
  });

  it("clears a provider without leaving residual rows", async () => {
    const { repository } = makeRepository();
    await Effect.runPromise(repository.replace("codex", "token", "b".repeat(64), 11));
    await Effect.runPromise(repository.clear("codex"));

    await expect(Effect.runPromise(repository.read("codex"))).resolves.toBeUndefined();
    await expect(Effect.runPromise(repository.list)).resolves.toEqual([]);
  });

  it("increments revision on replace so operators can observe rotation", async () => {
    const { repository } = makeRepository();
    await Effect.runPromise(repository.replace("claude", "first", "c".repeat(64), 1));
    const second = await Effect.runPromise(
      repository.replace("claude", "second", "d".repeat(64), 2),
    );

    expect(second.revision).toBe(2);
    expect(second.token).toBe("second");
  });
});
