import type { AccountScope } from "@stavka/access-auth";
import { AuthorizeExecution, ExecutionGrant, ExecutionSession } from "@stavka/protocol";
import { Data, Effect, Schema } from "effect";
import { GatewayRepositoryError } from "./gateway-repository-error";

export class ExecutionAuthorizationError extends Data.TaggedError("ExecutionAuthorizationError")<{
  readonly code: "EXECUTION_NOT_AUTHORIZED" | "EXECUTION_OWNED_BY_ANOTHER_USER";
  readonly message: string;
}> {}

interface GrantStorage {
  readonly sql: SqlStorage;
  readonly transactionSync: <T>(operation: () => T) => T;
}

interface GrantRow extends Record<string, SqlStorageValue> {
  readonly session_id: string;
  readonly mission_epoch: number;
  readonly faction: string;
  readonly grant_id: string;
  readonly organization_id: string;
  readonly owner_user_id: string;
  readonly authorized_at: number;
  readonly expires_at: number;
  readonly request_limit: number;
  readonly requests_used: number;
  readonly revoked: number;
}

const denied = () =>
  new ExecutionAuthorizationError({
    code: "EXECUTION_NOT_AUTHORIZED",
    message:
      "An owner must enable AI for this session; authorization is missing, expired, revoked or exhausted.",
  });
const operation = <A>(name: string, evaluate: () => A) =>
  Effect.try({
    try: evaluate,
    catch: (cause) =>
      cause instanceof ExecutionAuthorizationError
        ? cause
        : new GatewayRepositoryError({
            operation: `execution-grants.${name}`,
            message: "AI session authorization storage failed",
            cause,
          }),
  });
const publicGrant = (row: GrantRow, now: number): ExecutionGrant =>
  Schema.decodeUnknownSync(ExecutionGrant)({
    session_id: row.session_id,
    mission_epoch: row.mission_epoch,
    faction: row.faction,
    grant_id: row.grant_id,
    authorized_at: row.authorized_at,
    expires_at: row.expires_at,
    request_limit: row.request_limit,
    requests_used: row.requests_used,
    status: row.revoked
      ? "revoked"
      : row.expires_at <= now
        ? "expired"
        : row.requests_used >= row.request_limit
          ? "exhausted"
          : "active",
  });

/** Only verified human account handlers issue grants. Consumption is private to Commander. */
export class DurableExecutionGrantRepository {
  constructor(private readonly storage: GrantStorage) {}

  readonly initialize = operation("initialize", () => {
    this.storage.sql.exec(`CREATE TABLE IF NOT EXISTS commander_execution_grants (
      session_id TEXT NOT NULL, mission_epoch INTEGER NOT NULL, faction TEXT NOT NULL,
      grant_id TEXT NOT NULL UNIQUE, organization_id TEXT NOT NULL, owner_user_id TEXT NOT NULL,
      authorized_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
      request_limit INTEGER NOT NULL, requests_used INTEGER NOT NULL DEFAULT 0,
      revoked INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (session_id, mission_epoch, faction),
      FOREIGN KEY (organization_id, owner_user_id) REFERENCES organization_memberships(organization_id, user_id) ON DELETE CASCADE
    )`);
  });

  private row(session: ExecutionSession): GrantRow | undefined {
    return this.storage.sql
      .exec<GrantRow>(
        "SELECT * FROM commander_execution_grants WHERE session_id = ? AND mission_epoch = ? AND faction = ?",
        session.session_id,
        session.mission_epoch,
        session.faction,
      )
      .toArray()[0];
  }

  private assertOwner(scope: AccountScope): void {
    const member = this.storage.sql
      .exec<{ readonly role: string }>(
        "SELECT role FROM organization_memberships WHERE organization_id = ? AND user_id = ?",
        scope.organizationId,
        scope.userId,
      )
      .toArray()[0];
    if (member?.role !== "owner" && member?.role !== "admin") throw denied();
  }

  private assertSameOwner(row: GrantRow, scope: AccountScope): void {
    if (row.organization_id !== scope.organizationId || row.owner_user_id !== scope.userId)
      throw new ExecutionAuthorizationError({
        code: "EXECUTION_OWNED_BY_ANOTHER_USER",
        message: "Another user owns this session's AI authorization.",
      });
  }

  authorize(
    scope: AccountScope,
    input: AuthorizeExecution,
    now: number,
  ): Effect.Effect<ExecutionGrant, GatewayRepositoryError | ExecutionAuthorizationError> {
    return operation("authorize", () =>
      this.storage.transactionSync(() => {
        const request = Schema.decodeUnknownSync(AuthorizeExecution)(input);
        this.assertOwner(scope);
        const previous = this.row(request);
        if (previous) this.assertSameOwner(previous, scope);
        this.storage.sql.exec(
          `INSERT INTO commander_execution_grants
         (session_id, mission_epoch, faction, grant_id, organization_id, owner_user_id, authorized_at, expires_at, request_limit, requests_used, revoked)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0)
         ON CONFLICT(session_id, mission_epoch, faction) DO UPDATE SET
           grant_id = excluded.grant_id, authorized_at = excluded.authorized_at,
           expires_at = excluded.expires_at, request_limit = excluded.request_limit, requests_used = 0, revoked = 0`,
          request.session_id,
          request.mission_epoch,
          request.faction,
          crypto.randomUUID(),
          scope.organizationId,
          scope.userId,
          now,
          now + request.duration_minutes * 60_000,
          request.request_limit,
        );
        return publicGrant(this.row(request)!, now);
      }),
    );
  }

  read(scope: AccountScope, session: ExecutionSession, now: number) {
    return operation("read", () => {
      this.assertOwner(scope);
      const row = this.row(session);
      if (!row) return null;
      this.assertSameOwner(row, scope);
      return publicGrant(row, now);
    });
  }

  revoke(scope: AccountScope, session: ExecutionSession, now: number) {
    return operation("revoke", () =>
      this.storage.transactionSync(() => {
        this.assertOwner(scope);
        const row = this.row(session);
        if (!row) return null;
        this.assertSameOwner(row, scope);
        this.storage.sql.exec(
          "UPDATE commander_execution_grants SET revoked = 1 WHERE grant_id = ?",
          row.grant_id,
        );
        return publicGrant({ ...row, revoked: 1 }, now);
      }),
    );
  }

  consume(session: ExecutionSession, now: number) {
    return operation("consume", () =>
      this.storage.transactionSync(() => {
        const row = this.row(Schema.decodeUnknownSync(ExecutionSession)(session));
        if (!row || publicGrant(row, now).status !== "active") throw denied();
        const scope = { organizationId: row.organization_id, userId: row.owner_user_id };
        this.assertOwner(scope);
        this.storage.sql.exec(
          "UPDATE commander_execution_grants SET requests_used = requests_used + 1 WHERE grant_id = ?",
          row.grant_id,
        );
        return { scope, grantId: row.grant_id };
      }),
    );
  }

  /** Recheck after container startup, so revoked/renewed queued work cannot begin execution. */
  verifyReserved(session: ExecutionSession, grantId: string, now: number) {
    return operation("verify", () => {
      const row = this.row(session);
      if (!row || row.grant_id !== grantId || row.revoked || row.expires_at <= now) throw denied();
      this.assertOwner({ organizationId: row.organization_id, userId: row.owner_user_id });
    });
  }
}
