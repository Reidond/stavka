# Phased Execution — Detailed Reference

## Decision Tree

```
Is the task classified as Large (score 7+)?
├── No → Do not phase. Use small/medium pipeline.
└── Yes → Assess phase suitability:
    ├── Does the task affect 2+ independent concerns?
    │   └── No → Do not phase. Execute sequentially.
    ├── Does an intermediate consistent+testable state exist?
    │   └── No → Do not phase. The work is atomic.
    ├── Do later phases invalidate earlier phases?
    │   └── Yes → Do not phase. Execute as a single unit.
    └── All three criteria met → Phase the task.
        └── Can you identify 2–4 natural boundaries?
            ├── Yes → Proceed with phased execution.
            └── No (5+ boundaries) → Split into separate specs instead.
```

## Good Phase Boundaries (Project Examples)

**Example 1: "Implement new coach_test feature for voice-based testing"**

| Phase | Scope | Exit State |
|-------|-------|------------|
| 1. Data foundation | Entities, enums, migrations, repositories | DB schema ready, repositories tested |
| 2. Business logic | Services, prompt builders, AI integration | Services pass unit tests, prompts render correctly |
| 3. API + WebSocket | Routes, decorators, WebSocket handler, schemas | Endpoints respond, WebSocket connects |
| 4. Integration + polish | Integration tests, error paths, docs | Full feature works end-to-end |

Why this works: each phase produces a consistent, testable layer. Phase 2 builds on
phase 1's repositories. Phase 3 builds on phase 2's services. No phase breaks what
the previous one built.

**Example 2: "Add feedback SSE + progress tracking"**

| Phase | Scope | Exit State |
|-------|-------|------------|
| 1. Data + service | Job status entity, migration, service with progress tracking | Progress updates work in-memory |
| 2. API + SSE | SSE endpoint, event streaming, client integration | Browser receives live progress events |

Why this works: two natural halves — the engine (service) and the delivery mechanism (SSE).
Each is independently testable.

## Bad Phase Boundaries (Anti-Patterns)

**Anti-pattern 1: Splitting a model from its migration**

| Phase | Problem |
|-------|---------|
| 1. Create entity class | Entity exists but table doesn't — broken state |
| 2. Create migration | Now it works, but phase 1 was untestable |

Fix: always group entity + migration + repository in the same phase.

**Anti-pattern 2: Splitting a service from its tests**

| Phase | Problem |
|-------|---------|
| 1. Implement all services | No verification — bugs accumulate silently |
| 2. Write all tests | Tests find issues in phase 1 code, requiring rework |

Fix: each phase should include tests for the code it introduces.

**Anti-pattern 3: Arbitrary file-count splits**

| Phase | Problem |
|-------|---------|
| 1. Files 1–7 | Random mix of layers — no coherent deliverable |
| 2. Files 8–15 | Depends heavily on incomplete phase 1 code |

Fix: split by concern or layer, never by file count.

**Anti-pattern 4: Over-decomposition**

Splitting 12 tasks into 6 phases of 2 tasks each. Every phase boundary is a context
reset and a quality gate. Six boundaries means six opportunities for architectural drift
and six rounds of overhead. Three phases of four tasks would be far more effective.

Rule of thumb: 2–4 phases. If you need more, the task should be separate specs.

## Phase Template (for tasks.md)

When phasing is used, replace the "Parallel Groups" section in tasks.md with:

```markdown
## Phases

### Phase 1: {Objective in one sentence}

- **Entry criteria**: {What must be true before starting — e.g., "spec approved"}
- **Exit criteria**: {What must be true to consider this phase done}
- **Quality gate**: Light / Standard / Full
- **Tasks**: 1, 2, 3

### Phase 2: {Objective in one sentence}

- **Entry criteria**: {e.g., "Phase 1 complete, all tests pass"}
- **Exit criteria**: {Concrete, testable condition}
- **Quality gate**: Light / Standard / Full
- **Tasks**: 4, 5, 6

### Phase 3 (Final): {Objective in one sentence}

- **Entry criteria**: {e.g., "Phases 1–2 complete, services tested"}
- **Exit criteria**: {e.g., "All acceptance criteria met, integration tests pass"}
- **Quality gate**: Full
- **Tasks**: 7, 8, 9
```

The final phase always uses a **Full** quality gate.

## Context Handoff Checklist

At the start of each phase (especially after a context reset):

1. Re-read `.specs/{task-name}/requirements.md` for overall goals
2. Re-read `.specs/{task-name}/design.md` for architectural decisions
3. Re-read `.specs/{task-name}/tasks.md` for current progress and deviations
4. Check which tasks are marked complete vs remaining
5. Review any deviations logged by previous phases
6. Read `.ai/learnings.md` for relevant project knowledge
7. Only then begin implementing the current phase's tasks

Do NOT assume any detail from a previous conversation. The spec documents are the
single source of truth.

## Quality Gate Levels

### Light Gate

Use for simple, low-risk phases (single layer, 2–3 tasks, no cross-feature impact).

Steps:
1. Run `uv run ruff check` on all modified files
2. Run `read_lints` on all modified files
3. Quick self-review: any obvious issues, missing error handling, broken imports?
4. Fix any issues found

### Standard Gate

Use as the default for most phases.

Steps:
1. High-level conceptual review
2. Detailed file-by-file review
3. Project conventions review
4. Self-challenge
5. Document findings and implement fixes
6. Run linting and diagnostics

### Full Gate

Use for the final phase, or for phases with cross-feature impact or architectural decisions.

Steps: Follow the complete 8-step process from `.claude/skills/post-task-review/SKILL.md`:
- Steps 1–6: code review and convention compliance
- Step 7: documentation impact analysis
- Step 8: learnings extraction
