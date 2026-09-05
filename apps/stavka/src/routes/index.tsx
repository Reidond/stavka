import { createFileRoute, Link as RouterLink } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@cloudflare/kumo/components/link";
import { Badge } from "@cloudflare/kumo/components/badge";
import { Empty } from "@cloudflare/kumo/components/empty";
import { Banner } from "@cloudflare/kumo/components/banner";
import { readProviderAccounts } from "../account-api";
import { readCommanderHealth, readInferenceStatus } from "../operations-api";
import { useAccountScope, useRecentSessions } from "../recent-sessions";
import { useLastModelTest } from "../components/operations";
import { CheckedAt, Loading } from "../components/page-state";
import { PageActions } from "../components/shell";
import { scenarioTitles } from "../components/simulation-setup";

export const Route = createFileRoute("/")({ component: Home });
function Home() {
  const commander = useQuery({
    queryKey: ["commander-health"],
    queryFn: ({ signal }) => readCommanderHealth(signal),
    retry: false,
  });
  const inference = useQuery({
    queryKey: ["inference-status"],
    queryFn: ({ signal }) => readInferenceStatus(signal),
    retry: false,
  });
  const accounts = useQuery({
    queryKey: ["stavka-provider-accounts"],
    queryFn: readProviderAccounts,
    retry: false,
  });
  const recent = useRecentSessions();
  const scope = useAccountScope();
  const last = useLastModelTest(scope);
  const scenarios = [
    {
      id: "engagement",
      title: scenarioTitles.engagement,
      description: "Two infantry groups meet at 150 metres.",
    },
    {
      id: "movement",
      title: scenarioTitles.movement,
      description: "Track a squad across a 250-metre route.",
    },
    {
      id: "mechanized",
      title: scenarioTitles.mechanized,
      description: "Board, travel, and recover a light transport.",
    },
  ] as const;
  return (
    <div className="stavka-pane space-y-4">
      <PageActions>
        <Link render={<RouterLink to="/simulations" />}>New simulation</Link>
      </PageActions>
      <section className="stavka-panel">
        <header className="stavka-panel-heading">
          <h2>Start a simulation</h2>
        </header>
        {scenarios.map(({ id, title, description }) => (
          <div className="home-scenario" key={id}>
            <div>
              <strong>{title}</strong>
              <p>{description}</p>
            </div>
            <Link
              render={<RouterLink to="/simulations" search={{ scenario: id, host: "agent" }} />}
              aria-label={`Run ${title}`}
            >
              Run →
            </Link>
          </div>
        ))}
      </section>
      <div className="home-grid">
        <section className="stavka-panel">
          <header className="stavka-panel-heading">
            <h2>Recent sessions</h2>
            <span>This browser</span>
          </header>
          {recent.length ? (
            recent.map((row) => (
              <div className="home-recent" key={`${row.sessionId}:${row.faction}:${row.host}`}>
                <div>
                  <strong>
                    {scenarioTitles[row.scenario as keyof typeof scenarioTitles] ?? row.scenario}
                  </strong>
                  <p>
                    {row.faction} ·{" "}
                    {row.host === "offline"
                      ? "Offline visit; no Commander archive"
                      : "Opened configuration"}{" "}
                    · {new Date(row.openedAt).toLocaleString()}
                  </p>
                </div>
                {row.host === "agent" ? (
                  <Link
                    render={
                      <RouterLink
                        to="/sessions/$sessionId"
                        params={{ sessionId: row.sessionId }}
                        search={{ faction: row.faction }}
                      />
                    }
                  >
                    Review
                  </Link>
                ) : null}
              </div>
            ))
          ) : (
            <Empty
              className="rounded-none border-0 [&_h2]:text-sm"
              size="sm"
              title="No recent sessions"
              description="Configurations you open appear here. History is local to this browser and profile."
            />
          )}
        </section>
        <section className="stavka-panel">
          <header className="stavka-panel-heading">
            <h2>Readiness</h2>
            <Link render={<RouterLink to="/system" />}>Health</Link>
          </header>
          {[
            {
              label: "Commander",
              query: commander,
              status:
                commander.data?.status === "live"
                  ? "Live"
                  : commander.data?.status === "degraded"
                    ? "Degraded"
                    : "Unavailable",
            },
            {
              label: "Inference gateway",
              query: inference,
              status: !inference.data?.ok
                ? "Unavailable"
                : inference.data.mode === "live"
                  ? "Live"
                  : inference.data.mode === "record"
                    ? "Record mode"
                    : "Replay mode",
            },
            {
              label: "Providers",
              query: accounts,
              status: `${accounts.data?.filter((account) => account.active).length ?? 0} active`,
            },
          ].map(({ label, query, status }) => (
            <div className="readiness-row" key={label}>
              <strong>{label}</strong>
              {query.isPending ? (
                <Loading label="Checking" />
              ) : query.error ? (
                <Banner variant="error" title="Unavailable" description={query.error.message} />
              ) : (
                <>
                  <span>{status}</span>
                  <CheckedAt timestamp={query.dataUpdatedAt} />
                </>
              )}
            </div>
          ))}
          <div className="readiness-row">
            <strong>Last model test</strong>
            <Badge
              variant={
                last?.status === "success" && last.data?.cacheStatus !== "hit"
                  ? "success"
                  : last?.status === "error"
                    ? "error"
                    : "secondary"
              }
            >
              {last?.status === "success"
                ? last.data?.cacheStatus === "hit"
                  ? "Cached response"
                  : "Passed"
                : last?.status === "error"
                  ? "Failed"
                  : last?.status === "pending"
                    ? "Testing"
                    : "Not tested"}
            </Badge>
            {last ? (
              <span className="text-xs break-all text-kumo-subtle">
                {last.data?.model} · {new Date(last.submittedAt).toLocaleTimeString()}
              </span>
            ) : null}
            <Link render={<RouterLink to="/models" />}>Models</Link>
          </div>
        </section>
      </div>
    </div>
  );
}
