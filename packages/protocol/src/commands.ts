import { Schema } from "effect";

const NonEmptyString = Schema.String.pipe(Schema.check(Schema.isTrimmed(), Schema.isNonEmpty()));
const FiniteNumber = Schema.Number.pipe(Schema.check(Schema.isFinite()));
const PositiveFinite = FiniteNumber.pipe(Schema.check(Schema.isGreaterThan(0)));

export const Vector3 = Schema.Tuple([FiniteNumber, FiniteNumber, FiniteNumber]);
export type Vector3 = typeof Vector3.Type;

export const CommandPriority = Schema.Literals(["low", "normal", "high", "urgent"]);
export type CommandPriority = typeof CommandPriority.Type;

const CommandBase = {
  command_id: NonEmptyString,
  priority: Schema.optional(CommandPriority),
};

export const SpawnGroupCommand = Schema.Struct({
  ...CommandBase,
  type: Schema.Literal("spawn_group"),
  params: Schema.Struct({
    template: NonEmptyString,
    position: Vector3,
    faction: Schema.optional(NonEmptyString),
    behavior: Schema.optional(NonEmptyString),
    target_objective: Schema.optional(NonEmptyString),
  }),
});

export const DespawnGroupCommand = Schema.Struct({
  ...CommandBase,
  type: Schema.Literal("despawn_group"),
  params: Schema.Struct({ group_id: NonEmptyString }),
});

const DestinationParams = {
  group_id: NonEmptyString,
  destination: Vector3,
};

export const MoveGroupCommand = Schema.Struct({
  ...CommandBase,
  type: Schema.Literal("move_group"),
  params: Schema.Struct({
    ...DestinationParams,
    behavior: Schema.optional(NonEmptyString),
  }),
});

export const AttackGroupCommand = Schema.Struct({
  ...CommandBase,
  type: Schema.Literal("attack_group"),
  params: Schema.Struct(DestinationParams),
});

export const DefendGroupCommand = Schema.Struct({
  ...CommandBase,
  type: Schema.Literal("defend_group"),
  params: Schema.Struct({
    group_id: NonEmptyString,
    position: Vector3,
    radius: Schema.optional(PositiveFinite),
  }),
});

export const PatrolGroupCommand = Schema.Struct({
  ...CommandBase,
  type: Schema.Literal("patrol_group"),
  params: Schema.Struct({
    group_id: NonEmptyString,
    position: Vector3,
    radius: PositiveFinite,
  }),
});

export const SweepGroupCommand = Schema.Struct({
  ...CommandBase,
  type: Schema.Literal("sweep_group"),
  params: Schema.Struct(DestinationParams),
});

const ObjectiveStatus = Schema.Literals(["friendly", "enemy", "neutral", "contested"]);

export const CreateObjectiveParams = Schema.Struct({
  objective_id: NonEmptyString,
  action: Schema.Literal("create"),
  position: Vector3,
  status: Schema.optional(ObjectiveStatus),
});

export const UpdateObjectiveParams = Schema.Struct({
  objective_id: NonEmptyString,
  action: Schema.Literal("update"),
  position: Schema.optional(Vector3),
  status: Schema.optional(ObjectiveStatus),
}).check(
  Schema.makeFilter((params) =>
    params.position !== undefined || params.status !== undefined
      ? undefined
      : { path: ["action"], issue: "objective update requires position or status" },
  ),
);

export const RemoveObjectiveParams = Schema.Struct({
  objective_id: NonEmptyString,
  action: Schema.Literal("remove"),
});

export const AssignObjectiveParams = Schema.Struct({
  objective_id: NonEmptyString,
  action: Schema.Literal("assign"),
  assignee_group_id: NonEmptyString,
});

export const SetObjectiveCommandParams = Schema.Union([
  CreateObjectiveParams,
  UpdateObjectiveParams,
  RemoveObjectiveParams,
  AssignObjectiveParams,
]);

export const SetObjectiveCommand = Schema.Struct({
  ...CommandBase,
  type: Schema.Literal("set_objective"),
  params: SetObjectiveCommandParams,
});

export const Command = Schema.Union([
  SpawnGroupCommand,
  DespawnGroupCommand,
  MoveGroupCommand,
  AttackGroupCommand,
  DefendGroupCommand,
  PatrolGroupCommand,
  SweepGroupCommand,
  SetObjectiveCommand,
]);
export type Command = typeof Command.Type;

export const CommandResult = Schema.Struct({
  command_id: NonEmptyString,
  status: Schema.Literals(["accepted", "completed", "failed", "ignored"]),
  reason: Schema.optional(NonEmptyString),
});
export type CommandResult = typeof CommandResult.Type;

export const decodeCommand = Schema.decodeUnknownSync(Command, { onExcessProperty: "error" });
export const decodeCommandResult = Schema.decodeUnknownSync(CommandResult, {
  onExcessProperty: "error",
});
