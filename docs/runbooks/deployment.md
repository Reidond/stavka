# Runbook — deploying the unified Stavka platform

Target: one public origin at `https://stavka.sands.red` (unified app), with
Commander and inference reachable only through Cloudflare service bindings.

## Preconditions

- Branch `main` is green on the CI verify workflow (check, lint, tests,
  typecheck, build, replay eval, in-process mock smoke).
- The GitHub `production` environment exists with `CLOUDFLARE_API_TOKEN`
  (Workers Scripts Edit, Containers Edit) and `CLOUDFLARE_ACCOUNT_ID`.
  Because the app declares its custom domain, the deployment credential also
  needs Workers Routes Edit and Zone Read on `sands.red`. An account-only token
  that cannot access zone routes can upload services but fail during route sync.
  Dispatch is an explicit operator action; environment approval rules may add
  a separate approval gate.
- Wrangler 4.x authenticated locally only for explicit operator actions.

## One-time Cloudflare setup

1. **Custom domain**: attach `stavka.sands.red` to the `stavka-poligon` Worker
   (Custom Domains, not routes). No workers.dev or preview URLs are enabled —
   Commander and inference set `workers_dev: false` and `preview_urls: false`.
2. **Cloudflare Access application** for `stavka.sands.red`:
   - One owner/operator policy (email list or IdP group).
   - Worker-side JWT verification is already enforced by
     `@stavka/access-auth`; configure `ACCESS_TEAM_DOMAIN` and `ACCESS_AUD`
     as Worker secrets/vars on `apps/stavka`.
3. **Machine namespace (future game bridge)**: `/machine/v1/*` routes use
   service tokens via `authorizeMachine`, not Access sessions.
4. **Account control plane**: the unified app forwards `/auth/*`,
   `/account/users`, `/admin/provider-accounts*`, `/v1/responses`, and
   `/v1/messages` to the private inference Worker through `INFERENCE_SERVICE`.
   The verified human identity must be the configured owner to create the first
   profile or invoke a provider. Service tokens and machine bearer tokens are
   rejected from every credential-decrypting route.

## Deploy

After CI passes on the exact `main` revision, manually dispatch
`.github/workflows/deploy.yml`. CI never deploys. For an explicitly authorized
local operator deployment, the equivalent command is:

```sh
pnpm run deploy:production
```

Order (handled by the task plan): inference → Commander → unified app. The hosted seat is optional and excluded. The hosted seat, commander, and inference have no public workers.dev or
preview origin.

After deploy, record each service's version ID from the wrangler output in
the change log entry.

## Post-deployment readiness checks

```sh
# Unauthenticated browser request must be intercepted by Access (302 to Access).
curl -sSI https://stavka.sands.red | head -n1

# Health is also Access-protected; anonymous requests must redirect.
curl -sSI https://stavka.sands.red/healthz | head -n1
```

Then sign in through Access, verify `/healthz` and `/system`, and check:

- The first visit shows setup, creates one organization and owner profile, and
  a second Access identity cannot self-register.
- `/settings/providers` shows only the signed-in profile and accounts bound to it.
- `/`, `/simulations` (run a rule-only scenario), `/replays` load.
- `/system` shows Commander + inference health as `live` (or `degraded`
  with the failing alias named).
- A model call works end-to-end through the signed-in owner's `/v1/responses`
  or `/v1/messages` route; inference `/admin/requests` metadata shows the
  resolved model, usage, and costs.
- The same model request with only `MASKIROVKA_GATEWAY_KEY`, or with a service
  token and no human Access assertion, fails with `ACCESS_REQUIRED`.

If readiness fails: `wrangler rollback` per service in reverse dependency
order (app → commander → inference).

## Operator-local Codex provider connection

```sh
pnpm warbench models
pnpm warbench connect
pnpm warbench probe --model <exact-model-id>
```

Warbench credentials never enter Cloudflare Access, a Worker secret, browser
storage, or Durable Object storage. The CLI creates its data directory with
mode `0700`, writes `codex-credentials.json` with mode `0600`, and sends the
credential only to the OpenAI provider endpoints required for authorization,
refresh, and benchmark requests.

Probe outcome interpretation (handoff §12):

| Result                                        | Conclusion                                              |
| --------------------------------------------- | ------------------------------------------------------- |
| Fails everywhere (Worker, Container, outside) | OAuth/entitlement/request construction problem          |
| Works in Container, not Worker                | Move Codex execution to the private inference Container |
| Works only outside Cloudflare                 | Stand up a non-Cloudflare private runner                |
| Works after header/request fix                | Keep worker-direct; add regression tests                |

Never log authorization headers, account ids, tokens, or challenge bodies;
`probe` prints status, content-type, cf-ray, cf-mitigated, x-request-id, and
category only.

## Benchmark studies

Run only from a tagged, CI-green commit with no deployments during the study:

```sh
pnpm warbench calibrate
pnpm warbench create study-v2 --mode full --model <exact-model-id>
pnpm warbench run-rule study-v2
pnpm warbench status study-v2
pnpm warbench run-candidate study-v2
pnpm warbench complete study-v2
pnpm warbench verify-evidence study-v2
pnpm warbench evidence study-v2 \
  --json out/study-v2/evidence.json \
  --pdf out/study-v2/report.pdf \
  --csv out/study-v2/results.csv \
  --markdown docs/results/study-v2.md
```

Arm commands skip already recorded slots and never overwrite them. Provider
failures and invalid decisions are first-attempt evidence; do not selectively
retry or delete them. Do not inspect partial held-out tactical scores, change
the working tree, switch commits, tune the prompt, or deploy after the first
candidate slot is written.
