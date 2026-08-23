import { DatabaseSync } from "node:sqlite";
import { Effect } from "effect";
import { afterEach, describe, expect, it } from "vitest";

import { DurableOrganizationRepository } from "../src/organization-repository";

const databases: DatabaseSync[] = [];

const makeSql = (database: DatabaseSync): SqlStorage =>
  ({
    exec<T extends Record<string, SqlStorageValue>>(query: string, ...bindings: SqlStorageValue[]) {
      const statement = database.prepare(query);
      const command = query.trimStart().split(/\s/u, 1)[0]?.toUpperCase();
      const values = bindings.map((value) =>
        value instanceof ArrayBuffer ? new Uint8Array(value) : value,
      );
      const rows = command === "SELECT" ? statement.all(...values) : [];
      if (command !== "SELECT") statement.run(...values);
      return { toArray: () => rows as T[] };
    },
  }) as unknown as SqlStorage;

const makeRepository = () => {
  const database = new DatabaseSync(":memory:");
  databases.push(database);
  const sql = makeSql(database);
  const repository = new DurableOrganizationRepository({
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
  });
  Effect.runSync(repository.initialize);
  return { database, repository };
};

const owner = {
  subject: "access-owner",
  email: "owner@example.test",
  accessRole: "owner" as const,
};

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

describe("organization repository", () => {
  it("creates one private owner profile from the verified Access identity", async () => {
    const { repository } = makeRepository();

    await expect(Effect.runPromise(repository.session(owner))).resolves.toEqual({
      status: "setup_required",
      identity: { email: "owner@example.test", accessRole: "owner" },
      canSignUp: true,
    });

    const session = await Effect.runPromise(
      repository.signUp(owner, { displayName: "Andrii Shafar", organizationName: "Stavka" }),
    );
    expect(session).toMatchObject({
      status: "active",
      user: { displayName: "Andrii Shafar", email: "owner@example.test" },
      organization: { name: "Stavka" },
      membership: { role: "owner" },
    });
    await expect(
      Effect.runPromise(
        repository.listUsers({
          organizationId: session.organization.id,
          userId: session.user.id,
        }),
      ),
    ).resolves.toEqual([{ user: session.user, membership: session.membership }]);
  });

  it("closes self-registration after the owner organization exists", async () => {
    const { repository } = makeRepository();
    const first = await Effect.runPromise(
      repository.signUp(owner, { displayName: "Owner", organizationName: "Stavka" }),
    );
    const outsider = {
      subject: "access-outsider",
      email: "outsider@example.test",
      accessRole: "owner" as const,
    };

    await expect(Effect.runPromise(repository.session(outsider))).resolves.toMatchObject({
      status: "setup_required",
      canSignUp: false,
    });
    await expect(
      Effect.runPromise(
        repository.signUp(outsider, { displayName: "Outsider", organizationName: "Other" }),
      ),
    ).rejects.toMatchObject({ _tag: "GatewayRepositoryError" });
    await expect(
      Effect.runPromise(
        repository.listUsers({
          organizationId: first.organization.id,
          userId: "not-a-member",
        }),
      ),
    ).resolves.toEqual([]);
  });

  it("does not let a non-owner Access role bootstrap the organization", async () => {
    const { repository } = makeRepository();
    await expect(
      Effect.runPromise(
        repository.session({
          subject: "access-spectator",
          email: "spectator@example.test",
          accessRole: "spectator",
        }),
      ),
    ).resolves.toMatchObject({ status: "setup_required", canSignUp: false });
  });
});
