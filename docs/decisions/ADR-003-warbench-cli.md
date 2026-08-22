# ADR-003 — Warbench is a CLI, not a dashboard feature

- Status: accepted
- Date: 2026-08-21
- Amends: ADR-002 (which anticipated a unified `/experiments/warbench` route)

## Context

ADR-002 planned to expose the independent benchmark as a dashboard route of the
unified Stavka application. After unifying the shell, the operator workflow for
running studies is batch-oriented: freeze a manifest, execute arms against
fixed seeds, wait on provider responses, and export immutable evidence. That
workflow has no meaningful interactive UI and would only add a second surface
to authenticate, render, and maintain.

## Decision

Warbench ships as a CLI (`pnpm warbench`, package `@stavka/warbench-cli`):

```sh
pnpm warbench connect                       # Codex device authorization (local)
pnpm warbench create study-v1 --mode full   # freeze the manifest
pnpm warbench run-rule study-v1             # deterministic baseline arm
pnpm warbench run-candidate study-v1        # probe-gated model arm
pnpm warbench complete study-v1             # terminal; digest frozen
pnpm warbench evidence study-v1 --json out.json --pdf out.pdf
```

- Study data lives in an operator-chosen directory (default `.warbench/`),
  never committed. Credentials live beside it with owner-only directory/file
  permissions (`0700`/`0600`), are never migrated from the standalone
  repository, and are never copied into Cloudflare.
- The CLI shares `@stavka/warbench-core` orchestration with the server-side
  `WarbenchStudyStore` Durable Object, so file-backed and DO-backed evidence
  enforce identical immutability rules.
- The unified dashboard carries no Warbench section; the placeholder route was
  removed.

## Consequences

- No BFF endpoints or browser code exist for benchmarks; Access scope for
  humans stays limited to operations surfaces.
- Server-side study ingestion can later reuse the same manifests and results
  schema when machine routes are introduced.
- The hypothesis gates remain mechanical: PASS/FAIL requires a complete,
  probe-gated grid; anything less is INCONCLUSIVE.
