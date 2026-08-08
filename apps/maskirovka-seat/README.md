# Maskirovka hosted seat (optional Cloudflare leaf)

One deployment represents one operator-owned **Cloudflare Container**
subscription seat. This is an optional single-provider experiment — not the
PRODUCT production gateway (`apps/maskirovka-gateway`) and **never** a
home-Mac / Posture B dial-in path.

An Effect v4 `HttpApi` Worker authenticates the machine wire, resolves Stavka
tier aliases, and forwards the latest OpenAI Responses or Anthropic Messages
dialect to a singleton Cloudflare Container. The Container exposes the same
contract-first Effect HTTP surface on Node and runs the official Codex or
Claude Agent SDK; it does not contain a metered API fallback.

The Container-backed Durable Object persists an opaque credential checkpoint in
its own SQLite storage only when the runtime credential changes. Checkpoints are
bound to the SHA-256 fingerprint of the injected revision so stale concurrent
responses cannot overwrite newer auth, and unchanged bootstrap credentials do
not churn revisions. On a cold start or crash reconnect the DO injects the last
checkpoint before opening the container port. A changed Worker secret
supersedes the old checkpoint, so operator token rotation is recoverable without
deleting Durable Object state. `sleepAfter` stops the container between play
sessions; health and model discovery do not wake it.

The official SDKs currently expose no callback for credential changes made by
their child CLI processes, and a child cannot mutate this Node process's
environment. The guarded checkpoint path therefore captures a token change only
when the hosting runtime makes it visible; ordinary operator rotation remains a
Worker-secret update. Stavka does not scrape provider-private credential files.

## Secrets

Set these interactively, never in `wrangler.jsonc`:

```sh
pnpm --filter @stavka/maskirovka-seat exec wrangler secret put MASKIROVKA_SEAT_KEY
pnpm --filter @stavka/maskirovka-seat exec wrangler secret put CODEX_ACCESS_TOKEN
```

For a Claude deployment, set `SEAT_PROVIDER=claude`, configure its aliases, and
use `CLAUDE_CODE_OAUTH_TOKEN` instead. Do not set `OPENAI_API_KEY`,
`CODEX_API_KEY`, or `ANTHROPIC_API_KEY`; the container removes those variables
before it starts either SDK to prevent silent metered billing.

Machine routes (`/healthz`, `/v1/models`, `/v1/responses`, and `/v1/messages`)
require `Authorization: Bearer <MASKIROVKA_SEAT_KEY>`. Access identity never
substitutes for that seat key. `/v1/chat/completions` remains deliberately
rejected. Anthropic `output_config.format` JSON Schemas are passed to the
official Agent SDK and returned as native structured JSON text content.

The static TanStack Router + Query dashboard is available at `/_/`. The Worker
verifies Cloudflare Access before every dashboard HTML, JavaScript, and CSS
asset fetch and before these human operations endpoints:

- `GET /admin/status`
- `GET /admin/requests?limit=100`
- `PUT /admin/aliases/:alias` with `{ "model": "..." }`
- `POST /admin/kill-switch` with `{ "enabled": true }`

Exact local mode uses `ENVIRONMENT=local` plus `DEV_ACCESS_EMAIL`; preview and
production fail closed unless `ACCESS_TEAM_DOMAIN`, `ACCESS_AUD`, and a valid
Access assertion are present. Service-token identities are read-only. Model
remaps and the kill switch persist in the seat Durable Object. Request history
is capped at 200 metadata-only rows (generated request ID, time, dialect, alias,
resolved model, status, latency, and queue depth); prompts, bodies, credentials,
and error text are never stored.

This deployment is one hosted Cloudflare leaf, not the orchestration gateway.
For Claude + Codex together with dashboard credential store, deploy
`apps/maskirovka-gateway` instead. Seat registration, cross-seat
fallback/routing, and budget policy are intentionally not exposed on the leaf.

The Durable Object also enforces leaf-level subscription-seat backpressure:
one provider invocation runs at a time, up to eight requests wait in FIFO
order, and excess requests receive `503 SEAT_QUEUE_FULL` with `Retry-After: 1`.
An aborted incoming request is removed from the queue immediately.

## Local verification

```sh
pnpm install
pnpm --filter @stavka/maskirovka-seat typecheck
pnpm --filter @stavka/maskirovka-seat test
pnpm --filter @stavka/maskirovka-seat build
```

The test suite injects fake seat runners and never invokes a provider. Building
the dashboard and dry-run Worker also builds the local container image and
installs the official SDK-packaged Linux CLIs, but does not make a provider
request or deploy anything.
