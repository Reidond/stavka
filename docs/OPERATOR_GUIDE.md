# Stavka operator guide

Run the app, live models, and all visual/integration acceptance on Cloudflare at [stavka.sands.red](https://stavka.sands.red). Local app servers, local provider profiles, the standalone gateway, and standalone local acceptance/performance harnesses have been removed. CI retains deterministic source checks and tests.

## Deployed services

| Service                                | Workspace           | Production order |
| -------------------------------------- | ------------------- | ---------------- |
| Private inference Worker and Container | `@stavka/inference` | 1                |
| Private Commander Worker               | `@stavka/commander` | 2                |
| Unified Stavka application             | `@stavka/stavka`    | 3                |

The optional `apps/maskirovka-seat` Cloudflare leaf is excluded from production deployment. Personal-machine contributor seats are unsupported and their client has been removed.

The unified app is the only public origin. Commander and inference keep workers.dev and preview URLs disabled and are reached through private bindings. See [URLS.md](URLS.md) for routes and bindings.

## Accounts and provider credentials

Sign in to the deployed app through Cloudflare Access. The configured owner creates the organization/profile. Provider accounts are private to that user's organization and user scope. The browser shows metadata; credentials are encrypted in the Cloudflare vault and provisioned through the operator CLI:

```bash
pnpm stavka -- codex login work
claude setup-token | pnpm stavka -- claude login max --token-stdin
pnpm stavka -- cloudflare login production --url https://stavka.sands.red
pnpm stavka -- auth push --account codex/work --cloudflare production
pnpm stavka -- auth push --account claude/max --cloudflare production
pnpm stavka -- auth list --cloudflare production
```

Use the names shown by `pnpm stavka accounts`. Previously stored local profiles remain readable so they do not corrupt the account store, but cannot make requests. Select or sign in to a Cloudflare Access profile instead. Local sign-in/provisioning CLI tools are not local model servers.

Machine bearers and service tokens cannot authorize a user's subscription. Model execution requires a verified human Access assertion and owner/admin membership. Commander still needs the account-scoped execution integration tracked in [REMAINING_WORK.md](REMAINING_WORK.md); never bypass that boundary to make an acceptance check pass.

## CI and release workflow

Use Node 22 and pnpm 11.18.0:

```bash
pnpm install --frozen-lockfile
pnpm verify
```

Verification runs formatting/lint, Tailwind, deterministic unit tests, fresh typechecks/builds, corpus replay, and an in-process mock gateway smoke. It does not launch a local app/browser stack, read provider credentials, invoke live models, or deploy. Container image builds validate the runtime with a network-disabled smoke step.

`.github/workflows/ci.yml` is verification-only. After CI passes on the intended revision and deployment is authorized, manually dispatch `.github/workflows/deploy.yml` on `main`, or use the documented operator command `pnpm run deploy:production`. It deploys the three services above in order. Worker secrets and provider credentials remain out of band. The deployment token needs the account and custom-domain permissions in [the deployment runbook](runbooks/deployment.md).

Record the commit and Worker versions. Upload success alone is not post-deploy health. Roll back in reverse order: unified app, Commander, inference. See the runbook for the complete procedure.

## Cloudflare acceptance

Use the deployed app to check navigation, responsive layout, Sessions, Providers, Access, and private service health. Anonymous HTTP and WebSocket upgrade requests must be intercepted by Access. Use the signed-in profile for protected checks.

When live model calls are in scope, Models → Test sends a short request through the owner's selected provider account. Record the resolved model, usage, and whether the response was cached. This is distinct from proving that a simulation received, validated, and applied a tactical command.

Run persistence, exported-session/R2, provider refresh, streaming, and Container start/restart/sleep checks against Cloudflare. Identify the deployed version for every result. The browser-only simulation mode and export-file reader are application features available in the deployed UI; they do not require a local server and do not prove Commander integration.

## Simulation and session behavior

Poligon validates its search state with Effect Schema:

| Query        | Values                                          | Effect                                                  |
| ------------ | ----------------------------------------------- | ------------------------------------------------------- |
| `scenario`   | `movement`, `engagement`, `mechanized`          | Deterministic world fixture                             |
| `seed`       | integer; the UI limits entry to 1–2,147,483,647 | Simulation randomness                                   |
| `time_scale` | `1`, `10`, `100`                                | Hosted/offline cadence and Agent identity               |
| `camera`     | `ortho`, `perspective`                          | Viewer only; does not change Agent identity             |
| `doctrine`   | `balanced`, `aggressive`, `defensive`           | Commander prompt/rule doctrine                          |
| `mode`       | `single`, `versus`                              | One Commander or isolated OPFOR and BLUFOR Commanders   |
| `host`       | `agent`, `offline`                              | Durable Agent/Commander loop or browser-only simulation |

Every simulation-affecting selector is part of the Agent identity. Commander
Durable Objects and terrain session indexes key by the tuple
`(session_id, mission_epoch, faction)` (JSON-serialized). Map upload before
connect returns `409 MAP_SESSION_NOT_CONNECTED`; mission/map identity mismatch
against the active connection returns `409 MAP_SESSION_MISMATCH`. In
`mode=versus`, confirm both factions connect on independent indexes, receive
only faction-relative information, and cannot mutate the other faction's groups.

Offline `Step` advances one resume quantum (`10 × time_scale` fixed 100 ms
steps) cooperatively so `×100` stays responsive.

### Zero-network browser host

Open Poligon with `?host=offline` to run `sim-core` directly in the browser. It
uses the same fixed 100 ms world and deterministic seed/restore behavior but
creates no Agent or Commander state and must not fetch or open a WebSocket.
Offline mode is for simulation/UI work, not Commander acceptance.

### Replay and cost views

Agent-hosted sessions show current Commander usage grouped by faction, agent
tier, and model. The table reports calls, input/output tokens, and USD cost from
the canonical Commander status; a mock/rule run truthfully reports no model
usage.

Open Sessions → From export file and choose a JSON `SessionExport`. The browser rejects
oversized, invalid JSON, excess-property, and schema-invalid files before
rendering. Nothing is uploaded and remote URLs are not accepted. The view joins
archived results into a cause → decision → commands → outcomes timeline and
shows the export's grouped costs.

## Commander surface and behavior

Commander uses Effect v4 `HttpApi` for its typed contracts and Effect
`HttpRouter` for Agent/seat upgrades and fallbacks. `/openapi.json` is generated
from the same contract. There is no Hono or manual pathname dispatcher.

| Route                         | Auth                     | Purpose                                                   |
| ----------------------------- | ------------------------ | --------------------------------------------------------- |
| `GET /healthz`                | none                     | Liveness, protocol version, configured AI aliases         |
| `GET /openapi.json`           | none                     | Contract-generated OpenAPI document                       |
| `POST /api/connect`           | game/simulator bearer    | Start or reconnect a session and request full state       |
| `POST /api/tick`              | game/simulator bearer    | Apply a strict full/delta tick and return commands/status |
| `POST /api/disconnect`        | game/simulator bearer    | Mark the session disconnected                             |
| `POST /api/map`               | game/simulator bearer    | Validate/cache/apply a terrain briefing                   |
| `GET /admin/session`          | Access read              | Inspect one session/faction/epoch                         |
| `GET /admin/logs`             | Access read              | Read bounded recent decision logs                         |
| `GET /admin/seats`            | Access read              | List registered seat metadata and health                  |
| `POST /admin/seats`           | Access admin             | Register a seat                                           |
| `DELETE /admin/seats/:seatId` | Access admin             | Remove a seat                                             |
| `GET /admin/export`           | Access admin             | Download a canonical bounded inline `SessionExport`       |
| `POST /admin/exports`         | Access admin             | Page the complete session archive into R2                 |
| `GET /admin/exports`          | Access read              | List matching R2 export metadata                          |
| `GET /admin/exports/object`   | Access read              | Read and verify one canonical R2 export by object key     |
| `/agents/*`                   | Access read              | Agents SDK HTTP/WebSocket routing                         |
| `GET /seats`                  | seat registration bearer | Contributor WebSocket registration/job channel            |

Admin session/log/export routes take `session_id`, `faction`, and optional
`epoch` query parameters. `POST /admin/exports` also accepts an optional
`export_id`; the list accepts `limit`; object reads take the opaque `key`
returned by persistence/listing. Service-token permissions default to read; an
operator may explicitly add `operate` or `admin` through
`ACCESS_AUTOMATION_PERMISSIONS`. Keep service tokens least-privileged.

Provider calls are never awaited by `/api/tick`. A tick schedules/coalesces
durable strategic work, queues bounded per-report Sergeant assessments, and
incorporates completed/acknowledged results on later ticks. Accepted commands
remain pending until one terminal result, so resource/cost reconciliation is
idempotent. Contributor jobs, reservations, connection fencing, and results are
durable and deterministic across reconnect handling.

The inline export intentionally stays bounded for an interactive response.
`POST /admin/exports` instead counts and pages all Commander SQLite log/archive
rows, writes content-addressed page objects, and publishes a digest-checked root
manifest only after every page succeeds. List/read operations reconstruct the
canonical `SessionExport` behind the repository boundary. The binding is
`SESSION_EXPORTS` (`stavka-session-exports`); configured source is not proof
that the target-account bucket, retention/garbage collection, or deployed
read/write behavior is correct.

## Inference routing and accounting

The private inference Worker authorizes the owner and delegates execution to the shared gateway runtime in its Cloudflare Container. `src/container/main.ts` is the gateway entrypoint; the Node listener is internal to that Container. No laptop gateway participates in the live path.

### Modes, routing, and accounting

- `live` bypasses cache.
- `record` writes canonical content-addressed responses.
- `replay` fails on a corpus miss and never invokes a seat. CI/eval uses this
  posture; the tracked corpus covers Responses and Messages.
- Candidate seats must be checked and healthy. Retryable failures advance
  through a bounded priority sequence; invalid semantic output does not get
  retried as if it were transport failure.
- Fair per-seat governors bound active/queued work.
- Repository-backed headroom atomically reserves, reconciles, or refunds
  estimated in-flight usage. Reported usage on failed/invalid results is still
  counted. Plan credit, metered cash, API-list equivalent, and estimated savings
  remain separate.

Do not infer entitlement, model availability, quota, or billing from a mock or replay pass.

## Operator tools

- `pnpm stavka` manages named provider accounts and Cloudflare profiles.
- `pnpm warbench` remains the independent immutable-study CLI described in [the Warbench runbook](runbooks/warbench-study.md). Do not delete or rewrite study data when changing the app development workflow.
- `pnpm eval -- --replay` and `pnpm ai:smoke` are deterministic CI checks.
- `pnpm --filter @stavka/maskirovka-seat build` builds the optional Cloudflare leaf; it does not deploy or prove provider behavior.

Never place real credentials in source, fixtures, replay corpora, command arguments, screenshots, or chat. Existing ignored credential/state files are not needed by CI; provider sign-in and Cloudflare secrets remain explicit operator actions.

## Arma and dedicated-server handoff — excluded by scope

`mods/StavkaTest` preserves historical Workbench experiments. It is not the
production shared/Commander addon described by `PRODUCT.md`, and its legacy
round-trip harness is not protocol-v1 product evidence.

When Windows, Arma Reforger Tools, and a target server are available, a separate
implementation/acceptance effort must build and compile the production addon,
exercise protocol-v1 connect/full/delta/config/results/disconnect/resync,
extract server-authoritative state/events with fog boundaries, execute native
orders, keep keys server-only, validate Conflict/multiplayer/JIP/BattlEye, and
profile 30/40/50 groups. Packaging, Workshop dependencies, upgrade, and rollback
belong to that later server runbook.

Until then, both production mod and dedicated-server status remain excluded by
scope and unvalidated.
