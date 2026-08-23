import { Schema } from "effect";

const DisplayNameSchema = Schema.String.pipe(
  Schema.check(Schema.isTrimmed(), Schema.isNonEmpty(), Schema.isMaxLength(120)),
);

const OrganizationNameSchema = Schema.String.pipe(
  Schema.check(Schema.isTrimmed(), Schema.isNonEmpty(), Schema.isMaxLength(120)),
);

export const AccountAccessPrincipalSchema = Schema.Struct({
  subject: Schema.String.pipe(Schema.check(Schema.isNonEmpty())),
  email: Schema.optional(Schema.String),
  accessRole: Schema.Literals(["owner", "operator", "spectator"]),
});
export type AccountAccessPrincipal = typeof AccountAccessPrincipalSchema.Type;

export const StavkaUserSchema = Schema.Struct({
  id: Schema.String,
  displayName: DisplayNameSchema,
  email: Schema.optional(Schema.String),
  createdAt: Schema.Number,
  updatedAt: Schema.Number,
});
export type StavkaUser = typeof StavkaUserSchema.Type;

export const StavkaOrganizationSchema = Schema.Struct({
  id: Schema.String,
  slug: Schema.String,
  name: OrganizationNameSchema,
  createdAt: Schema.Number,
  updatedAt: Schema.Number,
});
export type StavkaOrganization = typeof StavkaOrganizationSchema.Type;

export const OrganizationMembershipSchema = Schema.Struct({
  organizationId: Schema.String,
  userId: Schema.String,
  role: Schema.Literals(["owner", "admin", "member"]),
  joinedAt: Schema.Number,
});
export type OrganizationMembership = typeof OrganizationMembershipSchema.Type;

export const OrganizationUserSchema = Schema.Struct({
  user: StavkaUserSchema,
  membership: OrganizationMembershipSchema,
});
export type OrganizationUser = typeof OrganizationUserSchema.Type;

export const ActiveAccountSessionSchema = Schema.Struct({
  status: Schema.Literal("active"),
  user: StavkaUserSchema,
  organization: StavkaOrganizationSchema,
  membership: OrganizationMembershipSchema,
});
export type ActiveAccountSession = typeof ActiveAccountSessionSchema.Type;

export const SetupRequiredAccountSessionSchema = Schema.Struct({
  status: Schema.Literal("setup_required"),
  identity: Schema.Struct({
    email: Schema.optional(Schema.String),
    accessRole: Schema.Literals(["owner", "operator", "spectator"]),
  }),
  canSignUp: Schema.Boolean,
});
export type SetupRequiredAccountSession = typeof SetupRequiredAccountSessionSchema.Type;

export const AccountSessionSchema = Schema.Union([
  ActiveAccountSessionSchema,
  SetupRequiredAccountSessionSchema,
]);
export type AccountSession = typeof AccountSessionSchema.Type;

export const SignUpPayloadSchema = Schema.Struct({
  displayName: DisplayNameSchema,
  organizationName: OrganizationNameSchema,
});
export type SignUpPayload = typeof SignUpPayloadSchema.Type;

export interface AccountScope {
  readonly organizationId: string;
  readonly userId: string;
}

export const accountScope = (session: ActiveAccountSession): AccountScope => ({
  organizationId: session.organization.id,
  userId: session.user.id,
});
