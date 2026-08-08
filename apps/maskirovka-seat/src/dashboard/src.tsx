import { QueryClient, QueryClientProvider, useMutation, useQuery } from "@tanstack/react-query";
import {
  Outlet,
  RouterProvider,
  createRootRoute,
  createRoute,
  createRouter,
} from "@tanstack/react-router";
import { Banner } from "@cloudflare/kumo/components/banner";
import { Button } from "@cloudflare/kumo/components/button";
import { LayerCard } from "@cloudflare/kumo/components/layer-card";
import { Schema } from "effect";
import { StrictMode, type ReactNode } from "react";
import { createRoot } from "react-dom/client";

import { HostedSeatBadge, HostedSeatLogFeed, HostedSeatSettingsForm } from "./components";

import "./styles.css";

const ProviderSchema = Schema.Literals(["claude", "codex"]);
const AccessRoleSchema = Schema.Literals(["owner", "operator", "spectator", "automation"]);

const HostedSeatStatusSchema = Schema.Struct({
  ok: Schema.Boolean,
  service: Schema.Literal("stavka-maskirovka-seat"),
  seat_id: Schema.String,
  provider: ProviderSchema,
  aliases: Schema.Record(Schema.String, Schema.String),
  container: Schema.Struct({
    status: Schema.String,
    last_change: Schema.Number,
  }),
  auth: Schema.Struct({
    configured: Schema.Boolean,
    persisted: Schema.Boolean,
    revision: Schema.Number,
    updated_at: Schema.optional(Schema.Number),
  }),
  controls: Schema.Struct({
    killed: Schema.Boolean,
    updated_at: Schema.Number,
  }),
  access: Schema.Struct({
    role: AccessRoleSchema,
    can_admin: Schema.Boolean,
    service_token: Schema.Boolean,
  }),
  requests: Schema.Struct({
    retained: Schema.Number,
    limit: Schema.Literal(200),
    metadata_only: Schema.Literal(true),
  }),
  capabilities: Schema.Struct({
    scope: Schema.Literal("single-hosted-seat"),
    tier_remap: Schema.Literal("model-only"),
    kill_switch: Schema.Literal("this-seat-only"),
    unsupported: Schema.Array(Schema.String),
  }),
});

const HostedSeatRequestSchema = Schema.Struct({
  request_id: Schema.String,
  timestamp: Schema.Number,
  dialect: Schema.Literals(["openai-responses", "anthropic-messages"]),
  alias: Schema.String,
  model: Schema.String,
  status: Schema.Number,
  latency_ms: Schema.Number,
  queue_depth: Schema.Number,
});

const HostedSeatRequestsSchema = Schema.Struct({
  requests: Schema.Array(HostedSeatRequestSchema),
});

const AliasRemapSchema = Schema.Struct({
  model: Schema.String.pipe(
    Schema.check(Schema.isTrimmed(), Schema.isNonEmpty(), Schema.isMaxLength(256)),
  ),
});

type HostedSeatStatus = typeof HostedSeatStatusSchema.Type;
type HostedSeatRequest = typeof HostedSeatRequestSchema.Type;

interface AliasRemap {
  readonly alias: string;
  readonly model: string;
}

const decodeHostedSeatStatus = Schema.decodeUnknownSync(HostedSeatStatusSchema, {
  onExcessProperty: "error",
});
const decodeHostedSeatRequests = Schema.decodeUnknownSync(HostedSeatRequestsSchema, {
  onExcessProperty: "error",
});

const requestJson = async <A,>(
  url: string,
  decode: (input: unknown) => A,
  init?: RequestInit,
): Promise<A> => {
  const response = await fetch(url, { credentials: "same-origin", ...init });
  if (!response.ok) {
    const detail = (await response.text()).trim().slice(0, 500);
    throw new Error(`HTTP ${response.status}${detail.length > 0 ? `: ${detail}` : ""}`);
  }
  const payload: unknown = await response.json();
  return decode(payload);
};

const statusQueryKey = ["hosted-maskirovka-status"];
const requestsQueryKey = ["hosted-maskirovka-requests"];

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      refetchInterval: 5_000,
      refetchIntervalInBackground: false,
      refetchOnWindowFocus: true,
      retry: 1,
    },
  },
});

const dateTime = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "medium",
});

const formatTimestamp = (timestamp: number | undefined): string => {
  if (timestamp === undefined || timestamp <= 0) return "Not recorded";
  const date = new Date(timestamp);
  return Number.isNaN(date.getTime()) ? String(timestamp) : dateTime.format(date);
};

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const Fact = ({ label, children }: { readonly label: string; readonly children: ReactNode }) => (
  <div className="grid items-baseline gap-1 border-t border-kumo-hairline pt-2 sm:grid-cols-[minmax(7.5rem,0.8fr)_minmax(0,1.2fr)]">
    <dt className="m-0 text-xs tracking-wider text-kumo-subtle uppercase">{label}</dt>
    <dd className="m-0 wrap-break-word sm:text-right">{children}</dd>
  </div>
);

const Summary = ({ snapshot }: { readonly snapshot: HostedSeatStatus | undefined }) => {
  const containerHealthy = snapshot?.ok === true && snapshot.container.status === "running";
  const containerFailed =
    snapshot !== undefined &&
    (snapshot.container.status === "error" || snapshot.container.status.startsWith("stopped"));
  return (
    <section className="mt-7" aria-labelledby="seat-summary-heading">
      <div className="mb-3 flex flex-wrap items-baseline justify-between gap-x-4 gap-y-2">
        <h2
          id="seat-summary-heading"
          className="m-0 text-2xl font-semibold text-kumo-strong uppercase"
        >
          Leaf status
        </h2>
        <p className="m-0 text-xs text-kumo-subtle uppercase">
          One provider · one container · one persistent control plane
        </p>
      </div>
      <div className="maskirovka-grid">
        <LayerCard className="p-4">
          <div className="flex items-start justify-between gap-3">
            <h3 className="m-0 text-lg font-semibold text-kumo-strong uppercase">Service</h3>
            <HostedSeatBadge status={snapshot?.ok ? "success" : snapshot ? "error" : "warning"}>
              {snapshot ? (snapshot.ok ? "ready" : "degraded") : "loading"}
            </HostedSeatBadge>
          </div>
          <dl className="mt-4 mb-0 grid gap-3">
            <Fact label="Seat identifier">{snapshot?.seat_id ?? "Loading…"}</Fact>
            <Fact label="Provider">{snapshot?.provider ?? "Loading…"}</Fact>
            <Fact label="Scope">{snapshot?.capabilities.scope ?? "Loading…"}</Fact>
          </dl>
        </LayerCard>

        <LayerCard className="p-4">
          <div className="flex items-start justify-between gap-3">
            <h3 className="m-0 text-lg font-semibold text-kumo-strong uppercase">Container</h3>
            <HostedSeatBadge
              status={containerHealthy ? "success" : containerFailed ? "error" : "warning"}
            >
              {snapshot?.container.status ?? "loading"}
            </HostedSeatBadge>
          </div>
          <dl className="mt-4 mb-0 grid gap-3">
            <Fact label="Lifecycle">{snapshot?.container.status ?? "Loading…"}</Fact>
            <Fact label="Last change">{formatTimestamp(snapshot?.container.last_change)}</Fact>
            <Fact label="Traffic">
              {snapshot
                ? snapshot.controls.killed
                  ? "Stopped at leaf"
                  : "Accepting requests"
                : "Loading…"}
            </Fact>
          </dl>
        </LayerCard>

        <LayerCard className="p-4">
          <div className="flex items-start justify-between gap-3">
            <h3 className="m-0 text-lg font-semibold text-kumo-strong uppercase">Provider auth</h3>
            <HostedSeatBadge
              status={
                !snapshot
                  ? "warning"
                  : snapshot.auth.persisted
                    ? "success"
                    : snapshot.auth.configured
                      ? "warning"
                      : "error"
              }
            >
              {!snapshot
                ? "loading"
                : snapshot.auth.persisted
                  ? "checkpointed"
                  : snapshot.auth.configured
                    ? "configured"
                    : "missing"}
            </HostedSeatBadge>
          </div>
          <dl className="mt-4 mb-0 grid gap-3">
            <Fact label="Configured">
              {snapshot ? (snapshot.auth.configured ? "Yes" : "No") : "Loading…"}
            </Fact>
            <Fact label="Persisted">
              {snapshot ? (snapshot.auth.persisted ? "Yes" : "No") : "Loading…"}
            </Fact>
            <Fact label="Revision">{snapshot?.auth.revision ?? "Loading…"}</Fact>
            <Fact label="Updated">{formatTimestamp(snapshot?.auth.updated_at)}</Fact>
          </dl>
        </LayerCard>

        <LayerCard className="p-4">
          <div className="flex items-start justify-between gap-3">
            <h3 className="m-0 text-lg font-semibold text-kumo-strong uppercase">Access</h3>
            <HostedSeatBadge
              status={snapshot?.access.can_admin ? "success" : snapshot ? "neutral" : "warning"}
            >
              {snapshot?.access.can_admin ? "admin" : snapshot ? "read only" : "loading"}
            </HostedSeatBadge>
          </div>
          <dl className="mt-4 mb-0 grid gap-3">
            <Fact label="Role">{snapshot?.access.role ?? "Loading…"}</Fact>
            <Fact label="Session">
              {snapshot
                ? snapshot.access.service_token
                  ? "Service token"
                  : "Human Access"
                : "Loading…"}
            </Fact>
            <Fact label="Controls">
              {snapshot ? (snapshot.access.can_admin ? "Enabled" : "Read only") : "Loading…"}
            </Fact>
          </dl>
        </LayerCard>
      </div>
    </section>
  );
};

const rootRoute = createRootRoute({ component: () => <Outlet /> });
const dashboardRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  component: Dashboard,
});
const router = createRouter({
  routeTree: rootRoute.addChildren([dashboardRoute]),
  basepath: "/_",
});

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}

function Dashboard() {
  const status = useQuery({
    queryKey: statusQueryKey,
    queryFn: ({ signal }) => requestJson("/admin/status", decodeHostedSeatStatus, { signal }),
  });
  const requests = useQuery({
    queryKey: requestsQueryKey,
    queryFn: ({ signal }) =>
      requestJson("/admin/requests?limit=100", decodeHostedSeatRequests, { signal }),
  });
  const remap = useMutation({
    mutationFn: ({ alias, model }: AliasRemap) =>
      requestJson(`/admin/aliases/${encodeURIComponent(alias)}`, decodeHostedSeatStatus, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model }),
      }),
    onSuccess: (next) => queryClient.setQueryData(statusQueryKey, next),
  });
  const killSwitch = useMutation({
    mutationFn: (enabled: boolean) =>
      requestJson("/admin/kill-switch", decodeHostedSeatStatus, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ enabled }),
      }),
    onSuccess: (next) => queryClient.setQueryData(statusQueryKey, next),
  });

  const snapshot = status.data;
  const aliases = Object.entries(snapshot?.aliases ?? {}).sort(([left], [right]) =>
    left.localeCompare(right),
  );
  const requestItems: readonly HostedSeatRequest[] = requests.data?.requests ?? [];
  const mutationError = remap.error ?? killSwitch.error;
  const controlsDisabled =
    snapshot === undefined || !snapshot.access.can_admin || status.error !== null;

  return (
    <main className="maskirovka-shell">
      <header className="flex flex-wrap items-end justify-between gap-5 border-b-2 border-kumo-line pb-5">
        <div>
          <p className="m-0 text-xs tracking-wider text-kumo-subtle uppercase">
            Stavka / hosted leaf / operations
          </p>
          <h1 className="m-0 text-5xl font-semibold tracking-tight text-kumo-strong uppercase">
            Maskirovka seat
          </h1>
          <p className="mt-2 mb-0 max-w-3xl text-kumo-subtle">
            A truthful view of one hosted provider seat. Changes here affect this leaf only.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <HostedSeatBadge
            status={status.isFetching ? "warning" : snapshot?.ok ? "success" : "error"}
          >
            {status.isFetching ? "refreshing" : (snapshot?.provider ?? "unavailable")}
          </HostedSeatBadge>
          <HostedSeatBadge
            status={snapshot?.controls.killed ? "error" : snapshot ? "success" : "warning"}
          >
            {snapshot?.controls.killed ? "Leaf stopped" : snapshot ? "Leaf enabled" : "Loading"}
          </HostedSeatBadge>
        </div>
      </header>

      <div className="maskirovka-content">
        {status.error ? (
          <div className="mt-7">
            <Banner
              variant="error"
              title="Hosted seat status unavailable"
              description={errorMessage(status.error)}
            />
          </div>
        ) : null}
        {mutationError ? (
          <div className="mt-7">
            <Banner
              variant="error"
              title="Control update failed"
              description={errorMessage(mutationError)}
            />
          </div>
        ) : null}

        <Summary snapshot={snapshot} />

        <LayerCard
          className="mt-7 flex flex-wrap items-center justify-between gap-4 p-4 max-sm:flex-col max-sm:items-start"
          aria-labelledby="kill-switch-heading"
        >
          <div className="max-w-3xl">
            <p className="m-0 text-xs tracking-wider text-kumo-subtle uppercase">
              Persistent leaf control
            </p>
            <h2
              id="kill-switch-heading"
              className="text-2xl font-semibold text-kumo-strong uppercase"
            >
              Kill switch
            </h2>
            <p className="mb-0">
              Stops new model traffic on this seat and remains in force across container restarts.
              It does not stop or reroute any other seat.
            </p>
            <p className="text-xs text-kumo-subtle uppercase">
              Last changed {formatTimestamp(snapshot?.controls.updated_at)}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <HostedSeatBadge
              status={snapshot?.controls.killed ? "error" : snapshot ? "success" : "warning"}
            >
              {snapshot?.controls.killed ? "Stopped" : snapshot ? "Enabled" : "Loading"}
            </HostedSeatBadge>
            <Button
              type="button"
              variant={snapshot?.controls.killed ? "primary" : "destructive"}
              disabled={controlsDisabled || killSwitch.isPending}
              aria-pressed={snapshot?.controls.killed ?? false}
              onClick={() => {
                if (snapshot) killSwitch.mutate(!snapshot.controls.killed);
              }}
            >
              {killSwitch.isPending
                ? "Updating…"
                : snapshot?.controls.killed
                  ? "Restore this seat"
                  : "Stop this seat"}
            </Button>
          </div>
        </LayerCard>

        <section className="mt-7" aria-labelledby="aliases-heading">
          <div className="mb-3 flex flex-wrap items-baseline justify-between gap-x-4 gap-y-2">
            <h2
              id="aliases-heading"
              className="m-0 text-2xl font-semibold text-kumo-strong uppercase"
            >
              Effective aliases
            </h2>
            <p className="m-0 text-xs text-kumo-subtle uppercase">
              Model remap only · {aliases.length} configured
            </p>
          </div>
          {snapshot === undefined ? (
            <div
              className="rounded-sm border border-kumo-hairline bg-kumo-base p-4 text-xs text-kumo-subtle uppercase"
              role="status"
            >
              Loading effective alias map…
            </div>
          ) : aliases.length > 0 ? (
            <div className="maskirovka-grid">
              {aliases.map(([alias, model]) => (
                <LayerCard key={alias} className="p-4">
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <h3 className="m-0 text-base wrap-break-word text-kumo-subtle">{alias}</h3>
                      <p className="mt-1 mb-0 text-xs wrap-break-word text-kumo-subtle">
                        Current: {model}
                      </p>
                    </div>
                    <HostedSeatBadge status={snapshot?.access.can_admin ? "success" : "neutral"}>
                      {snapshot?.access.can_admin ? "editable" : "read only"}
                    </HostedSeatBadge>
                  </div>
                  <fieldset
                    className="mt-4 min-w-0 border-0 p-0 disabled:opacity-60"
                    disabled={controlsDisabled || remap.isPending}
                    aria-disabled={controlsDisabled || remap.isPending}
                  >
                    <HostedSeatSettingsForm
                      key={`${alias}:${model}`}
                      schema={AliasRemapSchema}
                      defaultValues={{ model }}
                      fields={[
                        {
                          name: "model",
                          label: "Concrete provider model",
                          type: "text",
                          placeholder: "Provider model identifier",
                        },
                      ]}
                      submitLabel={
                        remap.isPending && remap.variables?.alias === alias
                          ? "Applying…"
                          : "Apply model"
                      }
                      onSubmit={(value) => {
                        remap.mutate({ alias, model: value.model });
                      }}
                    />
                  </fieldset>
                </LayerCard>
              ))}
            </div>
          ) : (
            <Banner
              variant="secondary"
              title="No aliases reported"
              description="This seat did not return any effective aliases."
            />
          )}
          {!snapshot?.access.can_admin && snapshot ? (
            <p className="text-xs text-kumo-subtle uppercase">
              Your {snapshot.access.role} Access role can inspect this seat but cannot change it.
            </p>
          ) : null}
        </section>

        <section className="mt-7" aria-labelledby="requests-heading">
          <div className="mb-3 flex flex-wrap items-baseline justify-between gap-x-4 gap-y-2">
            <h2
              id="requests-heading"
              className="m-0 text-2xl font-semibold text-kumo-strong uppercase"
            >
              Recent request metadata
            </h2>
            <p className="m-0 text-xs text-kumo-subtle uppercase">
              {snapshot?.requests.retained ?? requestItems.length} retained · limit{" "}
              {snapshot?.requests.limit ?? "—"} · metadata only
            </p>
          </div>
          {requests.error ? (
            <Banner
              variant="error"
              title="Request feed unavailable"
              description={errorMessage(requests.error)}
            />
          ) : requestItems.length === 0 ? (
            <div
              className="border border-kumo-hairline bg-kumo-contrast p-12 text-center text-xs text-kumo-inverse uppercase"
              role="status"
            >
              {requests.isPending
                ? "Loading request metadata…"
                : "No request metadata retained yet"}
            </div>
          ) : (
            <>
              <p className="mb-2 text-[0.65rem] tracking-wider text-kumo-subtle uppercase">
                Timestamp · dialect · alias → concrete model · HTTP status · latency · queue depth
              </p>
              <HostedSeatLogFeed
                items={requestItems}
                getKey={(item) => item.request_id}
                height={420}
                estimateSize={44}
                renderItem={(item) => (
                  <span className="inline-flex min-w-max items-center gap-2 whitespace-nowrap">
                    <strong>{formatTimestamp(item.timestamp)}</strong>
                    <span>· {item.dialect}</span>
                    <span>
                      · {item.alias} → {item.model}
                    </span>
                    <HostedSeatBadge
                      status={item.status >= 200 && item.status < 400 ? "success" : "error"}
                    >
                      HTTP {item.status}
                    </HostedSeatBadge>
                    <span>· {item.latency_ms} ms</span>
                    <span>· queue {item.queue_depth}</span>
                  </span>
                )}
              />
            </>
          )}
        </section>

        <section className="mt-7" aria-labelledby="boundary-heading">
          <Banner
            variant="secondary"
            title="Orchestration boundary"
            description="Registry management, cross-seat fallback and routing, and shared budget controls belong to the Maskirovka orchestration gateway. They are intentionally unavailable on this single hosted leaf."
          />
          <div id="boundary-heading" className="mt-3 flex flex-wrap gap-2">
            <HostedSeatBadge>{snapshot?.capabilities.tier_remap ?? "model-only"}</HostedSeatBadge>
            <HostedSeatBadge>
              {snapshot?.capabilities.kill_switch ?? "this-seat-only"}
            </HostedSeatBadge>
            {(snapshot?.capabilities.unsupported ?? []).map((capability) => (
              <HostedSeatBadge key={capability} status="neutral">
                Unavailable: {capability}
              </HostedSeatBadge>
            ))}
          </div>
        </section>

        <footer className="mt-7 border-t border-kumo-hairline pt-3 text-xs text-kumo-subtle uppercase">
          Last status refresh{" "}
          {formatTimestamp(status.dataUpdatedAt > 0 ? status.dataUpdatedAt : undefined)} · polling
          every 5 seconds while focused
        </footer>
      </div>
    </main>
  );
}

const root = document.querySelector("#root");
if (!root) throw new Error("Hosted Maskirovka dashboard root is missing");

createRoot(root).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  </StrictMode>,
);
