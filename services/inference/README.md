# Maskirovka gateway (Cloudflare Container)

Product Posture A: the full Maskirovka gateway (Claude + Codex seats in-process)
runs as a Cloudflare Container behind a Worker/Durable Object. Local development
uses `wrangler dev` for this app — not a separate Node `:4141` process and never
a home-Mac dial-in seat.

Optional single-provider leaf: `apps/maskirovka-seat` (Cloudflare only). That
leaf is not the PRODUCT production path.

## Local path (`wrangler dev`)

```sh
# From the repository root
cp services/inference/.dev.vars.example services/inference/.dev.vars
# Set MASKIROVKA_GATEWAY_KEY, STAVKA_PROVIDER_VAULT_KEY, and DEV_ACCESS_EMAIL.

pnpm --filter @stavka/inference build:dashboard
pnpm --filter @stavka/inference types   # after wrangler.jsonc changes
pnpm --filter @stavka/inference typecheck
pnpm --filter @stavka/inference test
pnpm --filter @stavka/inference dev
```

Package scripts are single-command aliases (no `&&` / `||`). Build the dashboard
before `dev`, `build`, or `deploy` so `/_` dashboard assets exist.

Machine routes (`/healthz`, `/v1/models`, `/v1/responses`, `/v1/messages`) require
`Authorization: Bearer <MASKIROVKA_GATEWAY_KEY>`. Human ops (`/_`, `/admin/*`)
require Cloudflare Access (local mode: `ENVIRONMENT=local` + `DEV_ACCESS_EMAIL`).

## Named provider accounts

Provider credentials never pass through the browser or ordinary Wrangler
environment variables. The `stavka` CLI owns local Codex OAuth, Claude
subscription/API-key input, named Cloudflare Access profiles, and remote
provisioning. Remote credentials are AES-GCM encrypted in Durable Object SQLite;
admin JSON and `/_/` expose metadata only.

```sh
pnpm stavka -- codex login work
claude setup-token | pnpm stavka -- claude login max --token-stdin
pnpm stavka -- cloudflare local dev --url http://127.0.0.1:8787
pnpm stavka -- auth push --account codex/work --cloudflare dev
pnpm stavka -- auth push --account claude/max --cloudflare dev
pnpm stavka -- auth list --cloudflare dev
```

For production, point both profile kinds at `https://stavka.sands.red`: use
`cloudflare login` for interactive Access or `cloudflare service-token` for
read-only automation. The unified app forwards the provider-account API to
this private Worker through `INFERENCE_SERVICE`. Configure the signed-in human's
Access `sub` or email in comma-separated `ACCESS_OWNER_SUBJECTS`; otherwise
admin operations fail closed. The same `/admin/provider-accounts` API supports
list, put, test, activate, and delete.

## Deploy

```sh
pnpm --filter @stavka/inference build:dashboard
pnpm --filter @stavka/inference run deploy
```

After the single `Stavka` Access application protects `stavka.sands.red`:

1. Create a production Access profile and push the named Claude/Codex accounts.
2. `curl -H "Authorization: Bearer $MASKIROVKA_GATEWAY_KEY" …/healthz`
3. `curl -H "Authorization: Bearer $MASKIROVKA_GATEWAY_KEY" …/v1/models`

See [docs/URLS.md](../../docs/URLS.md) for the full origin/path catalog and
[docs/OPERATOR_GUIDE.md](../../docs/OPERATOR_GUIDE.md) for bindings, secrets,
Access steps, and the known workers.dev `1042` account blocker.
