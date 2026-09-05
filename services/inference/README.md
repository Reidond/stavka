# Private Cloudflare inference gateway

The full Maskirovka gateway runs in a Cloudflare Container behind a private Worker/Durable Object. Use [stavka.sands.red](https://stavka.sands.red) for app, live model, and integration testing. The unified app forwards account and provider APIs through `INFERENCE_SERVICE`; no public inference hostname or local gateway is required.

## Provider accounts

Model execution requires verified human Cloudflare Access, an active Stavka profile, and owner/admin membership. Credentials are selected within that user's organization and account scope and encrypted in Durable Object SQLite. Service tokens and machine bearers cannot authorize provider execution. Browser pages expose metadata only.

Connect named accounts through the operator CLI:

```sh
pnpm stavka -- codex login work
claude setup-token | pnpm stavka -- claude login max --token-stdin
pnpm stavka -- cloudflare login production --url https://stavka.sands.red
pnpm stavka -- auth push --account codex/work --cloudflare production
pnpm stavka -- auth push --account claude/max --cloudflare production
pnpm stavka -- auth list --cloudflare production
```

Configure the permitted human Access subject/email in `ACCESS_OWNER_SUBJECTS`. Worker secrets and provider credentials stay out of source and CI. Legacy local Cloudflare profiles cannot be used for requests.

## CI and deployment

`pnpm verify` runs source checks, builds, deterministic tests, replay, and in-process mock smoke. The Container build also validates the bundled runtime without network access. These checks do not run a local application or invoke live providers.

After CI passes and deployment is authorized, use the separate production workflow or `pnpm run deploy:production`. It deploys inference, Commander, and the unified app in order. Verify Access, private bindings, and provider behavior on Cloudflare as described in [the deployment runbook](../../docs/runbooks/deployment.md).

The Commander-to-provider owner grant remains a separate integration gate; a successful direct model test does not prove tactical command application. See [remaining work](../../docs/REMAINING_WORK.md).
