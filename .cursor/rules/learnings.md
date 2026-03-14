# Learnings System

The project maintains accumulated knowledge in `.ai/learnings.md`. This file captures
architecture decisions, pitfalls, external API quirks, and convention clarifications
discovered during development.

## Rules

- **Before starting any task**: read `.ai/learnings.md` for relevant past findings.
- **After completing any task**: MUST run the learnings extraction process and append findings to `.ai/learnings.md`. This is part of the mandatory task completion checklist (AGENTS.md).
- **When the human corrects your approach**: record the correction as a learning.

## Full Process

See `.claude/skills/task-learnings/SKILL.md` for the complete extraction and recording procedure.

## Data File

`.ai/learnings.md` — append-only, structured entries with date, context, finding, and impact.
