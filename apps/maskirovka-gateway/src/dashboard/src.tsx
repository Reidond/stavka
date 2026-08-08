import { QueryClient, QueryClientProvider, useMutation, useQuery } from "@tanstack/react-query";
import { Badge } from "@cloudflare/kumo/components/badge";
import { Banner } from "@cloudflare/kumo/components/banner";
import { Button } from "@cloudflare/kumo/components/button";
import { Input } from "@cloudflare/kumo/components/input";
import { LayerCard } from "@cloudflare/kumo/components/layer-card";
import { StrictMode, useState } from "react";
import { createRoot } from "react-dom/client";

import "./styles.css";

type Provider = "claude" | "codex";
type AuthStatus = {
  provider: Provider;
  configured: boolean;
  persisted: boolean;
  revision: number;
  updated_at?: number;
};
type GatewayStatus = {
  ok: boolean;
  killed: boolean;
  container: { status: string; last_change: number };
  auth: Record<Provider, AuthStatus>;
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

function ProviderAuthPanel({ provider, status }: { provider: Provider; status?: AuthStatus }) {
  const [token, setToken] = useState("");
  const save = useMutation({
    mutationFn: () =>
      requestJson<AuthStatus>(`/admin/auth/${provider}`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token }),
      }),
    onSuccess: async () => {
      setToken("");
      await queryClient.invalidateQueries({ queryKey: ["gateway-status"] });
    },
  });
  const clear = useMutation({
    mutationFn: () => requestJson<AuthStatus>(`/admin/auth/${provider}`, { method: "DELETE" }),
    onSuccess: async () => {
      setToken("");
      await queryClient.invalidateQueries({ queryKey: ["gateway-status"] });
    },
  });

  return (
    <LayerCard className="space-y-4 p-4">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h3 className="m-0 text-lg uppercase">{provider} subscription auth</h3>
        <Badge variant={status?.configured ? "success" : "error"}>
          {status?.configured ? "Configured" : "Not configured"}
        </Badge>
      </div>
      <p className="text-sm text-kumo-subtle">
        Paste a subscription token. It is written to the gateway Durable Object and is never shown
        again after save.
      </p>
      <Input
        id={`${provider}-token`}
        label="Token"
        type="password"
        autoComplete="new-password"
        value={token}
        onChange={(event) => setToken(event.target.value)}
        placeholder="Paste token; it clears after save"
        passwordManagerIgnore
      />
      <div className="mt-3 flex flex-wrap gap-2">
        <Button
          variant="primary"
          disabled={!token.trim() || save.isPending}
          onClick={() => save.mutate()}
        >
          Save token
        </Button>
        <Button
          variant="destructive"
          disabled={!status?.configured || clear.isPending}
          onClick={() => clear.mutate()}
        >
          Clear token
        </Button>
      </div>
      <p className="mt-3 text-xs text-kumo-subtle">
        {provider === "claude" ? (
          <a
            href="https://docs.anthropic.com/en/docs/claude-code/setup"
            target="_blank"
            rel="noreferrer"
          >
            Create with <code>claude setup-token</code>
          </a>
        ) : (
          <a href="https://platform.openai.com/docs/codex/auth" target="_blank" rel="noreferrer">
            See Codex subscription token setup
          </a>
        )}
      </p>
      {save.error || clear.error ? (
        <Banner
          variant="error"
          title="Credential update failed"
          description={(save.error ?? clear.error)?.message}
        />
      ) : null}
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
          <ProviderAuthPanel
            provider="claude"
            {...(snapshot?.auth.claude ? { status: snapshot.auth.claude } : {})}
          />
          <ProviderAuthPanel
            provider="codex"
            {...(snapshot?.auth.codex ? { status: snapshot.auth.codex } : {})}
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
