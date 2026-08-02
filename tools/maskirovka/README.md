# Maskirovka local gateway and contributor seats

The local Node gateway is the complete development posture. Its Effect v4
`HttpApi` surface owns tier routing, fallback, per-seat governors, durable
headroom reservations, record/replay, the request feed, and the Access-protected
operations SPA at `/_/`.

An operator can also contribute an already-authenticated Claude or Codex seat
from a machine behind NAT:

```sh
MASKIROVKA_CLAUDE_MONTHLY_CREDIT_USD=20 \
  pnpm --filter @stavka/maskirovka serve -- \
  --register wss://commander.example/seats \
  --token '<registration-token>' \
  --provider claude \
  --seat-id home-claude
```

The contributor is outbound-only. It sends the registration, heartbeat, and
typed `stavka-decision-v1` job/result frames defined by `@stavka/protocol`. It
uses the same official subscription adapter, fair governor, Effect Schema
validation, and durable reservation/accounting implementation as the local
gateway. In-flight reservations are reconciled with reported usage, including
invalid or failed provider results that report usage, and are refunded on
cancellation.

## Deliberate process boundary

Contributor mode is a leaf execution process, not another HTTP gateway. The
wire carries a tier alias, prompt, response format, deadline, decision, and
usage; it does not carry the original full OpenAI/Anthropic request or the local
gateway's admin and cache protocols. Consequently contributor mode does not
start `/_/`, a local request feed, record/replay storage, tier-remap controls,
or Cloudflare Access. The Commander owns registered-seat aggregation,
cross-seat routing/fallback, and the decision log.

The official subscription SDK/CLI must run in the contributor's process or
container because its authentication and child-process boundary cannot run in
a Worker isolate. The separate `@stavka/maskirovka-seat` app is the hosted
Container posture. Building and testing that app locally proves code and image
shape only; Cloudflare Container deployment, secret injection/rotation,
scale-to-zero recovery, and a real Access policy remain operator-owned external
acceptance steps.

## Deterministic checks

```sh
pnpm --filter @stavka/maskirovka typecheck
pnpm exec vitest run tools/maskirovka/tests
pnpm exec oxlint --deny-warnings tools/maskirovka
pnpm --filter @stavka/maskirovka build
pnpm --filter @stavka/maskirovka smoke
pnpm --filter @stavka/maskirovka eval -- --replay
```

The tests use fake adapters and WebSocket peers. Replay mode fails on a corpus
miss and never invokes a network seat.
