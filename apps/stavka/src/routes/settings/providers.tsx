import { Badge } from "@cloudflare/kumo/components/badge";
import { Banner } from "@cloudflare/kumo/components/banner";
import { LayerCard } from "@cloudflare/kumo/components/layer-card";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import type { ActiveAccountSession } from "@stavka/access-auth";

import { readAccountSession, readOrganizationUsers, readProviderAccounts } from "../../account-api";
import { accountSessionQueryKey } from "../../components/account-gate";

export const Route = createFileRoute("/settings/providers")({
  component: ProviderSettings,
});

const setupCommands = {
  codex: [
    "pnpm stavka -- codex login production",
    "pnpm stavka -- auth push --account codex/production --cloudflare production",
  ],
  claude: [
    "claude setup-token | pnpm stavka -- claude login production --token-stdin",
    "pnpm stavka -- auth push --account claude/production --cloudflare production",
  ],
} as const;

const ConnectionGuide = ({ provider }: { readonly provider: "codex" | "claude" }) => (
  <LayerCard className="space-y-3 p-4">
    <div className="flex items-center justify-between gap-3">
      <h2 className="m-0 text-base font-semibold text-kumo-strong">
        {provider === "codex" ? "Codex subscription" : "Claude Code subscription"}
      </h2>
      <Badge variant="secondary">{provider}</Badge>
    </div>
    <p className="m-0 text-sm text-kumo-default">
      Authorize locally, then upload the encrypted credential. Stavka binds it to the signed-in
      profile shown above; no user or organization identifier is accepted from the CLI.
    </p>
    <ol className="m-0 space-y-2 pl-5 text-sm text-kumo-default">
      {setupCommands[provider].map((command) => (
        <li key={command}>
          <code className="rounded-sm bg-kumo-tint px-1.5 py-1 text-xs break-all text-kumo-strong">
            {command}
          </code>
        </li>
      ))}
    </ol>
  </LayerCard>
);

export function ProviderSettings() {
  const session = useQuery({
    queryKey: accountSessionQueryKey,
    queryFn: readAccountSession,
    staleTime: 30_000,
  });
  const sessionData = session.data;
  const active: ActiveAccountSession | undefined =
    sessionData?.status === "active" ? sessionData : undefined;
  const users = useQuery({
    queryKey: ["stavka-organization-users"],
    queryFn: readOrganizationUsers,
    enabled: active !== undefined,
  });
  const accounts = useQuery({
    queryKey: ["stavka-provider-accounts"],
    queryFn: readProviderAccounts,
    enabled: active !== undefined,
  });

  return (
    <div className="stavka-pane space-y-4">
      <div className="space-y-1">
        <h1 className="m-0 text-xl font-semibold text-kumo-strong">Provider authorization</h1>
        <p className="m-0 text-sm text-kumo-subtle">
          Codex and Claude subscription credentials are private to your Stavka profile.
        </p>
      </div>

      {active ? <ProfileCard session={active} userCount={users.data?.length} /> : null}
      {session.error || users.error || accounts.error ? (
        <Banner
          variant="error"
          title="Account data unavailable"
          description={(session.error ?? users.error ?? accounts.error)?.message ?? "Unknown error"}
        />
      ) : null}

      <div className="grid gap-4 lg:grid-cols-2">
        <ConnectionGuide provider="codex" />
        <ConnectionGuide provider="claude" />
      </div>

      <section className="space-y-3" aria-labelledby="connected-accounts-title">
        <div className="flex items-center justify-between gap-3">
          <h2
            id="connected-accounts-title"
            className="m-0 text-base font-semibold text-kumo-strong"
          >
            Connected accounts
          </h2>
          <Badge variant="secondary">{accounts.data?.length ?? 0}</Badge>
        </div>
        {accounts.isPending ? (
          <p className="m-0 text-sm text-kumo-subtle">Loading provider accounts…</p>
        ) : null}
        {accounts.data?.length === 0 ? (
          <LayerCard className="p-4">
            <p className="m-0 text-sm text-kumo-default">
              No provider account is connected yet. Complete either authorization flow above.
            </p>
          </LayerCard>
        ) : null}
        <div className="grid gap-3 lg:grid-cols-2">
          {accounts.data?.map((account) => (
            <LayerCard key={`${account.provider}/${account.name}`} className="space-y-2 p-4">
              <div className="flex items-center justify-between gap-3">
                <p className="m-0 font-medium text-kumo-strong">{account.label}</p>
                <Badge variant={account.active ? "success" : "secondary"}>
                  {account.active ? "active" : "inactive"}
                </Badge>
              </div>
              <dl className="m-0 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
                <dt className="text-kumo-subtle">Provider</dt>
                <dd className="m-0 text-kumo-default">{account.provider}</dd>
                <dt className="text-kumo-subtle">Owner</dt>
                <dd className="m-0 text-kumo-default">
                  {account.owner.displayName}
                  {account.owner.email ? ` · ${account.owner.email}` : ""}
                </dd>
                <dt className="text-kumo-subtle">Organization</dt>
                <dd className="m-0 text-kumo-default">{account.organization.name}</dd>
                <dt className="text-kumo-subtle">Auth</dt>
                <dd className="m-0 text-kumo-default">{account.authKind}</dd>
              </dl>
            </LayerCard>
          ))}
        </div>
      </section>
    </div>
  );
}

const ProfileCard = ({
  session,
  userCount,
}: {
  readonly session: ActiveAccountSession;
  readonly userCount: number | undefined;
}) => (
  <LayerCard className="space-y-2 p-4">
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div>
        <p className="m-0 text-xs tracking-wider text-kumo-subtle uppercase">Authorization owner</p>
        <p className="m-0 text-base font-semibold text-kumo-strong">{session.user.displayName}</p>
        {session.user.email ? (
          <p className="m-0 text-sm text-kumo-default">{session.user.email}</p>
        ) : null}
      </div>
      <Badge variant="success">{session.membership.role}</Badge>
    </div>
    <p className="m-0 text-sm text-kumo-default">
      {session.organization.name} · {userCount ?? 1} visible user
      {(userCount ?? 1) === 1 ? "" : "s"}
    </p>
  </LayerCard>
);
