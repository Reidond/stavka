# Stavka

Stavka is an Effect-first AI command-and-control stack for Arma Reforger. A
versioned battlefield protocol feeds a durable Commander, deterministic
Sergeants, and bounded LLM seats; Poligon reproduces the same command loop on
macOS without a game installation.

Everything feasible without Arma Reforger Tools or operator-owned cloud/model
accounts is implemented in this workspace: strict protocol and replay
contracts, Commander orchestration, deterministic simulation and link behavior,
Poligon's hosted and browser-local modes, local and hosted Maskirovka code, the
shared frontend system, and deterministic verification/evaluation tooling.

> **External boundary:** no production Arma addon or dedicated-server layer is
> claimed. Real Cloudflare deployment and bindings, Access policies, Container
> lifecycle behavior, and live Claude/Codex/API accounts also require
> operator-owned infrastructure and credentials and have not been validated by
> the repository-only implementation pass.

## Quick start

Requirements:

- Node.js 22 (see `.node-version`)
- pnpm 11.18.0 (pinned by `packageManager`)
- Vite+ from the workspace; a global `vp` install is not required
- Docker only for a local hosted-seat image build

```bash
corepack enable
pnpm install --frozen-lockfile

cp apps/commander/.dev.vars.example apps/commander/.dev.vars
cp apps/poligon/.dev.vars.example apps/poligon/.dev.vars
```

The examples use the rule Commander and an exact-local synthetic Access
identity. They contain matching placeholder machine keys and do not need a
provider account.

Run the Agent-backed loop in separate terminals:

```bash
pnpm --filter @stavka/commander dev
```

```bash
pnpm --filter @stavka/poligon dev
```

Commander defaults to `http://127.0.0.1:8787`; Poligon prints its URL. For a
zero-network browser simulation, open Poligon with `?host=offline`. Use
`?mode=versus` for isolated OPFOR and BLUFOR commanders, or open `/replay` to
inspect a local canonical Commander export without uploading it.

The local LLM gateway is also deterministic by default:

```bash
pnpm ai:up
pnpm ai:smoke
```

`ai:up` binds Maskirovka to `127.0.0.1:4141`; `ai:smoke` uses only the mock
seat. Live provider and deployment actions are always explicit operator steps.

## Engineering contract

- Application, service, validation, configuration, concurrency, and
  infrastructure code uses Effect v4, pinned to `4.0.0-beta.102`.
- HTTP is contract-first `HttpApi`/`HttpApiBuilder`, composed through Effect
  routers and Node or web-standard adapters. The project has no Hono or manual
  pathname dispatch.
- SQL and persistence schema text live only in repository modules; use cases,
  agents, and handlers call Effect repository operations.
- Wire, persisted, URL, map, and replay data is decoded with Effect Schema at
  the boundary.
- Frontend variants use `tailwind-variants@3.3.0` `tv`; Tailwind-aware class
  composition uses the shared `cn` helper from `@stavka/ui`.
- `pnpm lint:tailwind` runs per-entrypoint, warning-as-error Oxc/Tailwind rules
  against each app's real CSS source. Tracked VS Code settings and extensions
  give Cursor the same Tailwind v4, `tv(...)`, and `cn(...)` awareness.

The tracked [Effect v4 skill](.agents/skills/effect-v4/SKILL.md) and
[engineering guide](docs/EFFECT_V4.md) contain the project-specific patterns.

## Repository map

| Path                   | Responsibility                                                                                                         |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `packages/protocol`    | Strict Effect Schemas for protocol v1, full/delta state, config updates, map briefings, LLM frames, and replay exports |
| `packages/access-auth` | Constant-time machine bearer auth and Cloudflare Access verification                                                   |
| `packages/doctrine`    | Typed Commander doctrine presets                                                                                       |
| `packages/sim-core`    | Seeded 100 ms simulation, terrain, objectives, command fidelity, restore, and 50-group profile                         |
| `packages/sim-link`    | Effect transport/link, faction projection, fog of war, deltas, config updates, reports, and command execution          |
| `packages/ui`          | Shared Tailwind variants, tokens, interaction primitives, tables, forms, and virtual feeds                             |
| `tools/tasks`          | Effect-first repository task orchestration behind short package-script aliases                                         |
| `apps/commander`       | Effect HttpApi Worker, durable Commander/Sergeants, seat routing/accounting, logs, inline/R2 replay exports            |
| `apps/poligon`         | TanStack/THREE proving ground with Agent, offline, versus, replay, and cost views                                      |
| `tools/maskirovka`     | Local Effect HttpApi mock/subscription/API gateway, replay cache, contributor client, accounting, and operations SPA   |
| `apps/maskirovka-seat` | Single-seat Worker/Container code with machine API and Access-protected leaf dashboard                                 |
| `mods/StavkaTest`      | Preserved historical Workbench research harness; not the production mod                                                |

## Verification

Run the repository gates before relying on a revision:

```bash
pnpm check
pnpm lint:tailwind
pnpm test
pnpm typecheck
pnpm build
pnpm verify
pnpm eval -- --replay
pnpm ai:smoke
```

Commander sessions are isolated by `(session_id, mission_epoch, faction)`.
After a local Commander/Poligon smoke, delete the ignored `.dev.vars` copies and
rebuild Poligon so `dist/server` does not retain them. Exact gate results and
the local browser acceptance evidence are recorded in
[`docs/IMPLEMENTATION_STATUS.md`](docs/IMPLEMENTATION_STATUS.md).

These checks use mocks, fakes, and replay data. They do not prove a real
Cloudflare deployment, Access policy, subscription seat, production addon, or
dedicated server.

## Documentation

- [Operator guide](docs/OPERATOR_GUIDE.md) — local stacks, modes, routes,
  exports, secrets, and deployment preparation
- [Implementation and acceptance status](docs/IMPLEMENTATION_STATUS.md) —
  product/phase matrix and the exact external gates
- [Effect v4 engineering guide](docs/EFFECT_V4.md) — service, repository,
  HttpApi, concurrency, and boundary conventions
- [Product specification](PRODUCT.md) — product intent and original phased plan

`PRODUCT.md` remains the design source. The acceptance document records what
the current workspace implements and what still needs external proof.
