import { Banner } from "@cloudflare/kumo/components/banner";
import { Badge } from "@cloudflare/kumo/components/badge";
import { Button } from "@cloudflare/kumo/components/button";
import { Input } from "@cloudflare/kumo/components/input";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useState } from "react";
import {
  Cpu,
  Pulse,
  ArrowClockwise,
  MagnifyingGlass,
  ListChecks,
  ChartBar,
} from "@phosphor-icons/react";
import { Link } from "@tanstack/react-router";
import {
  readCommanderHealth,
  readInferenceStatus,
  readSessionExport,
  runModelProbe,
} from "../operations-api";
import { CommanderCostDashboard } from "./commander-cost-dashboard";
import { ReplayDashboard } from "./replay-dashboard";

function ModelTest({ tier, seat }: { readonly tier: string; readonly seat: string }) {
  const test = useMutation({
    mutationFn: () => {
      if (seat !== "codex" && seat !== "claude")
        throw new Error("This provider does not support a subscription test.");
      return runModelProbe(tier, seat);
    },
    retry: false,
  });
  return (
    <div className="min-w-40 space-y-2">
      <Button
        size="sm"
        disabled={seat !== "codex" && seat !== "claude"}
        loading={test.isPending}
        onClick={() => test.mutate()}
      >
        Test model
      </Button>
      {test.error ? (
        <p role="alert" className="m-0 max-w-64 text-xs text-kumo-danger">
          {test.error.message}
        </p>
      ) : null}
      {test.data ? (
        <div role="status" className="max-w-64 text-xs/5">
          <strong className="text-kumo-success">
            {test.data.cacheStatus === "hit" ? "Cached response" : "Response received"}
          </strong>
          <p className="m-0 wrap-break-word">{test.data.text || "No text returned"}</p>
          <p className="m-0 text-kumo-subtle">
            {test.data.model} · {test.data.usage.input_tokens} in / {test.data.usage.output_tokens}{" "}
            out
          </p>
        </div>
      ) : null}
    </div>
  );
}

export function SystemStatus({ modelsOnly = false }: { readonly modelsOnly?: boolean }) {
  const inference = useQuery({
    queryKey: ["inference-status"],
    queryFn: ({ signal }) => readInferenceStatus(signal),
    retry: false,
  });
  const commander = useQuery({
    queryKey: ["commander-health"],
    queryFn: ({ signal }) => readCommanderHealth(signal),
    enabled: !modelsOnly,
    retry: false,
  });
  return (
    <div className="stavka-pane space-y-4">
      <header className="stavka-page-heading">
        <div>
          <h1>{modelsOnly ? "Model aliases" : "System readiness"}</h1>
          <p>
            {modelsOnly
              ? "The model and provider behind each tier used by Commander."
              : "Service connections and runtime configuration for this workspace."}
          </p>
        </div>
        <Button
          onClick={() => {
            void inference.refetch();
            if (!modelsOnly) void commander.refetch();
          }}
        >
          <ArrowClockwise size={15} /> Refresh
        </Button>
      </header>
      {inference.isPending ? <p>Loading inference metadata…</p> : null}
      {inference.error ? (
        <Banner
          variant="error"
          title="Inference unavailable"
          description={inference.error.message}
        />
      ) : null}
      {!modelsOnly && commander.error ? (
        <Banner
          variant="error"
          title="Commander unavailable"
          description={commander.error.message}
        />
      ) : null}
      {!modelsOnly ? (
        <div className="stavka-metrics">
          <div className="stavka-metric">
            <span className="stavka-metric-label">
              Commander
              <Pulse size={17} />
            </span>
            <strong className="stavka-metric-value capitalize">
              {commander.data?.status ?? "Unknown"}
            </strong>
            <span className="stavka-metric-note">
              Protocol {commander.data?.protocol_version ?? "—"}
            </span>
          </div>
          <div className="stavka-metric">
            <span className="stavka-metric-label">Inference mode</span>
            <strong className="stavka-metric-value capitalize">
              {inference.data?.mode ?? "Unknown"}
            </strong>
            <span className="stavka-metric-note">Model gateway configuration</span>
          </div>
          <div className="stavka-metric">
            <span className="stavka-metric-label">Container</span>
            <strong className="stavka-metric-value capitalize">
              {inference.data?.container.status ?? "Unknown"}
            </strong>
            <span className="stavka-metric-note">Current gateway state</span>
          </div>
          <div className="stavka-metric">
            <span className="stavka-metric-label">Kill switch</span>
            <strong className="stavka-metric-value">
              {inference.data ? (inference.data.killed ? "Enabled" : "Disabled") : "Unknown"}
            </strong>
            <span className="stavka-metric-note">Inference request protection</span>
          </div>
        </div>
      ) : null}
      {inference.data ? (
        <>
          <section className="stavka-panel">
            <header className="stavka-panel-heading">
              <h2>
                <Cpu size={17} /> Configured aliases
              </h2>
              <span>{inference.data.aliases.length} tiers</span>
            </header>
            <div className="overflow-x-auto p-5">
              <table className="w-full text-left text-sm">
                <thead>
                  <tr className="border-b border-kumo-hairline text-xs text-kumo-subtle">
                    <th className="pb-3 font-medium">Tier alias</th>
                    <th className="pb-3 font-medium">Provider</th>
                    <th className="pb-3 font-medium">Resolved model</th>
                    <th className="pb-3 font-medium">Connection test</th>
                  </tr>
                </thead>
                <tbody>
                  {inference.data.aliases.map((alias) => (
                    <tr key={alias.tier} className="border-b border-kumo-hairline last:border-0">
                      <td className="py-5 font-medium">{alias.tier}</td>
                      <td>
                        <Badge variant="secondary">{alias.seat}</Badge>
                      </td>
                      <td className="font-mono text-xs">{alias.model}</td>
                      <td className="py-3">
                        <ModelTest tier={alias.tier} seat={alias.seat} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="border-t border-kumo-hairline p-4 text-xs/6 text-kumo-subtle">
              Test model sends one short request through your connected subscription and reports the
              returned model and token usage. A simulation decision must be verified separately.
            </div>
          </section>
        </>
      ) : null}
    </div>
  );
}

export function SessionInspector({
  title = "Session",
  initialSessionId = "",
  initialFaction = "OPFOR",
  usageOnly = false,
}: {
  readonly title?: string;
  readonly initialSessionId?: string;
  readonly initialFaction?: string;
  readonly usageOnly?: boolean;
}) {
  const [sessionId, setSessionId] = useState(initialSessionId);
  const [faction, setFaction] = useState(initialFaction);
  const [selection, setSelection] = useState<{ sessionId: string; faction: string } | undefined>(
    initialSessionId ? { sessionId: initialSessionId, faction: initialFaction } : undefined,
  );
  const session = useQuery({
    queryKey: ["session-export", selection],
    queryFn: ({ signal }) => readSessionExport(selection!.sessionId, selection!.faction, signal),
    enabled: selection !== undefined,
    retry: false,
  });
  return (
    <div className="stavka-pane space-y-4">
      <header className="stavka-page-heading">
        <div>
          <h1>{title}</h1>
          <p>
            {usageOnly
              ? "Token usage and reported costs for a recorded Commander session."
              : "Review the tactical state, decisions, and outcomes of a recorded session."}
          </p>
        </div>
        <Link to="/simulations" className="text-xs font-medium text-kumo-link">
          Open simulations →
        </Link>
      </header>
      <form
        className="stavka-session-form"
        onSubmit={(event) => {
          event.preventDefault();
          const next = { sessionId: sessionId.trim(), faction: faction.trim() };
          if (!next.sessionId || !next.faction) return;
          if (selection?.sessionId === next.sessionId && selection.faction === next.faction)
            void session.refetch();
          else setSelection(next);
        }}
      >
        <Input
          label="Session ID"
          value={sessionId}
          onChange={(event) => setSessionId(event.currentTarget.value)}
          required
        />
        <Input
          label="Faction"
          value={faction}
          onChange={(event) => setFaction(event.currentTarget.value)}
          required
        />
        <Button type="submit" loading={session.isFetching}>
          <MagnifyingGlass size={15} /> Load session
        </Button>
      </form>
      {session.error ? (
        <Banner variant="error" title="Session unavailable" description={session.error.message} />
      ) : null}
      {session.data ? (
        usageOnly ? (
          <CommanderCostDashboard
            sources={[
              { faction: session.data.session.faction, aggregates: session.data.cost_aggregates },
            ]}
          />
        ) : (
          <ReplayDashboard replay={session.data} />
        )
      ) : null}
      {!selection ? (
        <div className="stavka-panel">
          <div className="stavka-empty min-h-72">
            {usageOnly ? <ChartBar size={32} /> : <ListChecks size={32} />}
            <strong>
              {usageOnly ? "Choose a session to review usage" : "Choose a session to inspect"}
            </strong>
            <p>Use Inspect session in Simulations, or enter its session ID and faction above.</p>
            <Link to="/replays" className="text-xs font-medium text-kumo-link">
              Import an exported replay instead →
            </Link>
          </div>
        </div>
      ) : null}
    </div>
  );
}
