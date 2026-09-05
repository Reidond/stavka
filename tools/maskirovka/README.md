# Maskirovka shared Cloudflare gateway

This package contains the Effect gateway runtime used by the private Cloudflare inference service in `services/inference`. The Container entrypoint is `src/container/main.ts`; its Node HTTP server is the Container's internal listener. App and live provider testing use [stavka.sands.red](https://stavka.sands.red).

The standalone local gateway, doctor, development-variable writer, and personal-machine contributor client have been removed. The CLI supports only deterministic CI commands:

```sh
pnpm --filter @stavka/maskirovka smoke
pnpm --filter @stavka/maskirovka eval -- --replay
```

Smoke uses in-process HTTP handlers and a mock seat. Replay reads the tracked corpus and fails on a miss without invoking a provider. Neither command starts a server, reads provider credentials, or writes development environment files. Unit tests cover gateway routing, governors, caching, and accounting with fake adapters.

The optional `apps/maskirovka-seat` is also Cloudflare-hosted and is excluded from the three-service production deployment. See [the agent workflow](../../docs/AGENT_WORKFLOW.md) and [deployment runbook](../../docs/runbooks/deployment.md).
