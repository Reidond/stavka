import {
  FriendlyGroupState,
  GameEvent,
  GameSnapshot,
  KnownEnemyState,
  SergeantReport,
} from "@stavka/protocol";
import { Schema } from "effect";

export interface SergeantReporterOptions {
  readonly activeIntervalSeconds?: number;
  readonly idleIntervalSeconds?: number;
}

export interface SergeantReportContext {
  readonly snapshot: GameSnapshot;
  readonly visibleEnemies: readonly KnownEnemyState[];
  readonly events: readonly GameEvent[];
  readonly timestamp: number;
  readonly previousSnapshot?: GameSnapshot;
}

const ReporterTimestamp = Schema.Number.pipe(Schema.check(Schema.isFinite()));
const ReporterEntry = Schema.Tuple([Schema.String, ReporterTimestamp]);

export const SergeantReporterState = Schema.Struct({
  first_observed_at: Schema.Array(ReporterEntry),
  last_report_at: Schema.Array(ReporterEntry),
  visible_contacts: Schema.Array(Schema.String),
});
export type SergeantReporterState = typeof SergeantReporterState.Type;

const reportStatus = (
  status: FriendlyGroupState["status"],
): SergeantReport["payload"]["status"] => {
  switch (status) {
    case "engaged":
    case "boarding":
    case "idle":
    case "mounted":
    case "moving":
      return status;
    case "dismounting":
      return "boarding";
    case "patrolling":
      return "moving";
    case "defending":
    case "initializing":
      return "idle";
  }
};

const contactKey = (enemy: KnownEnemyState): string => `${enemy.reported_by}\0${enemy.id}`;

const contactFromEnemy = (
  group: FriendlyGroupState,
  enemy: KnownEnemyState,
): SergeantReport["payload"]["contacts"][number] => {
  const deltaX = enemy.last_known_position[0] - group.position[0];
  const deltaZ = enemy.last_known_position[2] - group.position[2];
  const bearing = ((Math.atan2(deltaX, deltaZ) * 180) / Math.PI + 360) % 360;
  return {
    type: enemy.type,
    estimated_count: enemy.estimated_count,
    bearing,
    distance: Math.hypot(deltaX, deltaZ),
  };
};

const moraleFor = (
  strength: SergeantReport["payload"]["strength"],
): SergeantReport["payload"]["morale"] => {
  if (strength.current === 0 || strength.current <= strength.max * 0.25) return "broken";
  if (strength.current < strength.max * 0.5) return "shaken";
  return strength.current < strength.max ? "steady" : "confident";
};

const localDecision = (
  reportType: SergeantReport["payload"]["report_type"],
  status: SergeantReport["payload"]["status"],
): string => {
  switch (reportType) {
    case "casualty":
      return status === "destroyed" ? "Group destroyed" : "Consolidating after casualties";
    case "contact":
      return status === "engaged"
        ? "Maintaining contact and returning fire"
        : "Reporting newly detected contact";
    case "objective":
      return "Monitoring objective change";
    case "support_request":
      return "Holding position while requesting support";
    case "sitrep":
      if (status === "engaged") return "Holding current engagement";
      if (status === "moving") return "Continuing assigned movement";
      return "Holding current position";
  }
};

const isCasualtyEvent = (event: GameEvent): boolean =>
  event.type === "casualty" || event.type === "group_wiped";

const isObjectiveEvent = (event: GameEvent): boolean =>
  event.objective_id !== undefined || event.type.includes("objective");

/** Deterministic simulator twin of the mod-side per-group sergeant summarizer. */
export class SergeantReporter {
  readonly #activeIntervalSeconds: number;
  readonly #idleIntervalSeconds: number;
  readonly #firstObservedAt = new Map<string, number>();
  readonly #lastReportAt = new Map<string, number>();
  #visibleContacts = new Set<string>();

  constructor(options: SergeantReporterOptions = {}) {
    this.#activeIntervalSeconds = options.activeIntervalSeconds ?? 10;
    this.#idleIntervalSeconds = options.idleIntervalSeconds ?? 60;
  }

  record(report: SergeantReport): void {
    this.#firstObservedAt.set(
      report.payload.group_id,
      this.#firstObservedAt.get(report.payload.group_id) ?? report.timestamp,
    );
    this.#lastReportAt.set(report.payload.group_id, report.timestamp);
  }

  snapshotState(): SergeantReporterState {
    const byGroupId = (left: readonly [string, number], right: readonly [string, number]): number =>
      left[0].localeCompare(right[0]);
    return {
      first_observed_at: [...this.#firstObservedAt].sort(byGroupId),
      last_report_at: [...this.#lastReportAt].sort(byGroupId),
      visible_contacts: [...this.#visibleContacts].sort(),
    };
  }

  restoreState(snapshot: unknown): void {
    const state = Schema.decodeUnknownSync(SergeantReporterState)(snapshot);
    this.#firstObservedAt.clear();
    this.#lastReportAt.clear();
    for (const [groupId, timestamp] of state.first_observed_at) {
      this.#firstObservedAt.set(groupId, timestamp);
    }
    for (const [groupId, timestamp] of state.last_report_at) {
      this.#lastReportAt.set(groupId, timestamp);
    }
    this.#visibleContacts = new Set(state.visible_contacts);
  }

  generate(context: SergeantReportContext): SergeantReport[] {
    const currentGroups = new Map(
      context.snapshot.friendly_groups.map((group) => [group.id, group]),
    );
    const previousGroups = new Map(
      (context.previousSnapshot?.friendly_groups ?? []).map((group) => [group.id, group]),
    );
    for (const group of currentGroups.values()) {
      if (!this.#firstObservedAt.has(group.id)) {
        this.#firstObservedAt.set(group.id, context.timestamp);
      }
    }

    const visibleEnemies = [...context.visibleEnemies].sort((left, right) =>
      left.id.localeCompare(right.id),
    );
    const currentContactKeys = new Set(visibleEnemies.map(contactKey));
    const newContactReporters = new Set(
      visibleEnemies
        .filter((enemy) => !this.#visibleContacts.has(contactKey(enemy)))
        .map((enemy) => enemy.reported_by),
    );
    this.#visibleContacts = currentContactKeys;

    const candidates = new Set<string>();
    for (const event of context.events) {
      if (
        event.group_id !== undefined &&
        (currentGroups.has(event.group_id) || previousGroups.has(event.group_id))
      ) {
        candidates.add(event.group_id);
      }
    }
    for (const reporter of newContactReporters) {
      if (currentGroups.has(reporter)) candidates.add(reporter);
    }
    for (const previous of previousGroups.values()) {
      if (!currentGroups.has(previous.id)) candidates.add(previous.id);
    }
    for (const group of currentGroups.values()) {
      const firstObservedAt = this.#firstObservedAt.get(group.id) ?? context.timestamp;
      const lastReportAt = this.#lastReportAt.get(group.id) ?? firstObservedAt;
      const interval =
        group.status === "engaged" ? this.#activeIntervalSeconds : this.#idleIntervalSeconds;
      if (context.timestamp - lastReportAt >= interval) candidates.add(group.id);
    }

    const reports: SergeantReport[] = [];
    for (const groupId of [...candidates].sort()) {
      const current = currentGroups.get(groupId);
      const previous = previousGroups.get(groupId);
      const group = current ?? previous;
      if (!group) continue;

      const groupEvents = context.events.filter((event) => event.group_id === groupId);
      const destroyed = current === undefined;
      const strength = {
        current: destroyed ? 0 : group.strength.current,
        max: group.strength.max,
      };
      const status = destroyed ? "destroyed" : reportStatus(group.status);
      const contacts = visibleEnemies
        .filter((enemy) => enemy.reported_by === groupId)
        .map((enemy) => contactFromEnemy(group, enemy));
      const morale = moraleFor(strength);
      const reportType: SergeantReport["payload"]["report_type"] =
        destroyed || groupEvents.some(isCasualtyEvent)
          ? "casualty"
          : newContactReporters.has(groupId) ||
              groupEvents.some((event) => event.type === "contact")
            ? "contact"
            : groupEvents.some(isObjectiveEvent)
              ? "objective"
              : status === "engaged" && morale === "shaken"
                ? "support_request"
                : "sitrep";
      const request: NonNullable<SergeantReport["payload"]["request"]> =
        destroyed || morale === "broken"
          ? "requesting_reinforcement"
          : reportType === "support_request"
            ? "requesting_support"
            : "none";
      const report: SergeantReport = {
        type: "sergeant_report",
        timestamp: context.timestamp,
        payload: {
          group_id: groupId,
          report_type: reportType,
          position: [...group.position],
          strength,
          status,
          contacts,
          ammo_status: "adequate",
          morale,
          local_decision: localDecision(reportType, status),
          request,
        },
      };
      reports.push(report);
      this.record(report);
      if (destroyed) this.#firstObservedAt.delete(groupId);
    }
    return reports;
  }
}
