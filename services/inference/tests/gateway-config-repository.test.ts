import { DatabaseSync } from "node:sqlite";
import { Effect } from "effect";
import { expect, it } from "vitest";
import { DurableGatewayConfigRepository } from "../src/gateway-config-repository";

it("round-trips configuration through SQLite across repository instances", () => {
  using database = new DatabaseSync(":memory:");
  const sql = {
    exec(query: string, ...bindings: (string | number)[]) {
      const statement = database.prepare(query);
      if (query.trimStart().startsWith("SELECT"))
        return { toArray: () => statement.all(...bindings) };
      statement.run(...bindings);
      return { toArray: () => [] };
    },
  } as unknown as SqlStorage;
  const writer = new DurableGatewayConfigRepository(sql);
  Effect.runSync(writer.initialize);
  expect(Effect.runSync(writer.load)).toBeUndefined();
  const config = {
    aliases: [{ tier: "stavka/commander", seat: "mock", model: "mock-model" }],
    killed: false,
    revision: 1,
    updatedAt: 123,
  } as const;
  Effect.runSync(writer.save(config));
  const reader = new DurableGatewayConfigRepository(sql);
  expect(Effect.runSync(reader.load)).toEqual(config);
  const updated = { ...config, killed: true, revision: 2, updatedAt: 456 };
  Effect.runSync(writer.save(updated));
  expect(Effect.runSync(reader.load)).toEqual(updated);
});
