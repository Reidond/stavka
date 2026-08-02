import { Schema } from "effect";

import { Command } from "./commands";
import { DoctrineId } from "./doctrine";
import { GameEvent } from "./events";
import { CommanderCostAggregate, PROTOCOL_VERSION, TickRequest } from "./messages";
import { GameSnapshot } from "./state";

const NonEmptyString = Schema.String.pipe(Schema.check(Schema.isTrimmed(), Schema.isNonEmpty()));
const NonNegativeFinite = Schema.Number.pipe(
  Schema.check(Schema.isFinite(), Schema.isGreaterThanOrEqualTo(0)),
);
const Natural = NonNegativeFinite.pipe(Schema.check(Schema.isInt()));

export const DecisionLogEntry = Schema.Struct({
  id: NonEmptyString,
  timestamp: NonEmptyString,
  agent: NonEmptyString,
  trigger: NonEmptyString,
  input: Schema.Struct({
    stateSnapshot: Schema.Unknown,
    events: Schema.Array(Schema.Unknown),
    prompt: Schema.String,
  }),
  output: Schema.Struct({
    rawResponse: Schema.String,
    parsedCommands: Schema.Array(Command),
    summary: Schema.String,
  }),
  commandsIssued: Schema.Array(NonEmptyString),
  model: NonEmptyString,
  latencyMs: NonNegativeFinite,
  tokenUsage: Schema.Struct({ input: Natural, output: Natural }),
  costUsd: NonNegativeFinite,
});
export type DecisionLogEntry = typeof DecisionLogEntry.Type;

export const ArchivedTick = Schema.Struct({
  tickId: Natural,
  timestamp: NonNegativeFinite,
  kind: Schema.Literals(["full", "delta"]),
  request: TickRequest,
}).check(
  Schema.makeFilter((tick) => {
    const issues: Schema.FilterIssue[] = [];
    if (tick.tickId !== tick.request.tick_id) {
      issues.push({ path: ["tickId"], issue: "archived tick id must match request tick_id" });
    }
    if (tick.timestamp !== tick.request.timestamp) {
      issues.push({
        path: ["timestamp"],
        issue: "archived timestamp must match request timestamp",
      });
    }
    if (tick.kind !== tick.request.type) {
      issues.push({ path: ["kind"], issue: "archived kind must match request type" });
    }
    return issues;
  }),
);
export type ArchivedTick = typeof ArchivedTick.Type;
export const ArchivedTickSchema = ArchivedTick;

export const ArchivedSnapshot = Schema.Struct({
  tickId: Natural,
  timestamp: NonNegativeFinite,
  snapshot: GameSnapshot,
});
export type ArchivedSnapshot = typeof ArchivedSnapshot.Type;
export const ArchivedSnapshotSchema = ArchivedSnapshot;

type ReplaySnapshot = typeof GameSnapshot.Type;
type ReplayTickRequest = typeof TickRequest.Type;
type ReplayDeltaRequest = Extract<ReplayTickRequest, { readonly type: "delta" }>;

const upsertReplayItems = <T extends { readonly id: string }>(
  current: readonly T[],
  updates: readonly T[],
): T[] => {
  const indexed = new Map(current.map((item) => [item.id, item]));
  for (const update of updates) indexed.set(update.id, update);
  return [...indexed.values()];
};

const applyArchivedDelta = (
  snapshot: ReplaySnapshot,
  request: ReplayDeltaRequest,
): ReplaySnapshot => {
  const movement = new Map(request.changes.groups_moved.map((item) => [item.id, item.position]));
  const destroyedGroups = new Set(request.changes.groups_destroyed);
  const expiredEnemies = new Set(request.changes.known_enemies_expired);
  const removedObjectives = new Set(request.changes.objectives_removed ?? []);
  const groups = upsertReplayItems(snapshot.friendly_groups, request.changes.groups_upserted)
    .filter((group) => !destroyedGroups.has(group.id))
    .map((group) => {
      const position = movement.get(group.id);
      return position === undefined ? group : { ...group, position };
    });
  return {
    mission: request.changes.mission ?? snapshot.mission,
    objectives: upsertReplayItems(
      snapshot.objectives.filter((objective) => !removedObjectives.has(objective.id)),
      request.changes.objectives_upserted,
    ),
    friendly_groups: groups,
    known_enemies: upsertReplayItems(
      snapshot.known_enemies.filter((enemy) => !expiredEnemies.has(enemy.id)),
      request.changes.known_enemies_upserted,
    ),
    resources: request.changes.resources ?? snapshot.resources,
  };
};

const replayValueEquals = (left: unknown, right: unknown): boolean =>
  JSON.stringify(left) === JSON.stringify(right);

export const SessionArchive = Schema.Struct({
  ticks: Schema.Array(ArchivedTick),
  events: Schema.Array(GameEvent),
  snapshots: Schema.Array(ArchivedSnapshot),
}).check(
  Schema.makeFilter((archive) => {
    const issues: Schema.FilterIssue[] = [];
    const ticksById = new Map<number, (typeof archive.ticks)[number]>();
    const reconstructedByTick = new Map<number, ReplaySnapshot>();
    let previousTick: (typeof archive.ticks)[number] | undefined;
    let reconstructed: ReplaySnapshot | undefined;
    let sessionId: string | undefined;
    let faction: string | undefined;

    for (let index = 0; index < archive.ticks.length; index += 1) {
      const tick = archive.ticks[index];
      if (!tick) continue;
      if (index === 0 && tick.request.type !== "full") {
        issues.push({
          path: ["ticks", index, "request", "type"],
          issue: "a non-empty archive must begin with a full tick",
        });
      }
      if (previousTick !== undefined) {
        if (tick.tickId <= previousTick.tickId) {
          issues.push({
            path: ["ticks", index, "tickId"],
            issue: "archived tick ids must be unique and strictly increasing",
          });
        }
        if (tick.timestamp < previousTick.timestamp) {
          issues.push({
            path: ["ticks", index, "timestamp"],
            issue: "archived tick timestamps must be non-decreasing",
          });
        }
      }
      if (ticksById.has(tick.tickId)) {
        issues.push({
          path: ["ticks", index, "tickId"],
          issue: "archived tick id is duplicated",
        });
      }
      ticksById.set(tick.tickId, tick);

      sessionId ??= tick.request.session_id;
      faction ??= tick.request.faction;
      if (tick.request.session_id !== sessionId || tick.request.faction !== faction) {
        issues.push({
          path: ["ticks", index, "request"],
          issue: "all archived ticks must belong to one session and faction",
        });
      }

      if (tick.request.type === "full") {
        reconstructed = tick.request.snapshot;
      } else if (previousTick === undefined || reconstructed === undefined) {
        issues.push({
          path: ["ticks", index, "request", "since_tick"],
          issue: "delta tick has no preceding reconstructed state",
        });
      } else if (tick.request.since_tick !== previousTick.tickId) {
        issues.push({
          path: ["ticks", index, "request", "since_tick"],
          issue: "delta since_tick must reference the immediately preceding archived tick",
        });
      } else {
        const next = applyArchivedDelta(reconstructed, tick.request);
        if (
          tick.request.snapshot !== undefined &&
          !replayValueEquals(tick.request.snapshot, next)
        ) {
          issues.push({
            path: ["ticks", index, "request", "snapshot"],
            issue: "explicit delta snapshot does not match the reconstructed tick state",
          });
        }
        reconstructed = next;
      }
      if (reconstructed !== undefined) reconstructedByTick.set(tick.tickId, reconstructed);
      previousTick = tick;
    }

    const snapshotIds = new Set<number>();
    let previousSnapshotTickId: number | undefined;
    for (let index = 0; index < archive.snapshots.length; index += 1) {
      const snapshot = archive.snapshots[index];
      if (!snapshot) continue;
      if (previousSnapshotTickId !== undefined && snapshot.tickId <= previousSnapshotTickId) {
        issues.push({
          path: ["snapshots", index, "tickId"],
          issue: "archived snapshot tick ids must be unique and strictly increasing",
        });
      }
      if (snapshotIds.has(snapshot.tickId)) {
        issues.push({
          path: ["snapshots", index, "tickId"],
          issue: "archived snapshot tick id is duplicated",
        });
      }
      snapshotIds.add(snapshot.tickId);
      previousSnapshotTickId = snapshot.tickId;

      const tick = ticksById.get(snapshot.tickId);
      if (tick === undefined) {
        issues.push({
          path: ["snapshots", index, "tickId"],
          issue: "archived snapshot must correspond to an archived tick",
        });
        continue;
      }
      if (snapshot.timestamp !== tick.timestamp) {
        issues.push({
          path: ["snapshots", index, "timestamp"],
          issue: "archived snapshot timestamp must match its archived tick",
        });
      }
      const expected = reconstructedByTick.get(snapshot.tickId);
      if (expected !== undefined && !replayValueEquals(snapshot.snapshot, expected)) {
        issues.push({
          path: ["snapshots", index, "snapshot"],
          issue: "archived snapshot does not match the reconstructed tick state",
        });
      }
    }
    return issues;
  }),
);
export type SessionArchive = typeof SessionArchive.Type;
export const SessionArchiveSchema = SessionArchive;

export const ReplaySessionMetadata = Schema.Struct({
  protocol_version: Schema.Literal(PROTOCOL_VERSION),
  session_id: NonEmptyString,
  faction: NonEmptyString,
  mission_epoch: Natural,
  doctrine: DoctrineId,
  mode: Schema.Literals(["rule", "llm", "degraded"]),
  map_name: Schema.optional(NonEmptyString),
  exported_at: NonEmptyString,
});
export type ReplaySessionMetadata = typeof ReplaySessionMetadata.Type;

export const SessionExport = Schema.Struct({
  export_version: Schema.Literal(1),
  session: ReplaySessionMetadata,
  logs: Schema.Array(DecisionLogEntry),
  archive: SessionArchive,
  cost_aggregates: Schema.Array(CommanderCostAggregate),
}).check(
  Schema.makeFilter((sessionExport) => {
    const issues: Schema.FilterIssue[] = [];
    const checkMissionIdentity = (
      mission: ReplaySnapshot["mission"],
      path: ReadonlyArray<string | number>,
    ): void => {
      if (mission.epoch !== sessionExport.session.mission_epoch) {
        issues.push({
          path: [...path, "epoch"],
          issue: "mission epoch must match export metadata",
        });
      }
      if (
        sessionExport.session.map_name !== undefined &&
        mission.map !== sessionExport.session.map_name
      ) {
        issues.push({
          path: [...path, "map"],
          issue: "mission map must match export metadata",
        });
      }
    };

    for (let index = 0; index < sessionExport.archive.ticks.length; index += 1) {
      const tick = sessionExport.archive.ticks[index];
      if (!tick) continue;
      if (tick.request.session_id !== sessionExport.session.session_id) {
        issues.push({
          path: ["archive", "ticks", index, "request", "session_id"],
          issue: "archived tick session_id must match export metadata",
        });
      }
      if (tick.request.faction !== sessionExport.session.faction) {
        issues.push({
          path: ["archive", "ticks", index, "request", "faction"],
          issue: "archived tick faction must match export metadata",
        });
      }
      if (tick.request.type === "full") {
        checkMissionIdentity(tick.request.snapshot.mission, [
          "archive",
          "ticks",
          index,
          "request",
          "snapshot",
          "mission",
        ]);
      } else {
        if (tick.request.changes.mission !== undefined) {
          checkMissionIdentity(tick.request.changes.mission, [
            "archive",
            "ticks",
            index,
            "request",
            "changes",
            "mission",
          ]);
        }
        if (tick.request.snapshot !== undefined) {
          checkMissionIdentity(tick.request.snapshot.mission, [
            "archive",
            "ticks",
            index,
            "request",
            "snapshot",
            "mission",
          ]);
        }
      }
    }
    for (let index = 0; index < sessionExport.archive.snapshots.length; index += 1) {
      const snapshot = sessionExport.archive.snapshots[index];
      if (!snapshot) continue;
      checkMissionIdentity(snapshot.snapshot.mission, [
        "archive",
        "snapshots",
        index,
        "snapshot",
        "mission",
      ]);
    }
    return issues;
  }),
);
export type SessionExport = typeof SessionExport.Type;
export const SessionExportSchema = SessionExport;

export const decodeSessionExport = Schema.decodeUnknownSync(SessionExport, {
  onExcessProperty: "error",
});
