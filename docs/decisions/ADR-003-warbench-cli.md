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
pnpm warbench models                        # exact first-party Codex ids
pnpm warbench calibrate                     # 100 non-holdout seeds/family
pnpm warbench connect                       # Codex device authorization (local)
pnpm warbench probe --model <exact-id>       # full validation path
pnpm warbench create study-v2 --mode full --model <exact-id>
pnpm warbench status study-v2               # counts/missing slots only
pnpm warbench run-rule study-v2             # missing baseline slots only
pnpm warbench run-candidate study-v2        # missing model slots only
pnpm warbench complete study-v2             # complete grid; digest frozen
pnpm warbench verify-evidence study-v2       # recompute frozen digest
```

- Study data lives in an operator-chosen directory outside the repository by
  default (`$XDG_STATE_HOME/stavka/warbench-v2`, falling back to
  `~/.local/state/stavka/warbench-v2`). A named `warbench` Codex account lives
  beside it in the owner-only local profile store (`0700` directory / `0600`
  file); credentials are never migrated from the standalone repository or
  copied remotely by a study run.
- The CLI shares `@stavka/warbench-core` orchestration with the server-side
  `WarbenchStudyStore` Durable Object, so file-backed and DO-backed evidence
  enforce identical immutability rules.
- Calibration/smoke data uses non-holdout seeds. Full studies use ten unique
  seeds derived from the frozen protocol label `warbench-study-v2-holdout`.
- Combat is simultaneous, persisted rows and manifests are schema-decoded, and
  completed evidence is canonically sorted, hashed once, and verified before
  final export. JSON, PDF, CSV, and Markdown derive from that same object.
- The unified dashboard carries no Warbench section; the placeholder route was
  removed.

## Consequences

- No BFF endpoints or browser code exist for benchmarks; Access scope for
  humans stays limited to operations surfaces.
- Server-side study ingestion can later reuse the same manifests and results
  schema when machine routes are introduced.
- The hypothesis gates remain mechanical: PASS/FAIL requires a complete,
  probe-gated grid; anything less is INCONCLUSIVE.
