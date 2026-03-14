# plan-critic

**Implementation Plan Critic & Challenger** — rigorous AI self-review of spec documents and Cursor plans before they are presented to the user.

## What it does

Runs a structured 5-dimension review against any plan document:

1. **Security** — auth boundaries, JWT service-to-service, input validation, secrets in config
2. **Overengineering** — justified abstractions, YAGNI, async where appropriate
3. **Stability** — external I/O failure handling, race conditions, DB transaction scope
4. **Impact** — breaking API/WebSocket contracts, Alembic migrations, rollback path
5. **Completeness** — verifiable acceptance criteria, testing strategy, scope hygiene

Findings are classified as Blocker / Major / Minor / Question. The AI resolves what it can
silently, then either presents the document normally (approved) or surfaces unresolved
Blockers and Questions prominently before asking the user to address them.

## When it runs

- After writing `spec.md` (medium tasks) — full review
- After writing `design.md` (large tasks) — full review
- After writing `tasks.md` (large tasks) — completeness-only pass
- After creating a Cursor plan via `CreatePlan` — full review

## Skill file

See [SKILL.md](SKILL.md) for the full review protocol, finding format, severity definitions,
and project-specific context.
