# Post-Task Review

An 8-step review process that extends the existing task-completion-review with
documentation impact analysis and learnings extraction.

## Rules

- **MUST run after**: any task that modifies 3+ files, implements a new feature, completes a
  spec-driven task, or is explicitly requested. Do not skip — it is part of the mandatory task completion checklist (AGENTS.md).
- **Steps 1–6**: code review and convention compliance.
- **Step 7**: documentation impact analysis — check and update affected docs.
- **Step 8**: learnings extraction — capture findings in `.ai/learnings.md`.

## Full Process

See `.claude/skills/post-task-review/SKILL.md` for the complete 8-step pipeline,
output format, and reference files (doc-impact-matrix, review-checklist).
