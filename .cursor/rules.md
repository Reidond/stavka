# Cursor AI Assistant Rules

> Detailed conventions live in shared skills. This file contains the essential quick-reference
> and documentation index. See `.claude/skills/` for authoritative skill definitions.

## Core Principles

1. **Read Before Writing** — Always read existing code before making changes.
2. **Follow Patterns** — Match existing codebase patterns.
3. **Complete Tasks Fully** — Don't leave tasks half-finished.
4. **Review Your Work** — Self-review before declaring completion.
5. **Test Your Changes** — Run lints and diagnostics on modified files.

## Default Workflow

1. **Understand** — Clarify requirements, identify files/features involved.
2. **Explore** — Search codebase for patterns and related code.
3. **Read** — Read related files in parallel; start with interfaces/base classes.
4. **Implement** — Follow conventions from skills; use shared exceptions, one-class-per-file.
5. **Review** — Run `post-task-review` skill for major changes; always lint.

## Documentation Index

### Skills (Authoritative Convention Sources)

| Skill | Purpose |
|-------|---------|
| `task-learnings` | Extract and record project learnings after tasks |
| `spec-driven-dev` | Spec-driven development pipeline for medium/large tasks |
| `post-task-review` | 8-step post-task review with doc impact analysis |
| `commit-message` | Generate concise, conventional commit messages |
| `ai-docs-lookup` | Fetch official AI provider docs before answering AI model questions |

Skills live in `.claude/skills/{name}/SKILL.md`.

### Cursor Rules (Thin References)

- [Learnings System](.cursor/rules/learnings.md) — Project knowledge accumulation
- [Spec-Driven Dev](.cursor/rules/spec-driven-dev.md) — Requirements-first pipeline
- [Post-Task Review](.cursor/rules/post-task-review.md) — 8-step review process

### AI Infrastructure

- [Project Learnings](.ai/learnings.md) — Accumulated project knowledge (read before tasks)
- [Templates](.ai/templates/) — requirements.md, design.md, tasks.md
- [AGENTS.md](AGENTS.md) — Shared agent instructions (Codex/Copilot compatible)
