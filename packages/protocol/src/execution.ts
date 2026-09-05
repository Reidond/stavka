import { Schema } from "effect";

const Identifier = Schema.String.check(
  Schema.isTrimmed(),
  Schema.isMinLength(1),
  Schema.isMaxLength(256),
  Schema.isPattern(/^[A-Za-z0-9_.:-]+$/u),
);
const Natural = Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0));

/** Owner delegation is separate from the version-one game wire protocol. */
export const ExecutionSession = Schema.Struct({
  session_id: Identifier,
  mission_epoch: Natural,
  faction: Identifier,
});
export type ExecutionSession = typeof ExecutionSession.Type;

export const AuthorizeExecution = Schema.Struct({
  ...ExecutionSession.fields,
  duration_minutes: Schema.Number.check(
    Schema.isInt(),
    Schema.isBetween({ minimum: 1, maximum: 1440 }),
  ),
  request_limit: Schema.Number.check(
    Schema.isInt(),
    Schema.isBetween({ minimum: 1, maximum: 200 }),
  ),
});
export type AuthorizeExecution = typeof AuthorizeExecution.Type;

export const ExecutionGrant = Schema.Struct({
  ...ExecutionSession.fields,
  grant_id: Schema.String,
  status: Schema.Literals(["active", "revoked", "expired", "exhausted"]),
  authorized_at: Natural,
  expires_at: Natural,
  request_limit: Natural,
  requests_used: Natural,
});
export type ExecutionGrant = typeof ExecutionGrant.Type;

export const ExecutionStatus = Schema.Struct({ grant: Schema.NullOr(ExecutionGrant) });
