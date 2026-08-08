# Stavka service URLs

Canonical origins and important paths for local development and the
`andrii-shafar` Cloudflare account. Worker script names match
`wrangler.jsonc` `name` fields. Public `*.workers.dev` on this account is
currently blocked by Cloudflare `error code: 1042` (upload can succeed while
HTTP invocation fails).

## Production (workers.dev)

Account subdomain: `andrii-shafar`  
Account id: `3f5946e8e68fa04a86d36a5f83617f4b`

| Service                | Worker name                   | Origin                                                              |
| ---------------------- | ----------------------------- | ------------------------------------------------------------------- |
| Maskirovka gateway     | `stavka-maskirovka-gateway`   | `https://stavka-maskirovka-gateway.andrii-shafar.workers.dev`       |
| Hosted Maskirovka seat | `stavka-maskirovka-seat`      | `https://stavka-maskirovka-seat.andrii-shafar.workers.dev`          |
| Commander              | `stavka-commander`            | `https://stavka-commander.andrii-shafar.workers.dev`                |
| Poligon                | `stavka-poligon`              | `https://stavka-poligon.andrii-shafar.workers.dev`                  |

Cross-service wiring in production Wrangler vars:

- Commander `STAVKA_AI_BASE_URL` → gateway origin above
- Poligon `COMMANDER_URL` → Commander origin above

### Production path map

Paths are relative to each service origin.

| Service   | Path                         | Audience                         | Notes                                      |
| --------- | ---------------------------- | -------------------------------- | ------------------------------------------ |
| Gateway   | `/healthz`                   | Machine bearer                   | Seat/budget/mode status                    |
| Gateway   | `/v1/models`                 | Machine bearer                   | Tier aliases and resolutions               |
| Gateway   | `/v1/responses`              | Machine bearer                   | OpenAI Responses dialect                   |
| Gateway   | `/v1/messages`               | Machine bearer                   | Anthropic Messages dialect                 |
| Gateway   | `/_/`                        | Cloudflare Access                | Operations SPA + provider token store      |
| Gateway   | `/admin/*`                   | Access or machine (route-gated)  | Status, auth, aliases, kill switch         |
| Seat      | `/healthz`, `/v1/*`          | Machine bearer (`MASKIROVKA_SEAT_KEY`) | Single-provider leaf                   |
| Seat      | `/_/`, `/admin/*`            | Cloudflare Access                | Leaf ops SPA                               |
| Commander | `/healthz`                   | Public liveness                  | Protocol/version/AI alias summary          |
| Commander | `/api/*`                     | Machine bearer (`API_KEY`)       | Game/simulator connect, tick, map, …       |
| Commander | `/admin/*`                   | Cloudflare Access                | Session, logs, seats, exports              |
| Commander | `/agents/*`                  | Cloudflare Access                | Agents SDK HTTP/WebSocket                  |
| Poligon   | `/`                          | Cloudflare Access                | Proving-ground UI                          |
| Poligon   | `/?host=offline`             | Browser-local                    | Zero-network simulation                    |
| Poligon   | `/?mode=versus`              | Cloudflare Access                | Isolated OPFOR/BLUFOR commanders           |
| Poligon   | `/replay`                    | Cloudflare Access                | Local canonical export inspector           |
| Poligon   | `/healthz`                   | Public liveness                  | Worker health                              |

### Cloudflare Access issuer pattern

```
https://<team>.cloudflareaccess.com
```

Use the scheme-qualified team domain as `ACCESS_TEAM_DOMAIN`. Per-app
Application Audience values are `ACCESS_AUD` on each Worker. Wrangler OAuth on
this machine cannot create Access apps; configure them in Zero Trust.

### Related Cloudflare resource names

| Kind          | Name / binding                                              |
| ------------- | ----------------------------------------------------------- |
| KV            | Commander `TERRAIN_CACHE` (`7b6659541b754b71bf36f7eaf2997065`) |
| R2            | Commander `SESSION_EXPORTS` → `stavka-session-exports`      |
| R2            | Gateway `REPLAY_CACHE` → `stavka-maskirovka-replay`         |
| Container app | `stavka-maskirovka-gateway-maskirovkagateway`               |

## Local development

| Surface                         | Default origin                 | How to start                                              |
| ------------------------------- | ------------------------------ | --------------------------------------------------------- |
| Commander (`wrangler dev`)      | `http://127.0.0.1:8787`        | `pnpm --filter @stavka/commander dev`                     |
| Poligon (Vite)                  | `http://127.0.0.1:5173`        | `pnpm --filter @stavka/poligon dev` (prints the URL)      |
| Maskirovka gateway (`wrangler`) | Wrangler-assigned local URL    | `build:dashboard` then `pnpm --filter @stavka/maskirovka-gateway dev` |
| Hosted seat (`wrangler`)        | Wrangler-assigned local URL    | `build:dashboard` then seat `dev` (optional leaf)         |
| Legacy Node Maskirovka          | `http://127.0.0.1:4141`        | `pnpm ai:up` (CI / offline helpers only)                  |

Local Poligon `.dev.vars` should set `COMMANDER_URL=http://127.0.0.1:8787`.
Commander may point `STAVKA_AI_BASE_URL` at the gateway `wrangler dev` origin
or, for legacy offline helpers only, `http://127.0.0.1:4141`.

### Local path map (same pathnames as production)

| Origin                         | Useful paths                                                                 |
| ------------------------------ | ---------------------------------------------------------------------------- |
| `http://127.0.0.1:8787`        | `/healthz`, `/api/*`, `/admin/*`, `/agents/*`                                |
| `http://127.0.0.1:5173`        | `/`, `/?host=offline`, `/?mode=versus`, `/replay`, `/healthz`                |
| Gateway / seat wrangler-dev    | `/healthz`, `/v1/*`, `/_/`, `/admin/*`                                       |
| `http://127.0.0.1:4141`        | `/healthz`, `/v1/models`, `/v1/responses`, `/v1/messages`, `/_/`, `/admin/*` |

Exact-local Access synthesis requires `ENVIRONMENT=local` and
`DEV_ACCESS_EMAIL` on the relevant Worker.

## Repository and CI

| Resource                         | URL                                                      |
| -------------------------------- | -------------------------------------------------------- |
| GitHub repository                | `https://github.com/Reidond/stavka`                      |
| Actions (single workflow)        | `https://github.com/Reidond/stavka/actions`              |
| Workflow file                    | `.github/workflows/ci.yml`                               |
| GitHub Environment               | `production` (holds `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`) |

Automatic production deploy runs only after a successful `verify` job on a
`main` push or a `workflow_dispatch` whose ref is `main`. Deploy order:
gateway → hosted seat → Commander → Poligon.

## Quick probes

After workers.dev serves traffic (not while `1042` persists):

```bash
GW=https://stavka-maskirovka-gateway.andrii-shafar.workers.dev
CMD=https://stavka-commander.andrii-shafar.workers.dev
SEAT=https://stavka-maskirovka-seat.andrii-shafar.workers.dev
POL=https://stavka-poligon.andrii-shafar.workers.dev

curl --fail -H "Authorization: Bearer $MASKIROVKA_GATEWAY_KEY" "$GW/healthz"
curl --fail -H "Authorization: Bearer $MASKIROVKA_GATEWAY_KEY" "$GW/v1/models"
curl --fail "$CMD/healthz"
curl --fail "$POL/healthz"
# Optional leaf:
curl --fail -H "Authorization: Bearer $MASKIROVKA_SEAT_KEY" "$SEAT/healthz"
```

Local Commander/Poligon:

```bash
curl --fail http://127.0.0.1:8787/healthz
curl --fail http://127.0.0.1:5173/healthz
```

Legacy offline gateway:

```bash
curl --fail http://127.0.0.1:4141/healthz
curl --fail http://127.0.0.1:4141/v1/models
```

Operator procedures, secrets, Access setup, and rollback live in
[OPERATOR_GUIDE.md](./OPERATOR_GUIDE.md).
