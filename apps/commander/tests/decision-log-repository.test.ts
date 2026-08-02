import { type DecisionLogEntry } from "@stavka/protocol";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import {
  SqlDecisionLogRepository,
  initialDecisionLogExportCursor,
  type SqlRepositoryHost,
} from "../src/logging/decision-log-repository";

const entry = (id: string, timestamp: string, summary: string): DecisionLogEntry => ({
  id,
  timestamp,
  agent: "commander",
  trigger: "scheduled_tick",
  input: { stateSnapshot: null, events: [], prompt: "" },
  output: { rawResponse: "", parsedCommands: [], summary },
  commandsIssued: [],
  model: "mock:commander",
  latencyMs: 0,
  tokenUsage: { input: 0, output: 0 },
  costUsd: 0,
});

interface DecisionRow {
  readonly rowid: number;
  readonly id: string;
  readonly timestamp: string;
  readonly payload: string;
}

class DecisionHost implements SqlRepositoryHost {
  #rows: DecisionRow[] = [];

  sql<T>(
    strings: TemplateStringsArray,
    ...values: (string | number | boolean | null)[]
  ): T[] {
    const query = strings.join("?");
    if (query.includes("INSERT OR IGNORE INTO decision_logs")) {
      const [id, timestamp, _agent, _trigger, payload] = values as [
        string,
        string,
        string,
        string,
        string,
      ];
      if (!this.#rows.some((row) => row.id === id)) {
        this.#rows.push({ rowid: this.#rows.length + 1, id, timestamp, payload });
      }
      return [];
    }
    if (query.includes("WITH watermark(high_water_rowid)")) {
      const highWater = this.#rows.at(-1)?.rowid ?? 0;
      return [{
        high_water_rowid: highWater,
        total: this.#rows.filter((row) => row.rowid <= highWater).length,
      }] as T[];
    }
    if (query.includes("SELECT id, timestamp, payload FROM decision_logs")) {
      const highWater = values[0] as number;
      const hasCursor = values.length > 2;
      const timestamp = hasCursor ? values[1] as string : undefined;
      const id = hasCursor ? values[3] as string : undefined;
      const limit = values.at(-1) as number;
      const rows = this.#rows
        .filter((row) => row.rowid <= highWater)
        .filter((row) => timestamp === undefined || id === undefined ||
          row.timestamp > timestamp || (row.timestamp === timestamp && row.id > id))
        .sort((left, right) => left.timestamp.localeCompare(right.timestamp) || left.id.localeCompare(right.id))
        .slice(0, limit)
        .map((row) => ({ id: row.id, timestamp: row.timestamp, payload: row.payload }));
      return rows as T[];
    }
    return [];
  }
}

describe("decision log export snapshot", () => {
  it("keeps the high-water snapshot stable across a late insert and duplicate save", async () => {
    const repository = new SqlDecisionLogRepository(new DecisionHost());
    const original = entry("decision-a", "2026-08-02T12:00:00.000Z", "original");
    const second = entry("decision-b", "2026-08-02T12:00:01.000Z", "second");
    await Effect.runPromise(repository.save(original));
    await Effect.runPromise(repository.save(second));
    const snapshot = await Effect.runPromise(repository.exportSnapshot);

    await Effect.runPromise(repository.save({
      ...original,
      timestamp: "2026-08-02T12:59:59.000Z",
      output: { ...original.output, summary: "should be ignored" },
    }));
    await Effect.runPromise(repository.save(
      entry("decision-late", "2026-08-02T11:59:59.000Z", "must stay outside the snapshot"),
    ));

    const first = await Effect.runPromise(
      repository.pageFromSnapshot(snapshot, initialDecisionLogExportCursor(), 1),
    );
    const final = await Effect.runPromise(
      repository.pageFromSnapshot(snapshot, first.cursor, 1),
    );

    expect(snapshot).toEqual({ highWaterRowId: 2, count: 2 });
    expect(first.entries).toEqual([original]);
    expect(final.entries).toEqual([second]);
    expect(final.cursor.done).toBe(true);
  });
});
