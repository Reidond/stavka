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

Machine authentication is limited to non-decrypting metadata routes (`/healthz`
and `/v1/models`). Model execution (`/v1/responses` and `/v1/messages`) requires
a verified human Cloudflare Access identity, an active Stavka profile, and owner
or admin membership. The gateway resolves and decrypts provider accounts only
inside that user's organization/user scope. A machine bearer or service token
alone cannot invoke Codex or Claude. Human ops (`/_`, `/admin/*`) also require
Cloudflare Access (local mode: `ENVIRONMENT=local` + `DEV_ACCESS_EMAIL`).

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
read-only automation. The unified app forwards the provider-account API and
both `/v1/*` model APIs to this private Worker through `INFERENCE_SERVICE`.
Configure the signed-in human's Access `sub` or email in comma-separated
`ACCESS_OWNER_SUBJECTS`; otherwise credential mutation and model execution fail
closed. The same `/admin/provider-accounts` API supports list, put, test,
activate, and delete. Commander does not receive provider credentials and its
machine service binding cannot invoke a provider without a future, explicitly
propagated human grant.

## Deploy

```sh
pnpm --filter @stavka/inference build:dashboard
pnpm --filter @stavka/inference run deploy
```

After the single `Stavka` Access application protects `stavka.sands.red`:

1. Create a production Access profile and push the named Claude/Codex accounts.
2. `curl -H "Authorization: Bearer $MASKIROVKA_GATEWAY_KEY" …/healthz`
3. `curl -H "Authorization: Bearer $MASKIROVKA_GATEWAY_KEY" …/v1/models`
4. Call `https://stavka.sands.red/v1/responses` from the signed-in owner profile;
   confirm a machine bearer without Access receives `ACCESS_REQUIRED`.

See [docs/URLS.md](../../docs/URLS.md) for the full origin/path catalog and
[docs/OPERATOR_GUIDE.md](../../docs/OPERATOR_GUIDE.md) for bindings, secrets,
Access steps, and the known workers.dev `1042` account blocker.
