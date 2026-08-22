# Runbook — deploying the unified Stavka platform

Target: one public origin at `https://stavka.sands.red` (unified app), with
Commander and inference reachable only through Cloudflare service bindings.

## Preconditions

- Branch `main` is green on the CI verify workflow (check, lint, tests,
  typecheck, build, replay eval, offline smoke).
- The GitHub `production` environment exists with `CLOUDFLARE_API_TOKEN`
  (Workers Scripts Edit, Containers Edit) and `CLOUDFLARE_ACCOUNT_ID`, and
  requires manual approval.
- Wrangler 4.x authenticated locally only for explicit operator actions.

## One-time Cloudflare setup

1. **Custom domain**: attach `stavka.sands.red` to the `stavka` Worker
   (Custom Domains, not routes). No workers.dev or preview URLs are enabled —
   Commander and inference set `workers_dev: false` and `preview_urls: false`.
2. **Cloudflare Access application** for `stavka.sands.red`:
   - One owner/operator policy (email list or IdP group).
   - Worker-side JWT verification is already enforced by
     `@stavka/access-auth`; configure `ACCESS_TEAM_DOMAIN` and `ACCESS_AUD`
     as Worker secrets/vars on `apps/stavka`.
3. **Provider credentials key** (fresh — never reuse Warbench-era keys):
   ```sh
   pnpm generate-key            # base64-encoded 32-byte AES-256 key
   wrangler secret put STAVKA_PROVIDER_CREDENTIALS_KEY --config apps/stavka/wrangler.jsonc
   ```
4. **Machine namespace (future game bridge)**: `/machine/v1/*` routes use
   service tokens via `authorizeMachine`, not Access sessions.

## Deploy

Deployment is an explicit operator action:

```sh
pnpm run deploy:production
```

Order (handled by the task plan): inference → commander → unified app.
The hosted Maskirovka seat is not deployed to production.

After deploy, record each service's version ID from the wrangler output in
the change log entry.

## Post-deployment readiness checks

```sh
# Unauthenticated browser request must be intercepted by Access (302 to Access).
curl -sSI https://stavka.sands.red | head -n1

# App health is public and must report ok.
curl -sS https://stavka.sands.red/healthz
```

Then sign in through Access and verify:

- `/overview`, `/simulations` (run a rule-only scenario), `/replays` load.
- `/system` shows Commander + inference health as `live` (or `degraded`
  with the failing alias named).
- A model call works end-to-end: run a simulation with the agent host; check
  inference `/admin/requests` metadata shows resolved model, usage, and costs.

If readiness fails: `wrangler rollback` per service in reverse dependency
order (app → commander → inference).

## Codex provider connection (after every new credential key)

```sh
pnpm warbench connect      # device authorization; stores operator-local file
pnpm warbench probe        # one live request; prints sanitized diagnostics only
```

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
pnpm warbench create study-v1 --mode full
pnpm warbench run-rule study-v1
pnpm warbench run-candidate study-v1     # refuses to start without a live probe
pnpm warbench complete study-v1          # terminal; digest frozen
pnpm warbench evidence study-v1 --json out/study-v1.json --pdf out/study-v1.pdf
```
