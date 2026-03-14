# Spec-Driven Development

**NEVER write implementation code, create files, or make any code edits until all required spec documents have been explicitly approved by the user.**

This is a hard gate. Proceeding to implementation without approval is not permitted regardless of task urgency or apparent simplicity.

## Step 1 — Classify Task Size

Score the task across these dimensions before doing anything else:

| Dimension | Small (0) | Medium (1) | Large (2) |
|-----------|-----------|------------|-----------|
| Files to create/modify | 1–3 | 4–10 | 10+ |
| Features involved | 1 existing | 1 with new components | 2+ features |
| DB migrations needed | No | Simple | Complex |
| New API endpoints | 0 | 1–2 | 3+ |
| Cross-feature communication | None | Reads another feature | New integration |
| Architectural decisions | None | Minor | Major |

- Score 0–2 → **Small**
- Score 3–6 → **Medium**
- Score 7+ → **Large**

Present the classification to the user before proceeding:
```
Task size: {SMALL | MEDIUM | LARGE}
Rationale: {1-2 sentences}
Proceeding with: {direct implementation | lightweight spec | full spec}
```

## Step 1.5 — Ambiguity Scan (Medium and Large tasks only)

Before writing any spec document, scan for blocking ambiguities.
Skip this step entirely for Small tasks.

Ask at most **2 questions** using the `AskQuestion` tool when **any** of these triggers apply:

| Trigger | Example |
|---|---|
| Multiple architecturally distinct solutions exist | REST vs WebSocket, sync vs async |
| A requirement states a goal without specifying constraints | "improve performance" — what target or SLA? |
| An existing interface is touched and backward compatibility is unclear | "update endpoint X" — must existing consumers keep working? |
| A scope or ownership assumption is being made | placing work in feature Y without confirmation |

Cap: ask the 2 most architecture-impacting questions if more triggers apply.

Do NOT ask about: naming, code style, error messages, test structure, or anything
resolved by project convention. These are Minor plan-critic findings, not user questions.

If no triggers fire, proceed directly to Step 2 without asking anything.

## Step 2 — Follow the Mandatory Sequence

### Small tasks (score 0–2)
Implement directly. No spec required.

### Medium tasks (score 3–6)
1. Write `.specs/{task-name}/spec.md` to disk
2. **STOP** — present the document to the user and wait for explicit approval
3. Only implement after approval

### Large tasks (score 7+)
1. Write `.specs/{task-name}/requirements.md` to disk
2. **STOP** — present to user, wait for explicit approval before continuing
3. Write `.specs/{task-name}/design.md` to disk (only after requirements approved)
4. **STOP** — present to user, wait for explicit approval before continuing
5. Write `.specs/{task-name}/tasks.md` to disk (only after design approved)
6. **STOP** — present to user, wait for explicit approval before continuing
7. Only then implement — use `tasks.md` as the TODO list and mark tasks complete as you go

## Step 2.5 — Self-Review Before Every STOP Gate

**Before presenting any spec document to the user**, run the plan-critic self-review:

- Invoke `.claude/skills/plan-critic/SKILL.md` immediately after writing the document.
- For `spec.md` and `design.md`: full review (all 5 dimensions).
- For `tasks.md`: completeness-only pass (Dimensions 4–5 only).
- Resolve all Blocker and Major findings by revising the document — silently, before presentation.
- If a Blocker or Question cannot be resolved without user input, mark it `[UNRESOLVED]` and surface it prominently at the top of the presented document.
- Minor findings are fixed silently and never mentioned unless they changed the document significantly.

The plan-critic runs **before** the STOP gate — not after. The user should only ever see a document that has already passed self-review.

## Approval Definition

- **Explicit approval**: user says "approved", "looks good", "proceed", "go ahead", or clear equivalent
- **Revision request**: apply the change, update the file, re-present, wait again
- **Ambiguous or silent**: ask — "Do you approve this document, or would you like changes?"

Never advance to the next stage without explicit approval.

## Full Process

See `.claude/skills/spec-driven-dev/SKILL.md` for size detection heuristics, templates, phased execution, and the challenge protocol.
