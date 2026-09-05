import { Schema } from "effect";
import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { readAccountSession } from "./account-api";
import { accountSessionQueryKey } from "./components/account-gate";
import { commanderSessionId, type ScenarioIdentity } from "./scenario-identity";

const RecentSession = Schema.Struct({
  sessionId: Schema.String,
  faction: Schema.String,
  scenario: Schema.String,
  host: Schema.Literals(["agent", "offline"]),
  openedAt: Schema.Number,
});
export type RecentSession = typeof RecentSession.Type;
export const recentSessionKey = (organization: string, user: string) =>
  `stavka:recents:${JSON.stringify([organization, user])}`;
export function readRecents(
  storage: Pick<Storage, "getItem">,
  key: string,
): readonly RecentSession[] {
  try {
    return Schema.decodeUnknownSync(Schema.Array(RecentSession))(
      JSON.parse(storage.getItem(key) ?? "[]"),
    );
  } catch {
    return [];
  }
}
export function addRecent(
  existing: readonly RecentSession[],
  entry: RecentSession,
): readonly RecentSession[] {
  return [
    entry,
    ...existing.filter(
      (row) =>
        row.sessionId !== entry.sessionId ||
        row.faction !== entry.faction ||
        row.host !== entry.host,
    ),
  ].slice(0, 12);
}
export function useAccountScope() {
  const session = useQuery({
    queryKey: accountSessionQueryKey,
    queryFn: readAccountSession,
    staleTime: 30_000,
  });
  return session.data?.status === "active"
    ? recentSessionKey(session.data.organization.id, session.data.user.id)
    : undefined;
}
export function useRecentSessions() {
  const scope = useAccountScope();
  const [snapshot, setSnapshot] = useState<{ scope: string; rows: readonly RecentSession[] }>();
  useEffect(() => {
    if (!scope) return;
    const update = () => {
      try {
        setSnapshot({ scope, rows: readRecents(window.localStorage, scope) });
      } catch {
        setSnapshot({ scope, rows: [] });
      }
    };
    update();
    window.addEventListener("storage", update);
    window.addEventListener("stavka-recents", update);
    return () => {
      window.removeEventListener("storage", update);
      window.removeEventListener("stavka-recents", update);
    };
  }, [scope]);
  return snapshot?.scope === scope ? (snapshot?.rows ?? []) : [];
}
export function useRememberSimulation(
  identity: ScenarioIdentity,
  faction: string,
  host: "agent" | "offline",
  enabled = true,
) {
  const scope = useAccountScope();
  const sessionId = commanderSessionId({ ...identity, faction });
  const scenario = identity.scenario;
  useEffect(() => {
    if (!scope || !enabled) return;
    try {
      const rows = addRecent(readRecents(window.localStorage, scope), {
        sessionId,
        faction,
        scenario,
        host,
        openedAt: Date.now(),
      });
      window.localStorage.setItem(scope, JSON.stringify(rows));
      window.dispatchEvent(new Event("stavka-recents"));
    } catch {
      /* Browser history is optional when storage is unavailable. */
    }
  }, [scope, sessionId, faction, scenario, host, enabled]);
}
