import { describe, expect, it } from "vitest";
import {
  addRecent,
  readRecents,
  recentSessionKey,
  type RecentSession,
} from "../src/recent-sessions";
const entry = (
  sessionId: string,
  faction = "OPFOR",
  host: "agent" | "offline" = "agent",
): RecentSession => ({ sessionId, faction, host, scenario: "engagement", openedAt: 1234 });
describe("browser session history", () => {
  it("isolates both organization and user identities without delimiter collisions", () => {
    const keys = [
      recentSessionKey("a", "b:c"),
      recentSessionKey("a:b", "c"),
      recentSessionKey("a", "c"),
      recentSessionKey("b", "b:c"),
    ];
    expect(new Set(keys).size).toBe(4);
    const records = new Map([[keys[0]!, JSON.stringify([entry("private")])]]);
    const storage = { getItem: (key: string) => records.get(key) ?? null };
    expect(readRecents(storage, keys[0]!)).toHaveLength(1);
    expect(readRecents(storage, keys[1]!)).toEqual([]);
  });
  it("moves a revisit to the front while keeping factions and offline visits distinct", () => {
    const prior = [
      entry("session"),
      entry("session", "BLUFOR"),
      entry("session", "OPFOR", "offline"),
    ];
    const next = addRecent(prior, { ...entry("session"), openedAt: 9000 });
    expect(next).toHaveLength(3);
    expect(next[0]?.openedAt).toBe(9000);
    expect(prior[0]?.openedAt).toBe(1234);
    expect(next[1]?.faction).toBe("BLUFOR");
    expect(next[2]?.host).toBe("offline");
  });
  it("bounds history and ignores corrupt or unavailable storage", () => {
    expect(
      addRecent(
        Array.from({ length: 12 }, (_, index) => entry(String(index))),
        entry("new"),
      ),
    ).toHaveLength(12);
    for (const text of ["invalid-json", '[{"sessionId":"incomplete"}]', "null"])
      expect(readRecents({ getItem: () => text }, "key")).toEqual([]);
    expect(
      readRecents(
        {
          getItem: () => {
            throw new Error("Denied");
          },
        },
        "key",
      ),
    ).toEqual([]);
  });
});
