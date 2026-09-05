import { Badge } from "@cloudflare/kumo/components/badge";
import { Banner } from "@cloudflare/kumo/components/banner";
import { Empty } from "@cloudflare/kumo/components/empty";
import { Collapsible } from "@cloudflare/kumo/components/collapsible";
import { ClipboardText } from "@cloudflare/kumo/components/clipboard-text";
import { Code } from "@cloudflare/kumo/components/code";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { readProviderAccounts } from "../../account-api";
import { CheckedAt, Loading, Refresh } from "../../components/page-state";
import { PageActions } from "../../components/shell";

export const Route = createFileRoute("/settings/providers")({ component: ProviderSettings });
const cloudflareProfile = "production";
const setupCommands = {
  codex: [
    "pnpm stavka -- codex login production",
    `pnpm stavka -- auth push --account codex/production --cloudflare ${cloudflareProfile}`,
  ],
  claude: [
    "claude setup-token | pnpm stavka -- claude login production --token-stdin",
    `pnpm stavka -- auth push --account claude/production --cloudflare ${cloudflareProfile}`,
  ],
} as const;
function ConnectionGuide() {
  return (
    <div className="provider-guide">
      <p>
        Authorize locally, then upload the encrypted credential. It is bound to your signed-in
        Stavka profile.
      </p>
      {(["codex", "claude"] as const).map((provider) => (
        <section className="space-y-3" key={provider}>
          <h2>{provider === "codex" ? "Codex subscription" : "Claude Code subscription"}</h2>
          <ol className="m-0 list-decimal space-y-3 pl-5">
            {setupCommands[provider].map((command) => (
              <li key={command}>
                <div className="provider-command">
                  <Code code={command} className="min-w-0 flex-1 whitespace-normal" />
                  <ClipboardText text="Copy" textToCopy={command} size="sm" />
                </div>
              </li>
            ))}
          </ol>
        </section>
      ))}
    </div>
  );
}
const authLabels = {
  "chatgpt-oauth": "ChatGPT sign-in",
  "claude-subscription": "Claude subscription",
  "anthropic-api-key": "Anthropic API key",
};
export function ProviderSettings() {
  const accounts = useQuery({
    queryKey: ["stavka-provider-accounts"],
    queryFn: readProviderAccounts,
    retry: false,
  });
  return (
    <div className="stavka-pane space-y-4">
      <PageActions>
        <CheckedAt timestamp={accounts.dataUpdatedAt} />
        <Refresh loading={accounts.isFetching} onClick={() => void accounts.refetch()} />
      </PageActions>
      <p className="text-sm text-kumo-subtle">
        Connected provider credentials are private to your profile.
      </p>
      {accounts.error ? (
        <Banner
          variant="error"
          title="Provider accounts unavailable"
          description={accounts.error.message}
        />
      ) : accounts.isPending || accounts.data.length ? (
        <section className="stavka-panel">
          <div className="table-scroll">
            <table className="operations-table">
              <thead>
                <tr>
                  {["Label", "Provider", "Auth method", "Connected", "Updated", "Status"].map(
                    (header) => (
                      <th key={header}>{header}</th>
                    ),
                  )}
                </tr>
              </thead>
              <tbody>
                {accounts.isPending ? (
                  <tr>
                    <td colSpan={6}>
                      <Loading label="Loading provider accounts" />
                    </td>
                  </tr>
                ) : (
                  accounts.data.map((account) => (
                    <tr key={`${account.provider}/${account.name}`}>
                      <td>{account.label}</td>
                      <td>{account.provider === "codex" ? "Codex" : "Claude"}</td>
                      <td>{authLabels[account.authKind]}</td>
                      <td>
                        <time title={new Date(account.createdAt).toLocaleString()}>
                          {new Date(account.createdAt).toLocaleDateString()}
                        </time>
                      </td>
                      <td>
                        <time title={new Date(account.updatedAt).toLocaleString()}>
                          {new Date(account.updatedAt).toLocaleDateString()}
                        </time>
                      </td>
                      <td>
                        <Badge variant={account.active ? "success" : "secondary"}>
                          {account.active ? "Active" : "Inactive"}
                        </Badge>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </section>
      ) : (
        <section className="stavka-panel">
          <Empty
            className="rounded-none border-0 [&_h2]:text-sm"
            size="sm"
            title="Connect your first provider"
            description="Use the CLI commands below to authorize a subscription."
          />
          <ConnectionGuide />
        </section>
      )}
      {accounts.data?.length ? (
        <Collapsible.Root className="stavka-panel p-4">
          <Collapsible.DefaultTrigger>Connect another account</Collapsible.DefaultTrigger>
          <Collapsible.Panel>
            <ConnectionGuide />
          </Collapsible.Panel>
        </Collapsible.Root>
      ) : null}
    </div>
  );
}
