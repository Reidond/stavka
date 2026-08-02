# Implementation and acceptance status

This document reconciles the design in [`PRODUCT.md`](../PRODUCT.md) with the
current workspace. It distinguishes repository implementation from external
acceptance: deterministic code and tests cannot prove a Cloudflare account, a
live model entitlement, or an Arma dedicated server.

## Status vocabulary

| Status                       | Meaning                                                                                                                                       |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| **Implemented**              | The repository contains the intended feasible-now behavior and deterministic coverage. The aggregate final-run result is recorded separately. |
| **External pending**         | Acceptance needs infrastructure, credentials, provider behavior, Windows Workbench, or a dedicated server not available in this pass.         |
| **Not implemented by scope** | Deliberately excluded production Arma mod/server work. A research harness does not count as the product layer.                                |

## Acceptance statement

The non-Arma product surface is implemented in the repository:

- Effect v4 protocol, application, orchestration, configuration, persistence,
  provider, and HTTP layers;
- strict protocol-v1 full/delta, typed config, terrain, contributor, decision,
  and replay contracts, including an exact Test-12 round trip;
- durable Commander/Sergeant scheduling, seat routing, budget accounting,
  decision/archive persistence, cost totals, and canonical exports;
- deterministic simulation/link fidelity, fog-of-war projection, terrain
  classification, adaptive reports, and restore/replay behavior;
- Poligon Agent, offline, single/versus, local replay, and cost surfaces;
- local Maskirovka gateway/contributor modes and the hosted single-seat
  Worker/Container/dashboard code;
- shared Tailwind frontend primitives, modern variants, lint/editor parity,
  CI, and replay-only evaluation.

The product is **not accepted for Arma Reforger or production operation**. The
production addon and dedicated-server layer are outside this implementation
scope. Real Cloudflare resources/Access/Container lifecycle and live provider
accounts remain operator-owned external gates and were not exercised here.

## Enforced architecture

| Contract                  | Repository evidence                                                                                                                                                                                            | Status      |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------- |
| Effect-first TypeScript   | First-party Effect packages are pinned together at `4.0.0-beta.102`; services, Layers, Schema, typed errors, queues, semaphores, scopes, and repositories own effects                                          | Implemented |
| Contract-first HTTP       | Commander, local Maskirovka, and hosted Maskirovka define `HttpApi` contracts, `HttpApiBuilder` handlers, and Effect routers with Node/web adapters                                                            | Implemented |
| No pathname dispatch/Hono | Architecture tests reject Hono, `effect-http`, and manual URL-path switching in first-party HTTP code                                                                                                          | Implemented |
| Repository-only SQL       | Raw SQL and persistence schema text are restricted to `*-repository.ts`; domain/use-case/agent/handler code calls Effect repository operations                                                                 | Implemented |
| Boundary validation       | Effect Schema decodes HTTP, protocol, URL, configuration, persisted state, replay files, and provider frames                                                                                                   | Implemented |
| Frontend variants         | `@stavka/ui` owns `tailwind-variants@3.3.0` `tv` variants and Tailwind-aware `cn` composition                                                                                                                  | Implemented |
| Cursor/CI Tailwind parity | Four per-entrypoint `better-tailwindcss`/Oxc invocations use the real CSS sources with warnings denied; direct/`cn`/`tv` probes, Cursor mappings, CI/deploy gates, and Poligon built-CSS assertion are tracked | Implemented |
| Reusable Effect guidance  | The tracked `.agents/skills/effect-v4` skill and `docs/EFFECT_V4.md` capture pinned-v4 conventions and checks                                                                                                  | Implemented |

## Capability inventory

| Layer                          | Implemented now                                                                                                                                                                                                                                                                               | External acceptance                                                                          |
| ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| Protocol                       | Version 1; strict identifiers/ranges; full and delta ticks; mission/objective removals; typed config updates; commands/results; doctrines; LLM contributor frames; decision summaries/cost aggregates; canonical replay export                                                                | Production Enforce encode/decode parity                                                      |
| Test-12                        | The golden request and response decode and re-encode exactly; sim-link reproduces the full canonical request, decodes the response, and executes the returned order                                                                                                                           | Same fixture through the production addon                                                    |
| Map contract                   | Rectangular dimensions, finite resolution/elevation/slope, sentinel rejection, terrain/cover/features, unique in-bounds cells/features, source/classifier/hash provenance, strict excess-property decoding                                                                                    | Real Arma extraction and comparison                                                          |
| Access/auth                    | Constant-time machine bearer checks; cached Access JWKS verification; role/permission model; exact-local synthetic identity; HTTP and WebSocket guards                                                                                                                                        | Real Access apps, policies, service tokens, audience/domain, and key rotation                |
| Commander API                  | Effect `HttpApi` connect/tick/disconnect/map/admin contracts, generated OpenAPI, body limits, typed errors, Effect router integration with Agents SDK and seat WebSocket routing                                                                                                              | Worker/DO/KV/R2 deployment and public-origin abuse/load checks                               |
| Commander state/link semantics | Full/delta merge, stale-delta resync, periodic full snapshot, typed link config, cumulative XZ movement threshold, tick idempotency, reconnect checkpoint, pending commands until terminal result, resource reservation/refund, doctrine and mission isolation                                | Real game/link behavior                                                                      |
| Strategic decisions            | Tick never waits on a provider; versioned/coalesced durable decision requests run out of band and return through later ticks; bounded rule fallback remains deterministic                                                                                                                     | Live model quality/latency/quota behavior                                                    |
| Sergeants                      | Per-group bounded durable assessment queues, deterministic/LLM paths, completion retention until parent acknowledgement, idempotent later-tick incorporation, fog-filtered reports                                                                                                            | Live seat behavior and real game events                                                      |
| Seat registry/contributors     | Global priority registry, per-seat credentials, heartbeat TTL/recovery, connection fencing, durable deterministic jobs/results/reservations, retryable failover, semantic-failure stop, contributor reconnect/cancellation                                                                    | Real remote contributors and eviction/redeploy proof                                         |
| Budget/cost                    | Atomic UTC-window reserve/reconcile/refund, in-flight headroom, failed reported usage, plan credit vs metered cash, fallback/stretch policy, per-tier/model call/token/USD aggregates                                                                                                         | Live provider invoice/quota reconciliation                                                   |
| Logs/replay export             | Repository-isolated decision and paged archive data, canonical bounded inline export, full paginated R2 persistence, chunked/digest-checked/manifest-last storage, backward decoding of legacy snapshot rows, Access read/list endpoints, and configured `SESSION_EXPORTS` binding            | Target-account bucket, retention/GC policy, deployed long-session read/write proof           |
| `sim-core`                     | Seeded 100 ms world; byte-stable replay/restore; movement quirks, spawn/wipe, combat, board/drive/dismount stalls, slope/traversability cost, objectives, patrol/sweep, formation dispersion, and deterministic 50-group profile                                                              | Calibration against production captures                                                      |
| `sim-link`                     | Effect-first transport, REST lifecycle, exact Test-12, faction projection, fog/contact ageing, urgent/notable batching, sitreps, full/delta/config handling, command execution/results, checkpoint restore, adaptive cadence                                                                  | Byte/behavior parity with future Enforce link                                                |
| Poligon                        | TanStack Start/Router/Query, THREE view, Schema URL state, Agent host, truly zero-network browser host, single/versus isolation, spectator/operator RPC permissions, durable link checkpoints, decision feed, live cost table, and bounded local `/replay` import/timeline/cost table         | Deployed Access/WS behavior and visual acceptance on target browsers                         |
| Local Maskirovka               | Effect `HttpApi` Node server; Responses/Messages only; mock/Claude/Codex/API adapters; live/record/replay content-addressed cache; deterministic corpus; priority/retry routing; governors; durable reservations/accounting; doctor/smoke; Access operations SPA; outbound contributor client | Real logins, entitlement, model fidelity, quota, and metered cost                            |
| Hosted Maskirovka              | Single-seat Effect `HttpApi` Worker and Node Container; machine-only model routes; bounded FIFO; auth checkpoint/rotation logic; scale-to-zero configuration; Access-protected TanStack dashboard; persistent leaf alias overrides, kill switch, and metadata-only request feed               | Real Worker/Container deploy, secrets, Access policy, sleep/restart, and credential rotation |
| Shared UI                      | Shared tokens, `tv` variants, primitives, forms, tables, virtual feeds, seat/status/time/map components; apps consume the shared layer                                                                                                                                                        | Deployed cross-browser/assistive-technology review                                           |
| Production Arma mod            | Only `mods/StavkaTest` research assets are preserved                                                                                                                                                                                                                                          | Not implemented by scope                                                                     |
| Dedicated server               | No product addon/server integration was attempted in this pass                                                                                                                                                                                                                                | Not implemented by scope                                                                     |

## Product phase matrix

The original checkboxes in `PRODUCT.md` record the plan when it was written.
This matrix records the current feasible-now implementation without rewriting
that design history.

| Product phase                  | Feasible-now implementation                                                                                                                                                                                     | Remaining external proof                                                                     |
| ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| **1 — Foundation**             | Workspace/tooling, strict protocol, Effect Commander API, auth, durable per-faction state, rule Commander, repositories, sim-core/link, Poligon, shared UI, exact Test-12, local Maskirovka                     | Deployed Cloudflare resources and production Enforce bridge                                  |
| **2 — LLM integration**        | Tier aliases, official SDK/API adapters, structured output, prompt/planner/validator, doctrines, detached decisions, durable memory/logs, priority seats, accounting and fallback                               | Live seats/accounts, quota and model-quality observations                                    |
| **3 — Sergeants/reactivity**   | Durable per-group queues/ack, deterministic and LLM paths, fog-filtered contacts, urgent/notable batching, sitreps, cancellation/retry and contributor execution                                                | Real game event source and live-seat load                                                    |
| **4 — Terrain/map**            | Synthetic deterministic classification, sentinel/slope/traversability logic, strict rectangular provenance contract, upload/cache/session prompt summaries and validation                                       | Arma terrain extraction and target-account KV behavior                                       |
| **5 — Multi-commander/player** | Per-session/faction identities, faction-relative state, Poligon versus mode, independent OPFOR/BLUFOR Commander sessions and command ownership                                                                  | Multiplayer Conflict/JIP/player task behavior in Arma                                        |
| **6 — Production preparation** | Durable checkpoints/queues, session archives, canonical replay/R2 storage layer, cost/replay dashboards, 50-group deterministic profile, Worker dry runs, Container image recipe, operator/deployment checklist | Real deploy, lifecycle/load/rollback/observability, Workshop packaging, dedicated-server run |

## Deterministic repository gates

All are required for a locally accepted TypeScript revision:

```bash
pnpm check
pnpm lint:tailwind
pnpm test
pnpm typecheck
pnpm build
pnpm eval -- --replay
pnpm ai:smoke
```

The replay gate must remain network-free. The suite includes strict architecture
checks, protocol/Test-12 conformance, full→delta semantic replays, single and
versus isolation, 50-group simulation, link restore/resync, Commander durable
work/accounting, Maskirovka cache/failover/governor behavior, Poligon
offline/replay/cost behavior, and hosted-seat fake-runner/router coverage.

Docker adds a separate code/image-shape check:

```bash
pnpm --filter @stavka/maskirovka-seat build:container
```

None of these commands proves external infrastructure or provider behavior.

## Local integration gate

After deterministic gates:

1. Copy the Commander and Poligon `.dev.vars.example` files.
2. Start Commander and Poligon with their workspace filters.
3. Confirm both health probes and a `401` for an unauthenticated Commander
   machine request.
4. Run a fixed Agent-hosted scenario through connect → terrain upload → full
   tick → delta tick → bounded command → terminal command result.
5. Run `mode=versus` and confirm independent OPFOR/BLUFOR sessions and costs.
6. Reload the same scenario identity and verify checkpoint/state restoration;
   restart Commander and verify a requested full resync.
7. Run `host=offline` and verify stepping never creates Agent, HTTP, or
   WebSocket traffic.
8. Import a local canonical export at `/replay` and inspect the cause → decision
   → commands → outcomes timeline and cost table.

A green unit suite without the real local HTTP/Agent/browser loop is not a
complete local-stack acceptance result.

## External gates — pending

Only the following categories remain outside repository-only acceptance.

### Cloudflare deployment and lifecycle

- select the target account and create/bind Commander DO/KV/R2, Poligon Agent,
  hosted-seat DO/Container/assets, routes, and domains;
- configure Access applications, policies, audiences, team domains, and
  least-privilege service tokens for every human HTTP/WebSocket surface;
- inject and rotate machine/provider secrets and prove they never appear in
  source, bundles, logs, replay exports, request metadata, or browser state;
- verify DO/R2/KV state, queued work, exports, and session isolation across
  eviction/redeploy;
- exercise Container build/deploy/start/sleep/restart, auth restoration,
  rotation, backpressure, and kill-switch behavior;
- perform deployed load, observability, failure-mode, rollback, and retention
  drills.

### Live provider accounts

- authenticate operator-owned Claude and Codex subscription seats and any
  deliberately enabled metered API fallback;
- verify current model/tier entitlement, structured response fidelity,
  cancellation, latency, retryability, burst/quota exhaustion, and recovery;
- reconcile estimated plan credit/list savings/cash against observed provider
  counters and invoices;
- record sanitized live corpus provenance only as an explicit operator action.

### Production Arma addon and dedicated server

The production `CommanderLink`/`RestLink`, state/event extraction, native order
execution, game-server secret configuration, Conflict integration, multiplayer
and JIP behavior, Workshop packaging, and Workbench compilation are not part of
this macOS implementation scope. `mods/StavkaTest` is historical research, not
an installable product addon.

When Windows and an Arma Reforger dedicated host are available, acceptance must
cover protocol-v1 full/delta/config/resync/reconnect parity, supported native
orders/results, server-authoritative fog/events/groups, mission restart/key
rotation, BattlEye, two factions, 30/40/50-group performance, installation,
upgrade, and rollback. No such validation is claimed now.

## Current verification evidence

The root task must refresh this table after every concurrently landing source
change. Do not substitute focused or earlier green numbers for the final tree.

| Check                                        | Result for current workspace |
| -------------------------------------------- | ---------------------------- |
| `pnpm check`                                 | Pending final root refresh   |
| `pnpm lint:tailwind`                         | Pending final root refresh   |
| `pnpm test`                                  | Pending final root refresh   |
| `pnpm typecheck`                             | Pending final root refresh   |
| `pnpm build`                                 | Pending final root refresh   |
| `pnpm eval -- --replay`                      | Pending final root refresh   |
| `pnpm ai:smoke`                              | Pending final root refresh   |
| Hosted-seat Worker dry run/container build   | Pending final root refresh   |
| Local Commander + Poligon HTTP/browser smoke | Pending final root refresh   |
| Cloudflare/Access/KV/R2/Container deployment | Not run; external pending    |
| Live Claude/Codex/API validation             | Not run; external pending    |
| Production mod/Workbench compile             | Not run; excluded by scope   |
| Dedicated-server run                         | Not run; excluded by scope   |

For operating instructions, see the [operator guide](OPERATOR_GUIDE.md).
