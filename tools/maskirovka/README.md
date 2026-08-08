# Maskirovka (shared gateway library + legacy Node CLI)

Shared Maskirovka Effect gateway code lives here. The **operator primary path**
is the Cloudflare Container app at `apps/maskirovka-gateway` (`wrangler dev` /
deploy). This package’s Node CLI on `127.0.0.1:4141` (`pnpm ai:up`) remains for
offline CI, doctor, smoke, and replay corpus work.

**Hosted leaf (optional):** `apps/maskirovka-seat` — single-provider Cloudflare
Container only. Never a home-Mac dial-in.

**Posture B unsupported:** outbound contributor registration from a personal
machine (`serve --register`) is not an approved Stavka hosted posture. Prefer
the gateway Container with browser credential store at `/_/`.

## Legacy Node gateway

```sh
pnpm --filter @stavka/maskirovka doctor
pnpm --filter @stavka/maskirovka smoke
pnpm --filter @stavka/maskirovka eval -- --replay
```

The Effect v4 `HttpApi` surface owns tier routing, fallback, governors, durable
headroom, record/replay, and (in Node mode) the Access-protected SPA at `/_/`.
On Cloudflare, the Worker serves dashboard assets and the Container runs this
same gateway entry (`src/container/main.ts`).

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
