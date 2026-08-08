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
cp apps/maskirovka-gateway/.dev.vars.example apps/maskirovka-gateway/.dev.vars
# Edit .dev.vars: set MASKIROVKA_GATEWAY_KEY and DEV_ACCESS_EMAIL for local Access.

pnpm --filter @stavka/maskirovka-gateway build:dashboard
pnpm --filter @stavka/maskirovka-gateway types   # after wrangler.jsonc changes
pnpm --filter @stavka/maskirovka-gateway typecheck
pnpm --filter @stavka/maskirovka-gateway test
pnpm --filter @stavka/maskirovka-gateway dev
```

Package scripts are single-command aliases (no `&&` / `||`). Build the dashboard
before `dev`, `build`, or `deploy` so `/_` dashboard assets exist.

Machine routes (`/healthz`, `/v1/models`, `/v1/responses`, `/v1/messages`) require
`Authorization: Bearer <MASKIROVKA_GATEWAY_KEY>`. Human ops (`/_`, `/admin/*`)
require Cloudflare Access (local mode: `ENVIRONMENT=local` + `DEV_ACCESS_EMAIL`).

## Browser credential store

Access admins paste Claude / Codex subscription tokens at `/_/` (Provider auth
panel) or via `PUT /admin/auth/:provider` with `{ "token": "..." }`. Tokens are
stored in Durable Object SQLite, injected into the Container as
`MASKIROVKA_AUTH_STATE_B64`, and never echoed in admin JSON or the dashboard.
`DELETE /admin/auth/:provider` clears a provider. Optional Wrangler secrets
(`CLAUDE_CODE_OAUTH_TOKEN`, `CODEX_ACCESS_TOKEN`) remain a recovery bootstrap.

## Deploy

```sh
pnpm --filter @stavka/maskirovka-gateway build:dashboard
pnpm --filter @stavka/maskirovka-gateway run deploy
```

Expected workers.dev origin (this account):

`https://stavka-maskirovka-gateway.andrii-shafar.workers.dev`

After Access is configured and public workers.dev routing works:

1. Open `/_/` and store Claude + Codex subscription tokens.
2. `curl -H "Authorization: Bearer $MASKIROVKA_GATEWAY_KEY" …/healthz`
3. `curl -H "Authorization: Bearer $MASKIROVKA_GATEWAY_KEY" …/v1/models`

See [docs/URLS.md](../../docs/URLS.md) for the full origin/path catalog and
[docs/OPERATOR_GUIDE.md](../../docs/OPERATOR_GUIDE.md) for bindings, secrets,
Access steps, and the known workers.dev `1042` account blocker.
