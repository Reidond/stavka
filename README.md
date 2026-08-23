# Stavka

Stavka is an Effect-first AI command-and-control stack for Arma Reforger. A
versioned battlefield protocol feeds a durable Commander, deterministic
Sergeants, and bounded LLM seats; Poligon reproduces the same command loop on
macOS without a game installation.

Everything feasible without Arma Reforger Tools or operator-owned cloud/model
accounts is implemented in this workspace: strict protocol and replay
contracts, Commander orchestration, deterministic simulation and link behavior,
Poligon's hosted and browser-local modes, local and hosted Maskirovka code, the
Kumo-based frontend surfaces, and deterministic verification/evaluation tooling.

> **External boundary:** no production Arma addon or dedicated-server layer is
> claimed. The CI-gated production workflow is implemented but no live deploy is
> run by repository verification. Real Cloudflare bindings, Access policies,
> Container lifecycle behavior, and live Claude/Codex/API accounts require
> operator-owned infrastructure and credentials.

## Quick start

Requirements:

- Node.js 22 (see `.node-version`)
- pnpm 11.18.0 (pinned by `packageManager`)
- Vite+ from the workspace; a global `vp` install is not required
- Docker only for a local hosted-seat image build

```bash
corepack enable
pnpm install --frozen-lockfile
```

Start the unified local application:

```bash
pnpm --filter @stavka/stavka dev
```

The unified dashboard contains local simulation, replay, model, usage, and
system routes. Commander and inference are private Cloudflare services in the
production topology and are reached through service bindings, not public
browser origins.

The local LLM gateway is also deterministic by default:

```bash
pnpm ai:up
pnpm ai:smoke
```

`ai:up` binds Maskirovka to `127.0.0.1:4141`; `ai:smoke` uses only the mock
seat. Live provider actions and local/manual deployment actions are always
explicit operator steps. CI is verification-only; production deployment is a
separate manual workflow restricted to `main`.

Warbench is an independent local CLI, not a dashboard or deployed service:

```bash
pnpm warbench models
pnpm warbench calibrate
pnpm warbench create warbench-smoke-v2 --mode smoke --model <exact-model-id>
pnpm warbench status warbench-smoke-v2
```

Its default data directory is outside the repository under the operator's XDG
state directory (or `~/.local/state/stavka/warbench-v2`). Use `--data-dir` to
select another owner-only location. See
[`ADR-003`](docs/decisions/ADR-003-warbench-cli.md) for the immutable-study
contract.

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
- Frontend surfaces import granular `@cloudflare/kumo` components and primitives,
  use Kumo semantic tokens, and keep feature-specific compositions app-local.
  TanStack Table/Form/Virtual are direct dependencies only where a surface needs
  their headless behavior.
- `pnpm lint:tailwind` runs per-entrypoint, warning-as-error Oxc/Tailwind rules
  against each app's real CSS source. Tracked VS Code settings and extensions
  give Cursor the same Tailwind v4 entrypoints and Kumo semantic utilities.

The tracked [Effect v4 skill](.agents/skills/effect-v4/SKILL.md) and
[engineering guide](docs/EFFECT_V4.md) contain the project-specific patterns.

## Repository map

| Path                         | Responsibility                                                                                                         |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `packages/protocol`          | Strict Effect Schemas for protocol v1, full/delta state, config updates, map briefings, LLM frames, and replay exports |
| `packages/access-auth`       | Constant-time machine bearer auth and Cloudflare Access verification                                                   |
| `packages/doctrine`          | Typed Commander doctrine presets                                                                                       |
| `packages/sim-core`          | Seeded 100 ms simulation, terrain, objectives, command fidelity, restore, and 50-group profile                         |
| `packages/sim-link`          | Effect transport/link, faction projection, fog of war, deltas, config updates, reports, and command execution          |
| `packages/warbench-core`     | Provider-independent deterministic simulator, immutable studies, calibration, gates, and paired analysis               |
| `packages/model-provider-pi` | Pinned Pi/Codex provider and device-authorization adapter                                                              |
| `packages/warbench-report`   | Deterministic PDF evidence rendering from the canonical study object                                                   |
| `tools/warbench`             | Operator-local immutable-study CLI and owner-only file store                                                           |
| `tools/tasks`                | Effect-first repository task orchestration behind short package-script aliases                                         |
| `services/commander`         | Private Effect HttpApi Worker, durable Commander/Sergeants, accounting, logs, and replay exports                       |
| `services/inference`         | Private Maskirovka gateway Worker/Container and operations dashboard                                                   |
| `apps/stavka`                | Unified Access-protected dashboard, simulation, replay, model, usage, and system routes                                |
| `apps/maskirovka-seat`       | Optional hosted single-seat Worker/Container; not part of the production deploy plan                                   |
| `mods/StavkaTest`            | Preserved historical Workbench research harness; not the production mod                                                |

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
Exact gate results and the local browser acceptance evidence are recorded in
[`docs/IMPLEMENTATION_STATUS.md`](docs/IMPLEMENTATION_STATUS.md).

These checks use mocks, fakes, and replay data. They do not prove a real
Cloudflare deployment, Access policy, subscription seat, production addon, or
dedicated server. The manual production job deploys inference, Commander, then
the unified app; upload success alone is not post-deploy HTTP health.

## Documentation

- [Service URLs](docs/URLS.md) — local and production origins, path maps, and
  probe commands
- [Operator guide](docs/OPERATOR_GUIDE.md) — local stacks, modes, routes,
  exports, secrets, and deployment preparation
- [Warbench study runbook](docs/runbooks/warbench-study.md) — calibration,
  exact-model smoke, protocol freeze, held-out execution, and evidence rules
- [Implementation and acceptance status](docs/IMPLEMENTATION_STATUS.md) —
  product/phase matrix and the exact external gates
- [Effect v4 engineering guide](docs/EFFECT_V4.md) — service, repository,
  HttpApi, concurrency, and boundary conventions
- [Product specification](PRODUCT.md) — product intent and original phased plan

`PRODUCT.md` remains the design source. The acceptance document records what
the current workspace implements and what still needs external proof.
