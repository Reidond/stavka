import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import { Badge } from "@cloudflare/kumo/components/badge";
import { Banner } from "@cloudflare/kumo/components/banner";
import { LayerCard } from "@cloudflare/kumo/components/layer-card";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import "./styles.css";

type Provider = "claude" | "codex";
type AuthStatus = {
  provider: Provider;
  configured: boolean;
  persisted: boolean;
  revision: number;
  updated_at?: number;
  activeAccount?: string;
};
type ProviderAccount = {
  provider: Provider;
  name: string;
  label: string;
  authKind: string;
  active: boolean;
  revision: number;
  updatedAt: number;
};
type GatewayStatus = {
  ok: boolean;
  killed: boolean;
  container: { status: string; last_change: number };
  auth: Record<Provider, AuthStatus>;
  providerAccounts: readonly ProviderAccount[];
  aliases: readonly { tier: string; seat: string; model: string }[];
  requests: { retained: number; limit: number; metadata_only: true };
};

const queryClient = new QueryClient({
  defaultOptions: { queries: { refetchInterval: 2_000, retry: 1 } },
});

const requestJson = async <T,>(url: string, init?: RequestInit): Promise<T> => {
  const response = await fetch(url, init);
  if (!response.ok) {
    const body = (await response.json().catch(() => undefined)) as
      | { error?: { message?: string } }
      | undefined;
    throw new Error(body?.error?.message ?? `HTTP ${response.status}`);
  }
  return response.json() as Promise<T>;
};

function ProviderAccountsPanel({
  provider,
  status,
  accounts,
}: {
  provider: Provider;
  status?: AuthStatus;
  accounts: readonly ProviderAccount[];
}) {
  return (
    <LayerCard className="space-y-4 p-4">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h3 className="m-0 text-lg uppercase">{provider} accounts</h3>
        <Badge variant={status?.configured ? "success" : "error"}>
          {status?.configured ? "Configured" : "Not configured"}
        </Badge>
      </div>
      <p className="text-sm text-kumo-subtle">
        Named accounts are provisioned by the Stavka CLI and encrypted in the gateway vault. Secret
        values are never accepted or rendered by this dashboard.
      </p>
      <ul className="space-y-2 text-sm">
        {accounts.length ? (
          accounts.map((account) => (
            <li key={`${account.provider}/${account.name}`}>
              <strong>{account.name}</strong> · {account.label} · {account.authKind}
              {account.active ? " · active" : ""}
            </li>
          ))
        ) : (
          <li>No {provider} accounts provisioned.</li>
        )}
      </ul>
      <code className="block overflow-x-auto text-xs">
        stavka auth push --cloudflare &lt;profile&gt; --account {provider}/&lt;name&gt;
      </code>
    </LayerCard>
  );
}

function Dashboard() {
  const status = useQuery({
    queryKey: ["gateway-status"],
    queryFn: () => requestJson<GatewayStatus>("/admin/status"),
  });
  const snapshot = status.data;
  return (
    <main className="maskirovka-gateway-shell">
      <header className="mb-5 flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="m-0 text-xs tracking-[0.2em] text-kumo-subtle uppercase">
            Stavka / gateway / Access admin
          </p>
          <h1 className="m-0 text-5xl font-semibold tracking-tight text-kumo-strong uppercase">
            Maskirovka
          </h1>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant={snapshot?.ok ? "success" : "error"}>
            {snapshot?.container.status ?? "loading"}
          </Badge>
          <Badge variant={snapshot?.killed ? "error" : "success"}>
            {snapshot?.killed ? "Traffic stopped" : "Traffic enabled"}
          </Badge>
        </div>
      </header>
      <div className="maskirovka-gateway-content">
        {status.error ? (
          <Banner variant="error" title="Gateway unavailable" description={status.error.message} />
        ) : null}
        <section className="mb-6 grid gap-4 md:grid-cols-2">
          <ProviderAccountsPanel
            provider="claude"
            {...(snapshot?.auth.claude ? { status: snapshot.auth.claude } : {})}
            accounts={(snapshot?.providerAccounts ?? []).filter(
              (account) => account.provider === "claude",
            )}
          />
          <ProviderAccountsPanel
            provider="codex"
            {...(snapshot?.auth.codex ? { status: snapshot.auth.codex } : {})}
            accounts={(snapshot?.providerAccounts ?? []).filter(
              (account) => account.provider === "codex",
            )}
          />
        </section>
        <LayerCard className="p-4">
          <h2 className="m-0 text-xl font-semibold text-kumo-strong uppercase">Gateway status</h2>
          <p className="text-sm text-kumo-subtle">
            {snapshot?.requests.retained ?? 0} metadata-only requests retained. Provider credentials
            are never included in this feed.
          </p>
          <ul className="space-y-1 text-sm">
            {(snapshot?.aliases ?? []).map((alias) => (
              <li key={alias.tier}>
                {alias.tier} → {alias.seat} / {alias.model}
              </li>
            ))}
          </ul>
        </LayerCard>
      </div>
    </main>
  );
}

const root = document.querySelector("#root");
if (!root) throw new Error("Maskirovka gateway dashboard root is missing");
createRoot(root).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <Dashboard />
    </QueryClientProvider>
  </StrictMode>,
);
