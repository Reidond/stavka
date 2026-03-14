# Tasks: {task-name}

> Ordered implementation tasks derived from the design document. Track progress by
> checking off completed tasks. Use EITHER the "Parallel Groups" format (non-phased)
> or the "Phases" format (phased) — not both.

## Dependency Graph

<!-- Which tasks depend on which. Identify parallel groups or phases. -->

```
Task 1 (no deps) ──┐
Task 2 (no deps) ──┼── Task 4 (depends on 1, 2) ── Task 6 (depends on 4)
Task 3 (no deps) ──┘                                Task 5 (depends on 3)
```

---

<!-- Choose ONE of the two formats below. Delete the one you don't use. -->

## Option A: Parallel Groups (Non-Phased)

<!-- Use this for large tasks that should execute sequentially without phase boundaries. -->

- **Group A** (can run concurrently): Tasks {1, 2, 3}
- **Group B** (after Group A): Tasks {4, 5}
- **Group C** (after Group B): Task {6}

## Option B: Phases (Phased Execution)

<!-- Use this when the task has natural phase boundaries (2+ independent concerns,
     intermediate consistent states, later phases don't invalidate earlier ones).
     See .claude/skills/spec-driven-dev/references/phased-execution.md for guidance. -->

### Phase 1: {Objective in one sentence}

- **Entry criteria**: Spec approved by user
- **Exit criteria**: {Concrete, testable condition — e.g., "DB schema ready, repositories pass unit tests"}
- **Quality gate**: Light / Standard / Full
- **Tasks**: 1, 2, 3

### Phase 2: {Objective in one sentence}

- **Entry criteria**: Phase 1 complete, all phase 1 tests pass
- **Exit criteria**: {Concrete, testable condition}
- **Quality gate**: Light / Standard / Full
- **Tasks**: 4, 5, 6

### Phase 3 (Final): {Objective in one sentence}

- **Entry criteria**: Phases 1–2 complete
- **Exit criteria**: All acceptance criteria met, integration tests pass
- **Quality gate**: Full
- **Tasks**: 7, 8, 9

<!-- Maximum 4 phases. More than 4 indicates the task should be split into separate specs.
     The final phase always uses a Full quality gate. -->

---

## Task List

### Task 1: {Title}

- **Size**: S / M / L
- **Depends on**: None
- **Files to modify**: `backend/app/...`
- **Files NOT to modify**: `backend/app/...`
- **Acceptance criteria**:
  - [ ] {Verifiable criterion 1}
  - [ ] {Verifiable criterion 2}
- **Test requirements**: {What tests to write or update}
- **Status**: [ ] Not started

### Task 2: {Title}

- **Size**: S / M / L
- **Depends on**: None / Task {N}
- **Files to modify**: `backend/app/...`
- **Files NOT to modify**: `backend/app/...`
- **Acceptance criteria**:
  - [ ] {Verifiable criterion 1}
  - [ ] {Verifiable criterion 2}
- **Test requirements**: {What tests to write or update}
- **Status**: [ ] Not started

<!-- Add more tasks as needed. Maximum 15 tasks per spec — split into separate specs if more are required. -->

## Deviations Log

<!-- Track any changes from the original design during implementation. -->

| Task | Deviation | Rationale |
|------|-----------|-----------|
| — | — | — |
