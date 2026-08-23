import { DatabaseSync } from "node:sqlite";
import { Effect } from "effect";
import { afterEach, describe, expect, it } from "vitest";

import { HOSTED_REQUEST_LOG_LIMIT, SeatStateRepository } from "../src/seat-state-repository";

const databases: DatabaseSync[] = [];
const vaultKey = Buffer.alloc(32, 5).toString("base64url");

const makeRepository = (): {
  readonly database: DatabaseSync;
  readonly repository: SeatStateRepository;
} => {
  const database = new DatabaseSync(":memory:");
  databases.push(database);
  const sql = {
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
  } as unknown as SqlStorage;
  const repository = new SeatStateRepository(sql, vaultKey);
  Effect.runSync(repository.initialize);
  return { database, repository };
};

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

describe("hosted seat control and request metadata persistence", () => {
  it("encrypts CLI-provisioned named provider accounts and removes legacy plaintext state", async () => {
    const { repository, database } = makeRepository();
    database.exec("CREATE TABLE seat_auth_state (provider TEXT, token TEXT)");
    database.exec("INSERT INTO seat_auth_state VALUES ('codex', 'legacy-plaintext')");
    const credential = {
      kind: "codex-chatgpt-oauth" as const,
      accessToken: "access-secret",
      refreshToken: "refresh-secret",
      expiresAt: Date.now() + 60_000,
      accountId: "account-1",
    };
    const encoded = Buffer.from(JSON.stringify(credential), "utf8").toString("base64url");

    const metadata = await Effect.runPromise(
      repository.putProviderAccount(
        "codex",
        "work",
        { label: "Work", authKind: "chatgpt-oauth", credential, activate: true },
        encoded,
        "a".repeat(64),
        42,
      ),
    );

    expect(metadata).toMatchObject({ provider: "codex", name: "work", revision: 1, active: true });
    await expect(Effect.runPromise(repository.listProviderAccounts())).resolves.toEqual([metadata]);
    await expect(Effect.runPromise(repository.readAuth("codex"))).resolves.toMatchObject({
      token: encoded,
    });
    const ciphertext = database.prepare("SELECT ciphertext FROM seat_provider_account").get() as {
      ciphertext: string;
    };
    expect(ciphertext.ciphertext).not.toContain("access-secret");
    expect(ciphertext.ciphertext).not.toContain("refresh-secret");
    expect(
      database.prepare("SELECT name FROM sqlite_master WHERE name = 'seat_auth_state'").get(),
    ).toBeUndefined();
  });

  it("persists a leaf kill switch and model-only overrides across repository instances", async () => {
    const { repository, database } = makeRepository();
    const configured = {
      "stavka/sergeant": "gpt-5.6-luna",
      "stavka/heavy": "gpt-5.6-terra",
    };

    await Effect.runPromise(
      repository.remapAlias("stavka/heavy", "gpt-5.6-terra-r2", configured, 40),
    );
    await Effect.runPromise(repository.setKilled(true, 41));

    const restored = new SeatStateRepository(
      {
        exec<T extends Record<string, SqlStorageValue>>(
          query: string,
          ...bindings: SqlStorageValue[]
        ) {
          const statement = database.prepare(query);
          const command = query.trimStart().split(/\s/u, 1)[0]?.toUpperCase();
          const sqliteBindings = bindings.map((value) =>
            value instanceof ArrayBuffer ? new Uint8Array(value) : value,
          );
          const rows = command === "SELECT" ? statement.all(...sqliteBindings) : [];
          if (command !== "SELECT") statement.run(...sqliteBindings);
          return { toArray: () => rows as T[] };
        },
      } as unknown as SqlStorage,
      vaultKey,
    );

    await expect(Effect.runPromise(restored.readControls(configured))).resolves.toEqual({
      killed: true,
      aliases: {
        "stavka/sergeant": "gpt-5.6-luna",
        "stavka/heavy": "gpt-5.6-terra-r2",
      },
      updatedAt: 41,
    });
    await expect(
      Effect.runPromise(
        restored.readControls({
          "stavka/sergeant": "gpt-5.6-luna-r2",
          "stavka/commander": "gpt-5.6-terra",
        }),
      ),
    ).resolves.toMatchObject({
      aliases: {
        "stavka/sergeant": "gpt-5.6-luna-r2",
        "stavka/commander": "gpt-5.6-terra",
      },
    });
  });

  it("retains only bounded request metadata columns", async () => {
    const { repository, database } = makeRepository();
    await Effect.runPromise(
      Effect.forEach(
        Array.from({ length: HOSTED_REQUEST_LOG_LIMIT + 5 }, (_, index) => index),
        (index) =>
          repository.recordRequest({
            request_id: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
            timestamp: index,
            dialect: "openai-responses",
            alias: "stavka/heavy",
            model: "gpt-5.6-terra",
            status: 200,
            latency_ms: index,
            queue_depth: 0,
          }),
        { concurrency: 1 },
      ),
    );

    await expect(Effect.runPromise(repository.countRequests)).resolves.toBe(
      HOSTED_REQUEST_LOG_LIMIT,
    );
    await expect(Effect.runPromise(repository.listRecentRequests(2))).resolves.toMatchObject([
      { timestamp: 204, alias: "stavka/heavy", model: "gpt-5.6-terra" },
      { timestamp: 203, alias: "stavka/heavy", model: "gpt-5.6-terra" },
    ]);
    const columns = database
      .prepare("SELECT name FROM pragma_table_info('seat_request_log') ORDER BY cid")
      .all()
      .map((row) => String(row.name));
    expect(columns).toEqual([
      "request_id",
      "timestamp",
      "dialect",
      "alias",
      "model",
      "status",
      "latency_ms",
      "queue_depth",
    ]);
    expect(columns).not.toEqual(
      expect.arrayContaining(["prompt", "body", "authorization", "error"]),
    );
  });
});
