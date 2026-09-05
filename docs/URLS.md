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
                         |-- /auth/*, /account/* -> INFERENCE_SERVICE
                         |-- /admin/provider-accounts* -> INFERENCE_SERVICE
                         |-- /v1/responses, /v1/messages -> INFERENCE_SERVICE
                         `-- simulations -> COMMANDER_SERVICE
```

### Unified path map

| Path                                                | Audience          | Notes                                                |
| --------------------------------------------------- | ----------------- | ---------------------------------------------------- |
| `/healthz`                                          | Public liveness   | Unified Worker health                                |
| `/`, application routes                             | Cloudflare Access | Operator UI                                          |
| `/agents/*`                                         | Cloudflare Access | Agents SDK HTTP/WebSocket                            |
| `/auth/session`                                     | Access human      | Signed-in profile or setup-required state            |
| `/auth/signup`                                      | Access owner      | Create the one Stavka organization and owner profile |
| `/account/users`                                    | Active member     | Users in the caller's organization                   |
| `/admin/provider-accounts`                          | Active member     | Caller-owned Codex/Claude account metadata           |
| `/admin/provider-accounts/:provider/:name`          | Active owner      | Provision or delete an encrypted account             |
| `/admin/provider-accounts/:provider/:name/test`     | Active owner      | Validate the caller-owned credential                 |
| `/admin/provider-accounts/:provider/:name/activate` | Active owner      | Activate the caller-owned account                    |
| `/v1/responses`                                     | Active owner      | Codex call using the caller-owned active account     |
| `/v1/messages`                                      | Active owner      | Claude call using the caller-owned active account    |

The account and provider routes are forwarded over `INFERENCE_SERVICE`; they
never require a public inference hostname. User and provider-account data are
scoped from the verified Access assertion. Service tokens cannot enter the
human account control plane.

The inference machine bearer is accepted only for non-decrypting health and
model metadata. Provider execution requires the human Access assertion and an
owner/admin account scope. Commander cannot turn its service binding or machine
key into access to a user's Codex or Claude credential.

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
the human operator policy and a `Stavka Codex automation` service-token policy
for non-human probes. Both the unified Worker and private inference Worker validate the
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
pnpm stavka -- auth list --cloudflare production
```

The first request must be intercepted by Access for an unauthenticated caller.
The second must run with the signed-in human profile and return only that
profile's provider-account metadata.

Operator procedures, secrets, Access setup, and rollback live in
[OPERATOR_GUIDE.md](./OPERATOR_GUIDE.md).
