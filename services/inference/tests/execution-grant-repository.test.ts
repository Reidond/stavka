import { DatabaseSync } from "node:sqlite";
import { Effect } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import { DurableOrganizationRepository } from "../src/organization-repository";
import { DurableExecutionGrantRepository } from "../src/execution-grant-repository";

const databases: DatabaseSync[] = [];
const session = { session_id: "native-session", mission_epoch: 1, faction: "OPFOR" };
const input = { ...session, duration_minutes: 1, request_limit: 2 };
const fixture = () => {
  const database = new DatabaseSync(":memory:");
  databases.push(database);
  database.exec("PRAGMA foreign_keys = ON");
  const storage = {
    sql: {
      exec(query: string, ...bindings: SqlStorageValue[]) {
        const statement = database.prepare(query);
        const values = bindings.map((value) =>
          value instanceof ArrayBuffer ? new Uint8Array(value) : value,
        );
        const rows = /^\s*SELECT/iu.test(query)
          ? statement.all(...values)
          : (statement.run(...values), []);
        return { toArray: () => rows };
      },
    } as unknown as SqlStorage,
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
  const account = Effect.runSync(
    organizations.signUp(
      { subject: "owner", accessRole: "owner" },
      { displayName: "Owner", organizationName: "Test" },
    ),
  );
  const scope = { organizationId: account.organization.id, userId: account.user.id };
  const grants = new DurableExecutionGrantRepository(storage);
  Effect.runSync(grants.initialize);
  return { database, storage, grants, scope };
};
afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

describe("owner-authorized Commander sessions", () => {
  it("fails closed before approval and keeps exact mission/faction boundaries", async () => {
    const { grants, scope } = fixture();
    await expect(Effect.runPromise(grants.consume(session, 1000))).rejects.toMatchObject({
      code: "EXECUTION_NOT_AUTHORIZED",
    });
    const grant = await Effect.runPromise(grants.authorize(scope, input, 1000));
    expect(grant).toMatchObject({ status: "active", expires_at: 61000, requests_used: 0 });
    for (const other of [
      { ...session, mission_epoch: 2 },
      { ...session, faction: "BLUFOR" },
      { ...session, session_id: "other" },
    ])
      await expect(Effect.runPromise(grants.consume(other, 1100))).rejects.toMatchObject({
        code: "EXECUTION_NOT_AUTHORIZED",
      });
    expect((await Effect.runPromise(grants.consume(session, 1200))).scope).toEqual(scope);
  });

  it("atomically bounds requests across concurrent calls and repository restart", async () => {
    const { grants, scope, storage } = fixture();
    await Effect.runPromise(grants.authorize(scope, input, 1000));
    const restarted = new DurableExecutionGrantRepository(storage);
    const outcomes = await Promise.allSettled(
      Array.from({ length: 5 }, () => Effect.runPromise(restarted.consume(session, 1200))),
    );
    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(2);
    expect(await Effect.runPromise(restarted.read(scope, session, 1200))).toMatchObject({
      status: "exhausted",
      requests_used: 2,
    });
  });

  it("invalidates pending execution after revoke, renewal, expiry or membership removal", async () => {
    const { grants, scope, database } = fixture();
    await Effect.runPromise(grants.authorize(scope, input, 1000));
    const permit = await Effect.runPromise(grants.consume(session, 1001));
    await Effect.runPromise(grants.revoke(scope, session, 1002));
    await expect(
      Effect.runPromise(grants.verifyReserved(session, permit.grantId, 1003)),
    ).rejects.toMatchObject({ code: "EXECUTION_NOT_AUTHORIZED" });
    await Effect.runPromise(grants.authorize(scope, input, 2000));
    await expect(
      Effect.runPromise(grants.verifyReserved(session, permit.grantId, 2001)),
    ).rejects.toMatchObject({ code: "EXECUTION_NOT_AUTHORIZED" });
    const renewed = await Effect.runPromise(grants.consume(session, 2002));
    await expect(
      Effect.runPromise(grants.verifyReserved(session, renewed.grantId, 62000)),
    ).rejects.toMatchObject({ code: "EXECUTION_NOT_AUTHORIZED" });
    database
      .prepare("UPDATE organization_memberships SET role = 'member' WHERE user_id = ?")
      .run(scope.userId);
    await expect(
      Effect.runPromise(grants.verifyReserved(session, renewed.grantId, 2003)),
    ).rejects.toMatchObject({ code: "EXECUTION_NOT_AUTHORIZED" });
    await expect(Effect.runPromise(grants.authorize(scope, input, 2004))).rejects.toMatchObject({
      code: "EXECUTION_NOT_AUTHORIZED",
    });
  });

  it("prevents another admin from reading, replacing or revoking the owner's grant", async () => {
    const { grants, scope, database } = fixture();
    await Effect.runPromise(grants.authorize(scope, input, 1000));
    database
      .prepare(
        "INSERT INTO stavka_users (id, access_subject, display_name, created_at, updated_at) VALUES ('second', 'second', 'Second', 1, 1)",
      )
      .run();
    database
      .prepare(
        "INSERT INTO organization_memberships (organization_id, user_id, role, joined_at) VALUES (?, 'second', 'admin', 1)",
      )
      .run(scope.organizationId);
    const other = { ...scope, userId: "second" };
    for (const operation of [
      grants.read(other, session, 1001),
      grants.authorize(other, input, 1001),
      grants.revoke(other, session, 1001),
    ])
      await expect(Effect.runPromise(operation)).rejects.toMatchObject({
        code: "EXECUTION_OWNED_BY_ANOTHER_USER",
      });
    expect(await Effect.runPromise(grants.read(scope, session, 1002))).toMatchObject({
      status: "active",
      requests_used: 0,
    });
  });
});
