# Stavka service URLs

Stavka has one public production origin and one Cloudflare Access application.
Commander, inference, and the hosted seat are private Workers reached only by
service bindings.

## Production

| Surface        | Worker script            | Origin                     | Exposure                       |
| -------------- | ------------------------ | -------------------------- | ------------------------------ |
| Unified Stavka | `stavka-poligon`         | `https://stavka.sands.red` | Single Access-protected origin |
| Commander      | `stavka-commander`       | none                       | Private service binding        |
| Inference      | `stavka-inference`       | none                       | Private service binding        |
| Hosted seat    | `stavka-maskirovka-seat` | none                       | Private Worker/Container       |

Production request flow:

```text
browser / stavka CLI -> stavka.sands.red (Access: Stavka)
                         |-- /admin/provider-accounts* -> INFERENCE_SERVICE
                         `-- simulations -> COMMANDER_SERVICE -> INFERENCE_SERVICE
```

### Unified path map

| Path                                                | Audience          | Notes                                    |
| --------------------------------------------------- | ----------------- | ---------------------------------------- |
| `/healthz`                                          | Public liveness   | Unified Worker health                    |
| `/`, application routes                             | Cloudflare Access | Operator UI                              |
| `/agents/*`                                         | Cloudflare Access | Agents SDK HTTP/WebSocket                |
| `/admin/provider-accounts`                          | Access read       | Named Codex/Claude account metadata      |
| `/admin/provider-accounts/:provider/:name`          | Access owner      | Provision or delete an encrypted account |
| `/admin/provider-accounts/:provider/:name/test`     | Access owner      | Validate the stored credential           |
| `/admin/provider-accounts/:provider/:name/activate` | Access owner      | Activate the account                     |

The provider-account routes are forwarded over `INFERENCE_SERVICE`; they never
require a public inference hostname. Automation service tokens are read-only.

### Private bindings and storage

| Kind          | Name / binding                                                 |
| ------------- | -------------------------------------------------------------- |
| Service       | Unified app `COMMANDER_SERVICE` -> `stavka-commander`          |
| Service       | Unified app `INFERENCE_SERVICE` -> `stavka-inference`          |
| Service       | Commander `INFERENCE_SERVICE` -> `stavka-inference`            |
| KV            | Commander `TERRAIN_CACHE` (`7b6659541b754b71bf36f7eaf2997065`) |
| R2            | Commander `SESSION_EXPORTS` -> `stavka-session-exports`        |
| R2            | Inference `REPLAY_CACHE` -> `stavka-maskirovka-replay`         |
| Container app | `stavka-inference-maskirovkagateway`                           |
| Container app | `stavka-maskirovka-seat-maskirovkaseat`                        |

## Cloudflare Access

The only Access application is `Stavka`, covering `stavka.sands.red`. It keeps
the human operator policy and a read-only `Stavka Codex automation` service
token policy. Both the unified Worker and private inference Worker validate the
same Access assertion with:

```text
https://<team>.cloudflareaccess.com
```

The unified Worker receives the current application audience as `ACCESS_AUD`.
Inference receives the same audience plus `ACCESS_OWNER_SUBJECTS` so provider
credential mutations fail closed for anyone except an explicitly listed owner.

## Local development

| Surface                        | Default origin              | Start command                                               |
| ------------------------------ | --------------------------- | ----------------------------------------------------------- |
| Unified Stavka                 | Vite-assigned local URL     | `pnpm --filter @stavka/stavka dev`                          |
| Commander                      | `http://127.0.0.1:8787`     | `pnpm --filter @stavka/commander dev`                       |
| Inference gateway              | Wrangler-assigned local URL | build dashboard, then `pnpm --filter @stavka/inference dev` |
| Hosted seat                    | Wrangler-assigned local URL | build dashboard, then seat `dev`                            |
| Local Maskirovka compatibility | `http://127.0.0.1:4141`     | `pnpm ai:up`                                                |

Exact-local Access synthesis requires `ENVIRONMENT=local` and
`DEV_ACCESS_EMAIL`. Production URLs never accept that synthetic identity.

## Repository and CI

| Resource           | Value                               |
| ------------------ | ----------------------------------- |
| GitHub repository  | `https://github.com/Reidond/stavka` |
| Workflow           | `.github/workflows/ci.yml`          |
| GitHub environment | `production`                        |

The `deploy` job runs only after `verify` succeeds on a `main` push or a manual
dispatch whose ref is `main`. Deployment order is inference -> hosted seat ->
Commander -> unified app.

## Quick probes

```bash
curl -sSI https://stavka.sands.red | head -n1
pnpm stavka -- auth list --cloudflare production-automation
```

The first request must be intercepted by Access for an unauthenticated caller.
The second must pass Access through the read-only service token and return only
provider-account metadata.

Operator procedures, secrets, Access setup, and rollback live in
[OPERATOR_GUIDE.md](./OPERATOR_GUIDE.md).
