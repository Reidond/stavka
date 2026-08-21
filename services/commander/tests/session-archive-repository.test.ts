import type { TickRequest } from "@stavka/protocol";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import type { SqlRepositoryHost } from "../src/logging/decision-log-repository";
import {
  initialSessionArchiveExportCursor,
  SessionArchiveRepositoryError,
  SqlSessionArchiveRepository,
} from "../src/logging/session-archive-repository";
import { initialCommanderState } from "../src/state/types";

const tick: TickRequest = {
  protocol_version: 1,
  session_id: "session",
  faction: "OPFOR",
  tick_id: 7,
  timestamp: 120,
  full_snapshot_interval: 30,
  type: "full",
  snapshot: {
    mission: {
      id: "mission",
      epoch: 1,
      name: "Test",
      map: "Poligon",
      time_elapsed_seconds: 120,
      player_count: { friendly: 1, enemy: 1 },
    },
    objectives: [],
    friendly_groups: [],
    known_enemies: [],
    resources: {
      manpower: 150,
      vehicle_pool: 5,
      reinforcement_cooldown_seconds: 0,
      max_active_units: 50,
    },
  },
  sergeant_reports: [],
  events: [
    {
      id: "evt_1",
      type: "objective_changed",
      timestamp: 119,
      significance: "notable",
      objective_id: "hill",
      details: { from: "neutral", to: "enemy" },
    },
  ],
  command_results: [],
};

const hostWith = (rows: {
  readonly ticks: readonly {
    readonly tick_id: number;
    readonly timestamp: number;
    readonly payload: string;
  }[];
  readonly events: readonly { readonly payload: string }[];
  readonly snapshots: readonly {
    readonly tick_id: number;
    readonly timestamp: number;
    readonly payload: string;
  }[];
}): SqlRepositoryHost => ({
  sql: <T>(strings: TemplateStringsArray): T[] => {
    const query = strings.join("?");
    if (query.includes("FROM tick_history")) return [...rows.ticks] as T[];
    if (query.includes("FROM event_history")) return [...rows.events] as T[];
    if (query.includes("FROM snapshot_history")) return [...rows.snapshots] as T[];
    return [];
  },
});

interface TickRow {
  readonly rowid: number;
  readonly tick_id: number;
  readonly timestamp: number;
  readonly payload: string;
}

interface EventRow {
  readonly rowid: number;
  readonly id: string;
  readonly timestamp: number;
  readonly payload: string;
}

class ArchiveHost implements SqlRepositoryHost {
  #ticks: TickRow[] = [];
  #events: EventRow[] = [];
  #snapshots: TickRow[] = [];

  sql<T>(strings: TemplateStringsArray, ...values: (string | number | boolean | null)[]): T[] {
    const query = strings.join("?");
    if (query.includes("INSERT OR IGNORE INTO tick_history")) {
      const [tickId, timestamp, _kind, payload] = values as [number, number, string, string];
      if (!this.#ticks.some((row) => row.tick_id === tickId)) {
        this.#ticks.push({ rowid: this.#ticks.length + 1, tick_id: tickId, timestamp, payload });
      }
      return [];
    }
    if (query.includes("INSERT OR IGNORE INTO event_history")) {
      const [id, timestamp, payload] = values as [string, number, string];
      if (!this.#events.some((row) => row.id === id)) {
        this.#events.push({ rowid: this.#events.length + 1, id, timestamp, payload });
      }
      return [];
    }
    if (query.includes("INSERT OR IGNORE INTO snapshot_history")) {
      const [tickId, timestamp, payload] = values as [number, number, string];
      if (!this.#snapshots.some((row) => row.tick_id === tickId)) {
        this.#snapshots.push({
          rowid: this.#snapshots.length + 1,
          tick_id: tickId,
          timestamp,
          payload,
        });
      }
      return [];
    }
    if (query.includes("WITH watermark(high_water_rowid)")) {
      const rows = query.includes("tick_history")
        ? this.#ticks
        : query.includes("event_history")
          ? this.#events
          : this.#snapshots;
      return [
        {
          high_water_rowid: rows.at(-1)?.rowid ?? 0,
          total: rows.length,
        },
      ] as T[];
    }
    if (query.includes("SELECT tick_id, timestamp, payload FROM tick_history")) {
      const highWater = values[0] as number;
      const after = values.length > 2 ? (values[1] as number) : undefined;
      const limit = values.at(-1) as number;
      return this.#ticks
        .filter((row) => row.rowid <= highWater && (after === undefined || row.tick_id > after))
        .sort((left, right) => left.tick_id - right.tick_id)
        .slice(0, limit) as T[];
    }
    if (query.includes("SELECT id, timestamp, payload FROM event_history")) {
      const highWater = values[0] as number;
      const timestamp = values.length > 2 ? (values[1] as number) : undefined;
      const id = values.length > 4 ? (values[3] as string) : undefined;
      const limit = values.at(-1) as number;
      return this.#events
        .filter((row) => row.rowid <= highWater)
        .filter(
          (row) =>
            timestamp === undefined ||
            id === undefined ||
            row.timestamp > timestamp ||
            (row.timestamp === timestamp && row.id > id),
        )
        .sort((left, right) => left.timestamp - right.timestamp || left.id.localeCompare(right.id))
        .slice(0, limit) as T[];
    }
    if (query.includes("SELECT tick_id, timestamp, payload FROM snapshot_history")) {
      const highWater = values[0] as number;
      const after = values.length > 2 ? (values[1] as number) : undefined;
      const limit = values.at(-1) as number;
      return this.#snapshots
        .filter((row) => row.rowid <= highWater && (after === undefined || row.tick_id > after))
        .sort((left, right) => left.tick_id - right.tick_id)
        .slice(0, limit) as T[];
    }
    return [];
  }
}

describe("session archive repository", () => {
  it("decodes tick, event, and snapshot history at the repository boundary", async () => {
    const repository = new SqlSessionArchiveRepository(
      hostWith({
        ticks: [{ tick_id: 7, timestamp: 120, payload: JSON.stringify(tick) }],
        events: [{ payload: JSON.stringify(tick.events[0]) }],
        snapshots: [
          {
            tick_id: 7,
            timestamp: 120,
            payload: JSON.stringify({ ...initialCommanderState(), snapshot: tick.snapshot }),
          },
        ],
      }),
    );

    const archive = await Effect.runPromise(repository.export(100));

    expect(archive.ticks).toHaveLength(1);
    expect(archive.ticks[0]?.request).toEqual(tick);
    expect(archive.events).toEqual(tick.events);
    expect(archive.snapshots[0]).toMatchObject({
      tickId: 7,
      snapshot: { mission: { id: "mission" } },
    });
  });

  it("surfaces corrupted persisted JSON as a typed repository failure", async () => {
    const repository = new SqlSessionArchiveRepository(
      hostWith({
        ticks: [{ tick_id: 7, timestamp: 120, payload: "{not-json" }],
        events: [],
        snapshots: [],
      }),
    );

    const failure = await Effect.runPromise(Effect.flip(repository.export(100)));

    expect(failure).toBeInstanceOf(SessionArchiveRepositoryError);
    expect(failure.operation).toBe("export");
  });

  it("holds all archive streams at their high-water marks across late and duplicate ticks", async () => {
    const repository = new SqlSessionArchiveRepository(new ArchiveHost());
    const state = { ...initialCommanderState(), snapshot: tick.snapshot };
    const first = tick;
    const second: TickRequest = {
      ...tick,
      tick_id: 8,
      timestamp: 121,
      events: [
        {
          ...tick.events[0]!,
          id: "evt_2",
          timestamp: 120,
        },
      ],
    };
    await Effect.runPromise(repository.saveTick(first, state));
    await Effect.runPromise(repository.saveTick(second, state));
    const snapshot = await Effect.runPromise(repository.exportSnapshot);

    await Effect.runPromise(
      repository.saveTick(
        {
          ...first,
          timestamp: 999,
          events: [{ ...first.events[0]!, timestamp: 999 }],
        },
        state,
      ),
    );
    await Effect.runPromise(
      repository.saveTick(
        {
          ...first,
          tick_id: 1,
          timestamp: 1,
          events: [{ ...first.events[0]!, id: "evt_late", timestamp: 1 }],
        },
        state,
      ),
    );

    const firstPage = await Effect.runPromise(
      repository.pageFromSnapshot(snapshot, initialSessionArchiveExportCursor(), 1),
    );
    const secondPage = await Effect.runPromise(
      repository.pageFromSnapshot(snapshot, firstPage.cursor, 1),
    );

    expect(snapshot.counts).toEqual({ ticks: 2, events: 2, snapshots: 2 });
    expect(firstPage.archive.ticks.map(({ tickId }) => tickId)).toEqual([7]);
    expect(firstPage.archive.events.map(({ id }) => id)).toEqual(["evt_1"]);
    expect(firstPage.archive.snapshots.map(({ tickId }) => tickId)).toEqual([7]);
    expect(secondPage.archive.ticks.map(({ tickId }) => tickId)).toEqual([8]);
    expect(secondPage.archive.events.map(({ id }) => id)).toEqual(["evt_2"]);
    expect(secondPage.archive.snapshots.map(({ tickId }) => tickId)).toEqual([8]);
    expect(secondPage.cursor).toEqual({
      ticks: { done: true, after: 8 },
      events: { done: true, timestamp: 120, id: "evt_2" },
      snapshots: { done: true, after: 8 },
    });
  });
});
