import { QueryClient, QueryClientProvider, useMutation, useQuery } from "@tanstack/react-query";
import {
  Outlet,
  RouterProvider,
  createRootRoute,
  createRoute,
  createRouter,
} from "@tanstack/react-router";
import { Button, LogFeed, OrderCallout, SchemaForm, Stamp, StatusChip } from "@stavka/ui";
import { Schema } from "effect";
import { StrictMode, type ReactNode } from "react";
import { createRoot } from "react-dom/client";

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
  <div className="grid items-baseline gap-1 border-t border-contour pt-2 sm:grid-cols-[minmax(7.5rem,0.8fr)_minmax(0,1.2fr)]">
    <dt className="stavka-grid-label m-0">{label}</dt>
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
        <h2 id="seat-summary-heading" className="m-0 font-display text-2xl uppercase">
          Leaf status
        </h2>
        <p className="m-0 font-data text-xs uppercase">
          One provider · one container · one persistent control plane
        </p>
      </div>
      <div className="maskirovka-grid">
        <article className="stavka-panel p-4">
          <div className="flex items-start justify-between gap-3">
            <h3 className="m-0 font-display text-lg uppercase">Service</h3>
            <StatusChip tone={snapshot?.ok ? "works" : snapshot ? "broken" : "pending"}>
              {snapshot ? (snapshot.ok ? "ready" : "degraded") : "loading"}
            </StatusChip>
          </div>
          <dl className="mt-4 mb-0 grid gap-3">
            <Fact label="Seat identifier">{snapshot?.seat_id ?? "Loading…"}</Fact>
            <Fact label="Provider">{snapshot?.provider ?? "Loading…"}</Fact>
            <Fact label="Scope">{snapshot?.capabilities.scope ?? "Loading…"}</Fact>
          </dl>
        </article>

        <article className="stavka-panel p-4">
          <div className="flex items-start justify-between gap-3">
            <h3 className="m-0 font-display text-lg uppercase">Container</h3>
            <StatusChip tone={containerHealthy ? "works" : containerFailed ? "broken" : "pending"}>
              {snapshot?.container.status ?? "loading"}
            </StatusChip>
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
        </article>

        <article className="stavka-panel p-4">
          <div className="flex items-start justify-between gap-3">
            <h3 className="m-0 font-display text-lg uppercase">Provider auth</h3>
            <StatusChip
              tone={
                !snapshot
                  ? "pending"
                  : snapshot.auth.persisted
                    ? "works"
                    : snapshot.auth.configured
                      ? "pending"
                      : "broken"
              }
            >
              {!snapshot
                ? "loading"
                : snapshot.auth.persisted
                  ? "checkpointed"
                  : snapshot.auth.configured
                    ? "configured"
                    : "missing"}
            </StatusChip>
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
        </article>

        <article className="stavka-panel p-4">
          <div className="flex items-start justify-between gap-3">
            <h3 className="m-0 font-display text-lg uppercase">Access</h3>
            <StatusChip
              tone={snapshot?.access.can_admin ? "works" : snapshot ? "neutral" : "pending"}
            >
              {snapshot?.access.can_admin ? "admin" : snapshot ? "read only" : "loading"}
            </StatusChip>
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
        </article>
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
      <header className="flex flex-wrap items-end justify-between gap-5 border-b-2 border-ink pb-5">
        <div>
          <p className="stavka-grid-label m-0">Stavka / hosted leaf / operations</p>
          <h1 className="m-0 font-display text-5xl tracking-tight uppercase">Maskirovka seat</h1>
          <p className="mt-2 mb-0 max-w-3xl text-ink/70">
            A truthful view of one hosted provider seat. Changes here affect this leaf only.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <StatusChip tone={status.isFetching ? "pending" : snapshot?.ok ? "works" : "broken"}>
            {status.isFetching ? "refreshing" : (snapshot?.provider ?? "unavailable")}
          </StatusChip>
          <Stamp tone={snapshot?.controls.killed ? "broken" : snapshot ? "works" : "pending"}>
            {snapshot?.controls.killed ? "Leaf stopped" : snapshot ? "Leaf enabled" : "Loading"}
          </Stamp>
        </div>
      </header>

      <div className="maskirovka-content">
        {status.error ? (
          <div className="mt-7">
            <OrderCallout title="Hosted seat status unavailable" priority="urgent">
              {errorMessage(status.error)}
            </OrderCallout>
          </div>
        ) : null}
        {mutationError ? (
          <div className="mt-7">
            <OrderCallout title="Control update failed" priority="urgent">
              {errorMessage(mutationError)}
            </OrderCallout>
          </div>
        ) : null}

        <Summary snapshot={snapshot} />

        <section
          className="stavka-panel mt-7 flex flex-wrap items-center justify-between gap-4 p-4 max-sm:flex-col max-sm:items-start"
          aria-labelledby="kill-switch-heading"
        >
          <div className="max-w-3xl">
            <p className="stavka-grid-label m-0">Persistent leaf control</p>
            <h2 id="kill-switch-heading" className="font-display text-2xl uppercase">
              Kill switch
            </h2>
            <p className="mb-0">
              Stops new model traffic on this seat and remains in force across container restarts. It
              does not stop or reroute any other seat.
            </p>
            <p className="font-data text-xs uppercase">
              Last changed {formatTimestamp(snapshot?.controls.updated_at)}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <Stamp tone={snapshot?.controls.killed ? "broken" : snapshot ? "works" : "pending"}>
              {snapshot?.controls.killed ? "Stopped" : snapshot ? "Enabled" : "Loading"}
            </Stamp>
            <Button
              type="button"
              tone={snapshot?.controls.killed ? "primary" : "danger"}
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
        </section>

        <section className="mt-7" aria-labelledby="aliases-heading">
          <div className="mb-3 flex flex-wrap items-baseline justify-between gap-x-4 gap-y-2">
            <h2 id="aliases-heading" className="m-0 font-display text-2xl uppercase">
              Effective aliases
            </h2>
            <p className="m-0 font-data text-xs uppercase">
              Model remap only · {aliases.length} configured
            </p>
          </div>
          {snapshot === undefined ? (
            <div className="stavka-panel p-4 font-data text-xs uppercase" role="status">
              Loading effective alias map…
            </div>
          ) : aliases.length > 0 ? (
            <div className="maskirovka-grid">
              {aliases.map(([alias, model]) => (
                <article key={alias} className="stavka-panel p-4">
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <h3 className="m-0 font-data text-base wrap-break-word">{alias}</h3>
                      <p className="mt-1 mb-0 font-data text-xs wrap-break-word text-ink/70">
                        Current: {model}
                      </p>
                    </div>
                    <StatusChip tone={snapshot?.access.can_admin ? "works" : "neutral"}>
                      {snapshot?.access.can_admin ? "editable" : "read only"}
                    </StatusChip>
                  </div>
                  <fieldset
                    className="mt-4 min-w-0 border-0 p-0 disabled:opacity-60"
                    disabled={controlsDisabled || remap.isPending}
                    aria-disabled={controlsDisabled || remap.isPending}
                  >
                    <SchemaForm
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
                </article>
              ))}
            </div>
          ) : (
            <OrderCallout title="No aliases reported">
              This seat did not return any effective aliases.
            </OrderCallout>
          )}
          {!snapshot?.access.can_admin && snapshot ? (
            <p className="font-data text-xs uppercase">
              Your {snapshot.access.role} Access role can inspect this seat but cannot change it.
            </p>
          ) : null}
        </section>

        <section className="mt-7" aria-labelledby="requests-heading">
        <div className="mb-3 flex flex-wrap items-baseline justify-between gap-x-4 gap-y-2">
          <h2 id="requests-heading" className="m-0 font-display text-2xl uppercase">
            Recent request metadata
          </h2>
          <p className="m-0 font-data text-xs uppercase">
            {snapshot?.requests.retained ?? requestItems.length} retained · limit{" "}
            {snapshot?.requests.limit ?? "—"} · metadata only
          </p>
        </div>
        {requests.error ? (
          <OrderCallout title="Request feed unavailable" priority="urgent">
            {errorMessage(requests.error)}
          </OrderCallout>
        ) : requestItems.length === 0 ? (
          <div
            className="border border-contour bg-ink p-12 text-center font-data text-xs text-paper uppercase"
            role="status"
          >
            {requests.isPending ? "Loading request metadata…" : "No request metadata retained yet"}
          </div>
        ) : (
          <>
            <p className="mb-2 font-data text-[0.65rem] tracking-wider text-ink/70 uppercase">
              Timestamp · dialect · alias → concrete model · HTTP status · latency · queue depth
            </p>
            <LogFeed
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
                  <StatusChip tone={item.status >= 200 && item.status < 400 ? "works" : "broken"}>
                    HTTP {item.status}
                  </StatusChip>
                  <span>· {item.latency_ms} ms</span>
                  <span>· queue {item.queue_depth}</span>
                </span>
              )}
            />
          </>
        )}
        </section>

        <section className="mt-7" aria-labelledby="boundary-heading">
          <OrderCallout title="Orchestration boundary">
            <p id="boundary-heading" className="m-0">
              Registry management, cross-seat fallback and routing, and shared budget controls belong
              to the Maskirovka orchestration gateway. They are intentionally unavailable on this
              single hosted leaf.
            </p>
            <div className="mt-3 flex flex-wrap gap-2">
              <StatusChip>{snapshot?.capabilities.tier_remap ?? "model-only"}</StatusChip>
              <StatusChip>{snapshot?.capabilities.kill_switch ?? "this-seat-only"}</StatusChip>
              {(snapshot?.capabilities.unsupported ?? []).map((capability) => (
                <StatusChip key={capability} tone="neutral">
                  Unavailable: {capability}
                </StatusChip>
              ))}
            </div>
          </OrderCallout>
        </section>

        <footer className="mt-7 border-t border-contour pt-3 font-data text-xs uppercase">
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
