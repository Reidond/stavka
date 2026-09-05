import type { ActiveAccountSession } from "@stavka/access-auth";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { Badge } from "@cloudflare/kumo/components/badge";
import { Banner } from "@cloudflare/kumo/components/banner";
import {
  ArrowRight,
  Crosshair,
  Path,
  Truck,
  Pulse,
  Cpu,
  Plugs,
  ShieldCheck,
  PlayCircle,
} from "@phosphor-icons/react";
import { readProviderAccounts, readAccountSession } from "../account-api";
import { readCommanderHealth, readInferenceStatus } from "../operations-api";
import { accountSessionQueryKey } from "../components/account-gate";

export const Route = createFileRoute("/")({ component: OverviewPage });
function OverviewPage() {
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
  const session = useQuery({
    queryKey: accountSessionQueryKey,
    queryFn: readAccountSession,
    staleTime: 30_000,
  });
  const sessionData = session.data;
  const active: ActiveAccountSession | undefined =
    sessionData?.status === "active" ? sessionData : undefined;
  const activeAccounts = accounts.data?.filter((account) => account.active);
  const unavailable = commander.error ?? inference.error ?? accounts.error;
  const readiness = commander.data?.status ?? (commander.isPending ? "Checking" : "Unavailable");
  return (
    <div className="stavka-pane">
      <header className="stavka-page-heading">
        <div>
          <h1>Overview</h1>
          <p>Scenarios, connected providers, and the services behind your workspace.</p>
        </div>
        <Link
          to="/simulations"
          className="inline-flex items-center gap-2 rounded-lg bg-kumo-brand px-4 py-2.5 text-xs font-medium text-kumo-inverse"
        >
          Open simulations <ArrowRight size={15} />
        </Link>
      </header>
      {unavailable ? (
        <div className="mb-5">
          <Banner
            variant="error"
            title="Some workspace data is unavailable"
            description={unavailable.message}
          />
        </div>
      ) : null}
      <div className="stavka-metrics">
        <div className="stavka-metric">
          <div className="stavka-metric-label">
            Commander
            <Pulse size={17} />
          </div>
          <strong className="stavka-metric-value capitalize">{readiness}</strong>
          <span className="stavka-metric-note">
            {commander.data
              ? `Protocol ${commander.data.protocol_version}`
              : "Private service connection"}
          </span>
        </div>
        <div className="stavka-metric">
          <div className="stavka-metric-label">
            Connected providers
            <Plugs size={17} />
          </div>
          <strong className="stavka-metric-value">{activeAccounts?.length ?? "—"}</strong>
          <span className="stavka-metric-note">Accounts owned by your profile</span>
        </div>
        <div className="stavka-metric">
          <div className="stavka-metric-label">
            Model aliases
            <Cpu size={17} />
          </div>
          <strong className="stavka-metric-value">{inference.data?.aliases.length ?? "—"}</strong>
          <span className="stavka-metric-note">
            {inference.data ? `${inference.data.mode} mode` : "Configuration pending"}
          </span>
        </div>
        <div className="stavka-metric">
          <div className="stavka-metric-label">
            Workspace role
            <ShieldCheck size={17} />
          </div>
          <strong className="stavka-metric-value capitalize">
            {active?.membership.role ?? "—"}
          </strong>
          <span className="stavka-metric-note">
            {active?.organization.name ?? "Verifying membership"}
          </span>
        </div>
      </div>
      <div className="stavka-dashboard-grid">
        <div className="stavka-stack">
          <section className="stavka-panel">
            <header className="stavka-panel-heading">
              <h2>
                <Crosshair size={17} /> Proving ground
              </h2>
              <span>3 reproducible scenarios</span>
            </header>
            {[
              {
                id: "engagement",
                title: "Six versus Four",
                description:
                  "Two infantry groups meet at 150 metres. Inspect decisions, orders, and combat outcomes.",
                tag: "Infantry engagement",
                icon: Crosshair,
              },
              {
                id: "movement",
                title: "Forced Move Drill",
                description:
                  "Track a squad across a 250-metre route and inspect movement behavior.",
                tag: "Movement",
                icon: Path,
              },
              {
                id: "mechanized",
                title: "Mechanized Lifecycle",
                description:
                  "A squad and a light transport for boarding, travel, and recovery checks.",
                tag: "Vehicle operations",
                icon: Truck,
              },
            ].map(({ id, title, description, tag, icon: Icon }) => (
              <Link
                key={id}
                to="/simulations"
                search={{ scenario: id as "engagement" | "movement" | "mechanized", host: "agent" }}
                className="stavka-scenario-row"
              >
                <span className="stavka-scenario-icon">
                  <Icon size={23} />
                </span>
                <div>
                  <strong>{title}</strong>
                  <p>{description}</p>
                  <Badge variant="secondary">{tag}</Badge>
                </div>
                <ArrowRight size={16} />
              </Link>
            ))}
          </section>
          <section className="stavka-panel">
            <header className="stavka-panel-heading">
              <h2>
                <PlayCircle size={17} /> Review a recorded session
              </h2>
              <Link to="/replays">
                Open replay inspector <span aria-hidden="true">↗</span>
              </Link>
            </header>
            <div className="stavka-panel-body">
              <p className="m-0 text-xs/6 text-kumo-subtle">
                Load a session from Simulations to inspect its tactical state, command history, and
                reported usage. Import a canonical export to review the same evidence offline.
              </p>
              <div className="mt-4 flex gap-4">
                <Link to="/decisions" className="text-xs font-medium text-kumo-link">
                  Inspect decisions →
                </Link>
                <Link to="/usage" className="text-xs font-medium text-kumo-link">
                  Review usage →
                </Link>
              </div>
            </div>
          </section>
        </div>
        <div className="stavka-stack">
          <section className="stavka-panel">
            <header className="stavka-panel-heading">
              <h2>
                <Pulse size={17} /> Service status
              </h2>
              <Link to="/system">Details ↗</Link>
            </header>
            <div className="stavka-service-row">
              <div>
                Commander<small>Decision orchestration</small>
              </div>
              <Badge variant={readiness === "live" ? "success" : "warning"}>{readiness}</Badge>
            </div>
            <div className="stavka-service-row">
              <div>
                Inference container
                <small>
                  {inference.data ? `Mode: ${inference.data.mode}` : "Private model gateway"}
                </small>
              </div>
              <Badge variant="secondary">{inference.data?.container.status ?? "Unknown"}</Badge>
            </div>
            <div className="stavka-service-row">
              <div>
                Inference kill switch<small>Model request protection</small>
              </div>
              <Badge variant={inference.data?.killed ? "error" : "secondary"}>
                {inference.data ? (inference.data.killed ? "Enabled" : "Disabled") : "Unknown"}
              </Badge>
            </div>
            <p className="m-0 border-t border-kumo-hairline p-4 text-[11px]/5 text-kumo-subtle">
              Readiness is configuration metadata. A recorded model response is required to verify
              live inference.
            </p>
          </section>
          <section className="stavka-panel">
            <header className="stavka-panel-heading">
              <h2>
                <Plugs size={17} /> Your providers
              </h2>
              <Link to="/settings/providers">Manage ↗</Link>
            </header>
            {accounts.isPending ? (
              <div className="stavka-empty">
                <p>Loading connected accounts…</p>
              </div>
            ) : accounts.data?.length ? (
              accounts.data.map((account) => (
                <div className="stavka-service-row" key={`${account.provider}/${account.name}`}>
                  <div>
                    {account.label}
                    <small>
                      {account.provider === "codex" ? "Codex subscription" : "Claude subscription"}
                    </small>
                  </div>
                  <Badge variant={account.active ? "success" : "secondary"}>
                    {account.active ? "Active" : "Inactive"}
                  </Badge>
                </div>
              ))
            ) : (
              <div className="stavka-empty">
                <Plugs size={25} />
                <strong>
                  {accounts.error ? "Provider accounts unavailable" : "Connect a provider"}
                </strong>
                <p>
                  {accounts.error
                    ? accounts.error.message
                    : "Authorize your subscription to enable live model requests."}
                </p>
                <Link to="/settings/providers" className="text-xs font-medium text-kumo-link">
                  Provider setup →
                </Link>
              </div>
            )}
          </section>
        </div>
      </div>
    </div>
  );
}
