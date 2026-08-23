import type {
  AccountAccessPrincipal,
  AccountScope,
  AccountSession,
  ActiveAccountSession,
  OrganizationUser,
  SignUpPayload,
} from "@stavka/access-auth";
import { Effect } from "effect";

import { GatewayRepositoryError, repositoryEffect } from "./gateway-repository-error";

interface OrganizationStorage {
  readonly sql: SqlStorage;
  readonly transactionSync: <T>(closure: () => T) => T;
}

interface SessionRow extends Record<string, SqlStorageValue> {
  readonly user_id: string;
  readonly display_name: string;
  readonly email: string | null;
  readonly user_created_at: number;
  readonly user_updated_at: number;
  readonly organization_id: string;
  readonly organization_slug: string;
  readonly organization_name: string;
  readonly organization_created_at: number;
  readonly organization_updated_at: number;
  readonly membership_role: "owner" | "admin" | "member";
  readonly joined_at: number;
}

interface OrganizationUserRow extends Record<string, SqlStorageValue> {
  readonly user_id: string;
  readonly display_name: string;
  readonly email: string | null;
  readonly created_at: number;
  readonly updated_at: number;
  readonly membership_role: "owner" | "admin" | "member";
  readonly joined_at: number;
}

const activeSession = (row: SessionRow): ActiveAccountSession => ({
  status: "active",
  user: {
    id: row.user_id,
    displayName: row.display_name,
    ...(row.email ? { email: row.email } : {}),
    createdAt: row.user_created_at,
    updatedAt: row.user_updated_at,
  },
  organization: {
    id: row.organization_id,
    slug: row.organization_slug,
    name: row.organization_name,
    createdAt: row.organization_created_at,
    updatedAt: row.organization_updated_at,
  },
  membership: {
    organizationId: row.organization_id,
    userId: row.user_id,
    role: row.membership_role,
    joinedAt: row.joined_at,
  },
});

const slugify = (name: string, id: string): string => {
  const stem = name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 48);
  return `${stem || "stavka"}-${id.slice(0, 8)}`;
};

export class DurableOrganizationRepository {
  constructor(private readonly storage: OrganizationStorage) {}

  private get sql(): SqlStorage {
    return this.storage.sql;
  }

  readonly initialize = repositoryEffect("organization.initialize", () => {
    this.storage.transactionSync(() => {
      this.sql.exec(`CREATE TABLE IF NOT EXISTS organization_schema_migrations (
        version INTEGER PRIMARY KEY,
        applied_at INTEGER NOT NULL
      )`);
      this.sql.exec(`CREATE TABLE IF NOT EXISTS organizations (
        id TEXT PRIMARY KEY,
        singleton_key TEXT NOT NULL UNIQUE CHECK (singleton_key = 'stavka'),
        slug TEXT NOT NULL UNIQUE,
        name TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )`);
      this.sql.exec(`CREATE TABLE IF NOT EXISTS stavka_users (
        id TEXT PRIMARY KEY,
        access_subject TEXT NOT NULL UNIQUE,
        email TEXT,
        display_name TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )`);
      this.sql.exec(`CREATE TABLE IF NOT EXISTS organization_memberships (
        organization_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        role TEXT NOT NULL CHECK (role IN ('owner', 'admin', 'member')),
        joined_at INTEGER NOT NULL,
        PRIMARY KEY (organization_id, user_id),
        FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE,
        FOREIGN KEY (user_id) REFERENCES stavka_users(id) ON DELETE CASCADE
      )`);
      this.sql.exec(
        `CREATE INDEX IF NOT EXISTS idx_organization_memberships_user
         ON organization_memberships(user_id, organization_id)`,
      );
      this.sql.exec(
        `INSERT OR IGNORE INTO organization_schema_migrations (version, applied_at) VALUES (1, ?)`,
        Date.now(),
      );
    });
  });

  private sessionRow(subject: string): SessionRow | undefined {
    return this.sql
      .exec<SessionRow>(
        `SELECT u.id AS user_id, u.display_name, u.email,
                u.created_at AS user_created_at, u.updated_at AS user_updated_at,
                o.id AS organization_id, o.slug AS organization_slug, o.name AS organization_name,
                o.created_at AS organization_created_at, o.updated_at AS organization_updated_at,
                m.role AS membership_role, m.joined_at
         FROM stavka_users u
         JOIN organization_memberships m ON m.user_id = u.id
         JOIN organizations o ON o.id = m.organization_id
         WHERE u.access_subject = ?
         LIMIT 1`,
        subject,
      )
      .toArray()[0];
  }

  session(
    principal: AccountAccessPrincipal,
  ): Effect.Effect<AccountSession, GatewayRepositoryError> {
    return repositoryEffect("organization.session", () => {
      const row = this.sessionRow(principal.subject);
      if (row) return activeSession(row);
      const organizationExists =
        this.sql
          .exec<{ readonly count: number }>("SELECT COUNT(*) AS count FROM organizations")
          .toArray()[0]?.count !== 0;
      return {
        status: "setup_required" as const,
        identity: {
          ...(principal.email ? { email: principal.email } : {}),
          accessRole: principal.accessRole,
        },
        canSignUp: principal.accessRole === "owner" && !organizationExists,
      };
    });
  }

  signUp(
    principal: AccountAccessPrincipal,
    payload: SignUpPayload,
  ): Effect.Effect<ActiveAccountSession, GatewayRepositoryError> {
    return Effect.gen({ self: this }, function* () {
      const existing = yield* this.session(principal);
      if (existing.status === "active") return existing;
      if (!existing.canSignUp)
        return yield* Effect.fail(
          new GatewayRepositoryError({
            operation: "organization.sign-up",
            message: "Stavka registration is closed for this Access identity",
          }),
        );

      const userId = crypto.randomUUID();
      const organizationId = crypto.randomUUID();
      const now = Date.now();
      yield* repositoryEffect("organization.sign-up", () => {
        this.storage.transactionSync(() => {
          this.sql.exec(
            `INSERT INTO organizations (id, singleton_key, slug, name, created_at, updated_at)
             VALUES (?, 'stavka', ?, ?, ?, ?)`,
            organizationId,
            slugify(payload.organizationName, organizationId),
            payload.organizationName,
            now,
            now,
          );
          this.sql.exec(
            `INSERT INTO stavka_users
               (id, access_subject, email, display_name, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?)`,
            userId,
            principal.subject,
            principal.email ?? null,
            payload.displayName,
            now,
            now,
          );
          this.sql.exec(
            `INSERT INTO organization_memberships (organization_id, user_id, role, joined_at)
             VALUES (?, ?, 'owner', ?)`,
            organizationId,
            userId,
            now,
          );
        });
      });
      const created = yield* this.session(principal);
      if (created.status === "active") return created;
      return yield* Effect.fail(
        new GatewayRepositoryError({
          operation: "organization.sign-up",
          message: "Stavka profile was unavailable after setup",
        }),
      );
    });
  }

  listUsers(
    scope: AccountScope,
  ): Effect.Effect<readonly OrganizationUser[], GatewayRepositoryError> {
    return repositoryEffect("organization.users", () =>
      this.sql
        .exec<OrganizationUserRow>(
          `SELECT u.id AS user_id, u.display_name, u.email, u.created_at, u.updated_at,
                  m.role AS membership_role, m.joined_at
           FROM organization_memberships m
           JOIN stavka_users u ON u.id = m.user_id
           WHERE m.organization_id = ?
             AND EXISTS (
               SELECT 1 FROM organization_memberships caller
               WHERE caller.organization_id = m.organization_id AND caller.user_id = ?
             )
           ORDER BY u.display_name, u.id`,
          scope.organizationId,
          scope.userId,
        )
        .toArray()
        .map((row) => ({
          user: {
            id: row.user_id,
            displayName: row.display_name,
            ...(row.email ? { email: row.email } : {}),
            createdAt: row.created_at,
            updatedAt: row.updated_at,
          },
          membership: {
            organizationId: scope.organizationId,
            userId: row.user_id,
            role: row.membership_role,
            joinedAt: row.joined_at,
          },
        })),
    );
  }
}
