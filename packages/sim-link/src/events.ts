import { GameEvent } from "@stavka/protocol";
import { Schema } from "effect";

export interface EventBatch {
  readonly dispatchNow: boolean;
  readonly events: readonly GameEvent[];
}

const FiniteNumber = Schema.Number.pipe(Schema.check(Schema.isFinite()));

export const EventFilterState = Schema.Struct({
  notable: Schema.Array(GameEvent),
  urgent: Schema.Array(GameEvent),
  batch_started_at: Schema.optional(FiniteNumber),
}).check(
  Schema.makeFilter((state) => {
    if (state.notable.some((item) => item.significance !== "notable")) {
      return { path: ["notable"], issue: "notable queue accepts only notable events" };
    }
    if (state.urgent.some((item) => item.significance !== "urgent")) {
      return { path: ["urgent"], issue: "urgent queue accepts only urgent events" };
    }
    if (state.notable.length > 0 !== (state.batch_started_at !== undefined)) {
      return {
        path: ["batch_started_at"],
        issue: "batch start must be present exactly when notable events are pending",
      };
    }
    return undefined;
  }),
);
export type EventFilterState = typeof EventFilterState.Type;

export const filterVisibleEvents = (
  events: readonly GameEvent[],
  visibleGroupIds: ReadonlySet<string>,
): GameEvent[] =>
  events.filter((event) => event.group_id === undefined || visibleGroupIds.has(event.group_id));

/** Mirrors the mod rule: routine stays local, notable batches, urgent flushes immediately. */
export class EventFilter {
  readonly #notable: GameEvent[] = [];
  readonly #urgent: GameEvent[] = [];
  readonly #batchIntervalSeconds: number;
  #batchStartedAt: number | undefined;

  constructor(batchIntervalSeconds = 10) {
    if (!Number.isFinite(batchIntervalSeconds) || batchIntervalSeconds < 0) {
      throw new Error("batchIntervalSeconds must be a non-negative finite number");
    }
    this.#batchIntervalSeconds = batchIntervalSeconds;
  }

  ingest(events: readonly GameEvent[], nowSeconds?: number): EventBatch {
    const observedAt =
      nowSeconds ?? events.reduce((latest, event) => Math.max(latest, event.timestamp), 0);
    for (const item of events) {
      if (item.significance === "notable") {
        this.#notable.push(item);
        this.#batchStartedAt ??= observedAt;
      }
      if (item.significance === "urgent") this.#urgent.push(item);
    }
    if (this.#urgent.length > 0) {
      return { dispatchNow: true, events: this.flush() };
    }
    if (this.notableDue(observedAt)) {
      return { dispatchNow: false, events: this.flush() };
    }
    return { dispatchNow: false, events: [] };
  }

  flush(additional: readonly GameEvent[] = []): GameEvent[] {
    const events = [...this.#notable, ...this.#urgent, ...additional];
    this.#notable.length = 0;
    this.#urgent.length = 0;
    this.#batchStartedAt = undefined;
    return events;
  }

  restore(events: readonly GameEvent[]): void {
    const notable = events.filter((event) => event.significance === "notable");
    const urgent = events.filter((event) => event.significance === "urgent");
    this.#notable.unshift(...notable);
    this.#urgent.unshift(...urgent);
    if (notable.length > 0) {
      const earliest = Math.min(...notable.map((event) => event.timestamp));
      this.#batchStartedAt = Math.min(this.#batchStartedAt ?? earliest, earliest);
    }
  }

  snapshotState(): EventFilterState {
    return {
      notable: structuredClone(this.#notable),
      urgent: structuredClone(this.#urgent),
      ...(this.#batchStartedAt === undefined ? {} : { batch_started_at: this.#batchStartedAt }),
    };
  }

  restoreState(snapshot: unknown): void {
    const state = Schema.decodeUnknownSync(EventFilterState)(snapshot);
    this.#notable.splice(0, this.#notable.length, ...structuredClone(state.notable));
    this.#urgent.splice(0, this.#urgent.length, ...structuredClone(state.urgent));
    this.#batchStartedAt = state.batch_started_at;
  }

  get pendingNotable(): number {
    return this.#notable.length;
  }

  get urgentPending(): boolean {
    return this.#urgent.length > 0;
  }

  notableDue(nowSeconds: number): boolean {
    return (
      this.#batchStartedAt !== undefined &&
      nowSeconds - this.#batchStartedAt >= this.#batchIntervalSeconds
    );
  }
}
