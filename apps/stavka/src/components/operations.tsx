import { Banner } from "@cloudflare/kumo/components/banner";
import { Badge } from "@cloudflare/kumo/components/badge";
import { Button } from "@cloudflare/kumo/components/button";
import { Link } from "@cloudflare/kumo/components/link";
import { Empty } from "@cloudflare/kumo/components/empty";
import { useMutation, useMutationState, useQuery } from "@tanstack/react-query";
import { Fragment, useState } from "react";
import { readCommanderHealth, readInferenceStatus, runModelProbe } from "../operations-api";
import { readProviderAccounts } from "../account-api";
import { useAccountScope } from "../recent-sessions";
import { PageActions } from "./shell";
import { CheckedAt, Loading, Refresh, titleCase } from "./page-state";

type ProbeResult = Awaited<ReturnType<typeof runModelProbe>>;
export function useLastModelTest(
  scope: string | undefined,
  alias?: { tier: string; seat: string; model: string },
  accountRevision?: string,
) {
  const states = useMutationState({
    filters: {
      mutationKey: [
        "model-probe",
        scope,
        ...(alias ? [alias.tier, alias.seat, alias.model, accountRevision] : []),
      ],
    },
    select: (mutation) => ({
      status: mutation.state.status,
      submittedAt: mutation.state.submittedAt,
      data: mutation.state.data as ProbeResult | undefined,
      error: mutation.state.error,
    }),
  });
  return [...states].sort((a, b) => b.submittedAt - a.submittedAt)[0];
}
function ModelRow({
  alias,
  account,
}: {
  readonly alias: { tier: string; seat: string; model: string };
  readonly account:
    | { readonly label: string; readonly name: string; readonly revision: number }
    | undefined;
}) {
  const scope = useAccountScope();
  const [expanded, setExpanded] = useState(false);
  const accountRevision = account
    ? JSON.stringify([account.name, account.revision])
    : "unconnected";
  const last = useLastModelTest(scope, alias, accountRevision);
  const test = useMutation({
    mutationKey: ["model-probe", scope, alias.tier, alias.seat, alias.model, accountRevision],
    mutationFn: () => {
      if (alias.seat !== "codex" && alias.seat !== "claude")
        throw new Error("Unsupported subscription provider");
      return runModelProbe(alias.tier, alias.seat);
    },
    retry: false,
    gcTime: Infinity,
  });
  const label =
    last?.status === "pending"
      ? "Testing"
      : last?.status === "error"
        ? "Failed"
        : last?.status === "success"
          ? last.data?.cacheStatus === "hit"
            ? "Cached response"
            : "Passed"
          : "Not tested";
  return (
    <Fragment>
      <tr>
        <td>{alias.tier}</td>
        <td>{account?.label ?? titleCase(alias.seat)}</td>
        <td className="font-mono text-xs">{alias.model}</td>
        <td>
          <Badge
            variant={label === "Passed" ? "success" : label === "Failed" ? "error" : "secondary"}
          >
            {label}
          </Badge>
          {last?.status === "success" ? (
            <div className="mt-1 text-xs text-kumo-subtle">
              {new Date(last.submittedAt).toLocaleTimeString()}
            </div>
          ) : null}
        </td>
        <td>
          <div className="flex gap-2">
            <Button
              size="sm"
              loading={last?.status === "pending"}
              disabled={!scope || !["codex", "claude"].includes(alias.seat)}
              onClick={() => {
                setExpanded(true);
                test.mutate();
              }}
            >
              Test model
            </Button>
            {last && last.status !== "pending" ? (
              <Button
                size="sm"
                variant="ghost"
                aria-expanded={expanded}
                onClick={() => setExpanded(!expanded)}
              >
                Details
              </Button>
            ) : null}
          </div>
        </td>
      </tr>
      {expanded && last && last.status !== "pending" ? (
        <tr>
          <td colSpan={5}>
            {last.error ? (
              <Banner variant="error" title="Model test failed" description={last.error.message} />
            ) : last.data ? (
              <div role="status" className="space-y-2">
                <p className="m-0 break-all">{last.data.text || "No text returned"}</p>
                <p className="m-0 text-xs text-kumo-subtle">
                  {last.data.model} · {last.data.usage.input_tokens} input /{" "}
                  {last.data.usage.output_tokens} output tokens
                  {last.data.cacheStatus === "hit"
                    ? " · Cached result; this test did not make a fresh provider request."
                    : ""}
                </p>
              </div>
            ) : null}
          </td>
        </tr>
      ) : null}
    </Fragment>
  );
}
export function Models() {
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
  return (
    <div className="stavka-pane space-y-4">
      <PageActions>
        <CheckedAt timestamp={inference.dataUpdatedAt} />
        <Refresh
          loading={inference.isFetching || accounts.isFetching}
          onClick={() => {
            void inference.refetch();
            void accounts.refetch();
          }}
        />
      </PageActions>
      <p className="text-sm text-kumo-subtle">
        The provider account and resolved model behind each tier.
      </p>
      {accounts.error ? (
        <Banner
          variant="error"
          title="Provider labels unavailable"
          description={accounts.error.message}
        />
      ) : null}
      {inference.error ? (
        <Banner variant="error" title="Models unavailable" description={inference.error.message} />
      ) : (
        <section className="stavka-panel">
          <div className="table-scroll">
            <table className="operations-table">
              <thead>
                <tr>
                  {["Tier", "Provider account", "Resolved model", "Status", "Action"].map(
                    (header) => (
                      <th key={header}>{header}</th>
                    ),
                  )}
                </tr>
              </thead>
              <tbody>
                {inference.isPending ? (
                  <tr>
                    <td colSpan={5}>
                      <Loading label="Loading models" />
                    </td>
                  </tr>
                ) : (
                  inference.data.aliases.map((alias) => (
                    <ModelRow
                      key={`${alias.tier}:${alias.seat}:${alias.model}`}
                      alias={alias}
                      account={accounts.data?.find(
                        (account) => account.provider === alias.seat && account.active,
                      )}
                    />
                  ))
                )}
              </tbody>
            </table>
          </div>
          {inference.data?.aliases.length === 0 ? (
            <Empty size="sm" title="No model aliases configured" />
          ) : null}
        </section>
      )}
      <p className="m-0 text-xs text-kumo-subtle">
        Test model sends one short request through your subscription; simulation decisions are
        verified separately.
      </p>
    </div>
  );
}
export function Health() {
  const inference = useQuery({
    queryKey: ["inference-status"],
    queryFn: ({ signal }) => readInferenceStatus(signal),
    retry: false,
  });
  const commander = useQuery({
    queryKey: ["commander-health"],
    queryFn: ({ signal }) => readCommanderHealth(signal),
    retry: false,
  });
  const commanderLabel =
    commander.data?.status === "live"
      ? "Live"
      : commander.data?.status === "degraded"
        ? "Degraded"
        : "Unavailable";
  return (
    <div className="stavka-pane space-y-4">
      <PageActions>
        <Refresh
          loading={inference.isFetching || commander.isFetching}
          onClick={() => {
            void inference.refetch();
            void commander.refetch();
          }}
        />
      </PageActions>
      <p className="text-sm text-kumo-subtle">Service connections and runtime configuration.</p>
      <section className="stavka-panel" aria-label="Service health">
        <div className="health-row">
          <div>
            <h2>Commander service</h2>
            {commander.data ? <p>Protocol {commander.data.protocol_version}</p> : null}
          </div>
          {commander.isPending ? (
            <Loading label="Checking Commander" />
          ) : commander.error ? (
            <Banner variant="error" title="Unavailable" description={commander.error.message} />
          ) : (
            <Badge
              variant={
                commanderLabel === "Live"
                  ? "success"
                  : commanderLabel === "Degraded"
                    ? "warning"
                    : "error"
              }
            >
              {commanderLabel}
            </Badge>
          )}
          <CheckedAt timestamp={Math.max(commander.dataUpdatedAt, commander.errorUpdatedAt)} />
        </div>
        {["Inference gateway", "Container", "Kill switch"].map((name) => (
          <div className="health-row" key={name}>
            <div>
              <h2>{name}</h2>
              {inference.data && name === "Container" ? (
                <p>
                  {inference.data.container.status === "stopped" ? "Starts on demand. " : ""}
                  {inference.data.container.last_change > 0
                    ? `Changed ${new Date(inference.data.container.last_change).toLocaleString()}`
                    : "No state change reported"}
                </p>
              ) : null}
            </div>
            {inference.isPending ? (
              <Loading label={`Checking ${name.toLowerCase()}`} />
            ) : inference.error ? (
              <Banner variant="error" title="Unavailable" description={inference.error.message} />
            ) : inference.data ? (
              <Badge
                variant={
                  name === "Kill switch"
                    ? inference.data.killed
                      ? "error"
                      : "secondary"
                    : name === "Container"
                      ? "secondary"
                      : !inference.data.ok
                        ? "error"
                        : inference.data.mode === "live"
                          ? "success"
                          : "warning"
                }
              >
                {name === "Kill switch"
                  ? inference.data.killed
                    ? "On"
                    : "Off"
                  : name === "Container"
                    ? titleCase(inference.data.container.status)
                    : !inference.data.ok
                      ? "Unavailable"
                      : inference.data.mode === "live"
                        ? "Live"
                        : `${titleCase(inference.data.mode)} mode`}
              </Badge>
            ) : null}
            <CheckedAt timestamp={Math.max(inference.dataUpdatedAt, inference.errorUpdatedAt)} />
          </div>
        ))}
      </section>
      {inference.data ? (
        <Link href="/models">{inference.data.aliases.length} aliases configured in Models</Link>
      ) : null}
    </div>
  );
}
