import { QueryClient, QueryClientProvider, useMutation, useQuery } from "@tanstack/react-query";
import {
  Outlet,
  RouterProvider,
  createRootRoute,
  createRoute,
  createRouter,
} from "@tanstack/react-router";
import { Schema } from "effect";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import {
  Button,
  LogFeed,
  OrderCallout,
  SchemaForm,
  SeatCard,
  Stamp,
  StatusChip,
} from "@stavka/ui";

import "./styles.css";

type Tier = "stavka/commander" | "stavka/sergeant" | "stavka/heavy";
type Seat = "mock" | "claude" | "codex" | "api";

interface AliasResolution {
  readonly tier: Tier;
  readonly seat: Seat;
  readonly model: string;
}

interface SeatHealth {
  readonly id: Seat;
  readonly name: string;
  readonly status: "healthy" | "unavailable" | "unchecked" | "exhausted";
  readonly active: number;
  readonly queueDepth: number;
  readonly callsInWindow: number;
  readonly tokensInWindow: number;
  readonly budgetKind: "plan-credit" | "metered-cash" | "none";
  readonly budgetLimitUsd: number;
  readonly budgetUsedUsd: number;
  readonly headroom: {
    readonly kind: "monthly-plan-credit" | "rolling-plan-window" | "metered-cash" | "unlimited";
    readonly durable: boolean;
    readonly estimated: true;
    readonly resetsAt: string;
    readonly creditLimitUsd?: number;
    readonly callLimit?: number;
    readonly tokenLimit?: number;
    readonly remainingCreditUsd?: number;
    readonly remainingCalls?: number;
    readonly remainingTokens?: number;
  };
}

interface GatewayHealth {
  readonly ok: boolean;
  readonly mode: string;
  readonly killed: boolean;
  readonly aliases: readonly AliasResolution[];
  readonly seats: readonly SeatHealth[];
  readonly savings: {
    readonly requests: number;
    readonly cacheHits: number;
    readonly actualCostUsd: number;
    readonly planCreditUsd: number;
    readonly apiListEquivalentUsd: number;
    readonly savedVsApiUsd: number;
  };
  readonly accounting: {
    readonly kind: "estimate";
    readonly durable: boolean;
    readonly trackedSince: string;
    readonly note: string;
  };
}

interface RequestLog {
  readonly requestId: string;
  readonly timestamp: string;
  readonly tier: Tier;
  readonly seat: Seat;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly latencyMs: number;
  readonly queueDepth: number;
  readonly cacheHit: boolean;
}

const RemapSchema = Schema.Struct({
  seat: Schema.Literals(["mock", "claude", "codex", "api"]),
  model: Schema.String.pipe(Schema.check(Schema.isMinLength(1))),
});

const requestJson = async <T,>(url: string, init?: RequestInit): Promise<T> => {
  const response = await fetch(url, init);
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${await response.text()}`);
  return response.json() as Promise<T>;
};

const headroomLabel = (seat: SeatHealth): string => {
  const remaining = [
    seat.headroom.remainingCreditUsd === undefined
      ? undefined
      : `$${seat.headroom.remainingCreditUsd.toFixed(2)} / $${(seat.headroom.creditLimitUsd ?? 0).toFixed(2)} credit`,
    seat.headroom.remainingCalls === undefined
      ? undefined
      : `${seat.headroom.remainingCalls} / ${seat.headroom.callLimit ?? 0} calls`,
    seat.headroom.remainingTokens === undefined
      ? undefined
      : `${seat.headroom.remainingTokens} / ${seat.headroom.tokenLimit ?? 0} tokens`,
  ].filter((value): value is string => value !== undefined);
  return remaining.length === 0 ? seat.headroom.kind : `${remaining.join(" / ")} remaining`;
};

const queryClient = new QueryClient({
  defaultOptions: { queries: { refetchInterval: 2_000, retry: 1 } },
});

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
  const health = useQuery({
    queryKey: ["maskirovka-health"],
    queryFn: () => requestJson<GatewayHealth>("/admin/status"),
  });
  const requests = useQuery({
    queryKey: ["maskirovka-requests"],
    queryFn: () => requestJson<{ requests: readonly RequestLog[] }>("/admin/requests?limit=200"),
  });
  const remap = useMutation({
    mutationFn: ({ tier, seat, model }: AliasResolution) => requestJson(`/admin/aliases/${encodeURIComponent(tier)}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ seat, model }),
    }),
    onSuccess: async () => queryClient.invalidateQueries({ queryKey: ["maskirovka-health"] }),
  });
  const killSwitch = useMutation({
    mutationFn: (enabled: boolean) => requestJson<{ killed: boolean }>("/admin/kill-switch", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ enabled }),
    }),
    onSuccess: async () => queryClient.invalidateQueries({ queryKey: ["maskirovka-health"] }),
  });
  const snapshot = health.data;

  return (
    <main className="maskirovka-shell">
      <header className="mb-5 flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="stavka-grid-label m-0">Stavka / seat gateway / operations</p>
          <h1 className="m-0 font-display text-5xl tracking-tight uppercase">Maskirovka</h1>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <StatusChip tone={snapshot?.ok ? "works" : "broken"}>{snapshot?.mode ?? "loading"}</StatusChip>
          <Stamp tone={snapshot?.killed ? "broken" : "works"}>{snapshot?.killed ? "Traffic stopped" : "Traffic enabled"}</Stamp>
          <Button
            tone={snapshot?.killed ? "primary" : "danger"}
            disabled={!snapshot || killSwitch.isPending}
            onClick={() => killSwitch.mutate(!snapshot?.killed)}
          >
            {snapshot?.killed ? "Restore traffic" : "Kill live traffic"}
          </Button>
        </div>
      </header>

      <div className="maskirovka-content">
        {health.error ? <OrderCallout title="Gateway unavailable" priority="urgent">{health.error.message}</OrderCallout> : null}

        <section>
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h2 className="font-display text-2xl uppercase">Seats</h2>
            <p className="font-data text-xs uppercase">
              {snapshot?.accounting.note ?? "Loading quota estimate scope"}
            </p>
          </div>
          <div className="maskirovka-grid">
            {(snapshot?.seats ?? []).map((seat) => (
              <SeatCard
                key={seat.id}
                name={seat.name}
                provider={seat.id}
                healthy={seat.status === "healthy"}
                mode={`${seat.status} · ${seat.budgetKind} · ${headroomLabel(seat)} · ${seat.active} active · ${seat.queueDepth} queued`}
                budgetUsed={seat.budgetUsedUsd}
                budgetTotal={seat.budgetLimitUsd}
                models={(snapshot?.aliases ?? []).filter((alias) => alias.seat === seat.id).map((alias) => alias.model)}
              />
            ))}
          </div>
        </section>

        <section className="mt-6">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h2 className="font-display text-2xl uppercase">Tier map</h2>
            <p className="font-data text-xs uppercase">
              {snapshot?.savings.requests ?? 0} requests · cash ~${(snapshot?.savings.actualCostUsd ?? 0).toFixed(4)} · plan credit ~${(snapshot?.savings.planCreditUsd ?? 0).toFixed(4)} · saved ~${(snapshot?.savings.savedVsApiUsd ?? 0).toFixed(4)}
            </p>
          </div>
          <div className="maskirovka-grid">
            {(snapshot?.aliases ?? []).map((alias) => (
              <section key={alias.tier} className="stavka-panel p-4">
                <h3 className="mt-0 font-display text-lg uppercase">{alias.tier}</h3>
                <SchemaForm
                  schema={RemapSchema}
                  defaultValues={{ seat: alias.seat, model: alias.model }}
                  fields={[
                    { name: "seat", label: "Seat", type: "select", options: [
                      { value: "mock", label: "Mock" },
                      { value: "claude", label: "Claude SDK" },
                      { value: "codex", label: "Codex SDK" },
                      { value: "api", label: "Metered API" },
                    ] },
                    { name: "model", label: "Concrete model", type: "text" },
                  ]}
                  submitLabel="Apply mapping"
                  onSubmit={async (value) => {
                    await remap.mutateAsync({
                      tier: alias.tier,
                      seat: value.seat,
                      model: String(value.model),
                    });
                  }}
                />
              </section>
            ))}
          </div>
        </section>

        <section className="mt-6">
          <h2 className="font-display text-2xl uppercase">Request feed</h2>
          <LogFeed
            items={requests.data?.requests ?? []}
            getKey={(item) => item.requestId}
            renderItem={(item) => (
              <span>
                <strong>{new Date(item.timestamp).toLocaleTimeString()}</strong> · {item.tier} · {item.seat} · {item.inputTokens + item.outputTokens} tok · {item.latencyMs} ms · queue {item.queueDepth} · {item.cacheHit ? "cache hit" : "cache miss"}
              </span>
            )}
            height={420}
          />
        </section>
      </div>
    </main>
  );
}

const root = document.querySelector("#root");
if (!root) throw new Error("Maskirovka dashboard root is missing");
createRoot(root).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  </StrictMode>,
);
