---
name: spec-driven-dev
description: >
  Spec-driven development pipeline for medium and large tasks. Auto-detects task size
  based on scope analysis, then guides creation of requirements, design, and task
  decomposition documents before implementation begins. Use when starting a new feature,
  significant refactoring, or any task that touches multiple files or features. Creates
  specs in .specs/{task-name}/ directory.
---

# Spec-Driven Development Pipeline

## When This Skill Activates

Activate at the start of any task that involves:

- Implementing a new feature or significant functionality
- Refactoring that will touch multiple files across layers
- Adding new API endpoints with service and storage layers
- Architectural changes or new integration points
- Any request where the scope is ambiguous or large

Do NOT activate for:

- Simple bug fixes in a single file
- Adding a comment, logging, or renaming
- Documentation-only updates
- **Pure value-only configuration**: numeric threshold or timeout change in a single feature,
  no behavioral mode change (e.g., raising silence_duration_ms from 3000 to 3500, tightening
  a rate limit). These are not architectural decisions.

**Configuration changes that ARE subject to spec classification** (do not exempt these):
- Changing the *default mode* of an AI provider integration (e.g., switching VAD type,
  changing audio model, toggling a behavior flag whose description says "architectural").
- Adding a new session parameter to a shared protocol that multiple features must implement.
- Any configuration change that touches 2+ features or the shared `RealtimeConfigProtocol`.

## Task Size Auto-Detection

Before starting implementation, analyze the task to classify its size.

### Detection Heuristics

Evaluate each dimension and score:

| Dimension | Small (0) | Medium (1) | Large (2) |
|-----------|-----------|------------|-----------|
| **Files to create/modify** | 1–3 | 4–10 | 10+ |
| **Features involved** | 1 existing | 1 with new components | 2+ features |
| **DB migrations needed** | No | Simple add column/table | Complex schema change |
| **New API endpoints** | 0 | 1–2 | 3+ |
| **Cross-feature communication** | None | Reads from another feature | New integration |
| **Architectural decisions** | None | Minor (pattern choice) | Major (new pattern) |

**Classification:**
- Total score 0–2 → **Small** — direct implementation, no spec needed
- Total score 3–6 → **Medium** — lightweight spec (single combined document)
- Total score 7+ → **Large** — full spec (requirements + design + tasks)

See [references/size-detection.md](references/size-detection.md) for detailed examples.

### Present Classification

After detection, present the classification to the user:

```
Task size: {SMALL | MEDIUM | LARGE}
Rationale: {1-2 sentences explaining the score}
Proceeding with: {direct implementation | lightweight spec | full spec}
```

If the user disagrees, accept their override without argument.

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

If no triggers fire, proceed directly to the pipeline without asking anything.

## Pipeline by Size

> **File requirement**: All spec documents must be written to disk at `.specs/{task-name}/`.
> The Cursor `CreatePlan` tool creates a local plan UI element that is not stored in the
> repository and does not substitute for spec files.

### Small Tasks — Direct Implementation

Skip spec creation entirely. Proceed to implementation following existing project conventions.

### Medium Tasks — Lightweight Spec

Create a single combined document:

1. Create `.specs/{task-name}/spec.md` (write to disk — `CreatePlan` does not replace this)
2. Combine key sections from the requirements and design templates:
   - Problem Statement (from `.ai/templates/requirements.md`)
   - Actors and Acceptance Scenarios — User Stories with Gherkin OR Use Cases (from `.ai/templates/requirements.md`)
   - Technical Approach (from `.ai/templates/design.md`)
   - Files to Create/Modify (from `.ai/templates/design.md`)
   - Risk Assessment (from `.ai/templates/design.md`)
3. Self-review using the Spec Quality Checklist at the bottom of this file
4. **Run the plan-critic self-review** (`.claude/skills/plan-critic/SKILL.md`) — full review. Resolve all findings before continuing. If any Blockers or Questions remain unresolved, surface them to the user in the presentation.
5. **STOP.** Present to the user for approval. Wait for explicit approval before continuing.
6. Only proceed to implementation after approval.

### Large Tasks — Full Spec

Create three separate documents in order, with a user approval gate after each:

1. **Requirements**: Create `.specs/{task-name}/requirements.md`
   - Use `.ai/templates/requirements.md` as the starting template
   - Fill in all sections based on task analysis and codebase exploration
   - See [references/requirements-guide.md](references/requirements-guide.md) for Gherkin syntax, actor identification, adversarial scenario generation, and AI pipeline patterns
   - **STOP.** Present to user. Wait for explicit approval before continuing.

2. **Design**: Create `.specs/{task-name}/design.md` (only after requirements approved)
   - Use `.ai/templates/design.md` as the starting template
   - Reference the requirements document for acceptance criteria
   - See [references/design-guide.md](references/design-guide.md) for writing guidance
   - **Run the plan-critic self-review** (`.claude/skills/plan-critic/SKILL.md`) — full review. Resolve all findings before continuing. If any Blockers or Questions remain unresolved, surface them in the presentation.
   - **STOP.** Present to user. Wait for explicit approval before continuing.

3. **Tasks**: Create `.specs/{task-name}/tasks.md` (only after design approved)
   - Use `.ai/templates/tasks.md` as the starting template
   - Derive tasks from the design document
   - Ensure every acceptance criterion maps to at least one task
   - Identify parallel groups and dependencies
   - **Run the plan-critic self-review** (`.claude/skills/plan-critic/SKILL.md`) — completeness-only pass (Dimensions 4–5 only). Resolve all findings before continuing. If any Blockers or Questions remain unresolved, surface them in the presentation.
   - **STOP.** Present to user. Wait for explicit approval before implementation.

4. Proceed to implementation only after all three documents are approved.

## Stage Approval Protocol

Every STOP gate in the pipeline above expects one of three responses from the user:

| Response | Action |
|----------|--------|
| Explicit approval ("approved", "looks good", "proceed") | Advance to the next stage |
| Revision request ("change X", "add Y", "remove Z") | Enter the review cycle |
| Silence or ambiguous response | Ask explicitly: "Do you approve this document, or would you like changes?" |

### Review Cycle

When the user requests a change:

1. **Evaluate the change before applying it.** See the Challenge Protocol below if the change raises a concern.
2. **Apply valid changes**: update the spec file on disk, then re-present the updated document with a brief summary of what changed (e.g., "Updated: removed the Redis caching option from Alternatives; tightened AC-3 to include the 401 error case").
3. **Wait for approval again.** The cycle repeats until the user explicitly approves the document.

### Challenge Protocol

When a requested change is technically questionable — it conflicts with existing project architecture, reverses a decision approved in an earlier stage of this spec, removes the only mitigation for an identified risk, or would add implementation code to the spec — raise the concern before applying anything:

1. **State the conflict clearly**: name the specific constraint it violates (e.g., the vertical slice rule, the earlier approved decision, the risk entry in the spec).
2. **Propose an alternative** if one exists.
3. **Wait for the user to respond.** They may have context the AI lacks.
4. **After the user responds**:
   - If they provide justification: accept the change, apply it, re-present.
   - If they simply insist without new information: apply the change, note it in the spec's Deviations Log as a "user override", re-present.
5. **Never challenge the same point twice.** Once the user has responded, the discussion is closed.

### What the AI challenges

- Changes that contradict the project's vertical slice architecture rules
- Changes that reverse an earlier stage's approved decision without explanation
- Changes that remove the only mitigation for a risk already identified in the spec
- Changes that add implementation code to spec documents

### What the AI does NOT challenge

- Naming preferences, wording choices, or ordering of sections
- Scope changes within reason (the user may have new information about requirements)
- Technology choices that are a matter of preference rather than correctness

## Phased Execution for Large Tasks

Large tasks that affect multiple independent concerns or can reach a consistent intermediate
state may benefit from phased execution. Phasing reduces the context each AI session must
hold, introduces intermediate quality gates, and catches drift before it compounds.

### When to Phase

After writing the design for a large task, assess whether phasing would help.

**Phase when ALL of these are true:**
- The task affects 2+ independent concerns (different features, layers, or subsystems)
- At least one intermediate state exists where the system is consistent and testable
- Later phases build on earlier phases without invalidating them

**Do NOT phase when ANY of these are true:**
- The change must be atomic (e.g., a migration from one API pattern to another across all features)
- All tasks share the same files and cannot be meaningfully separated
- The task is large by file count but single-concern (e.g., adding the same field to 15 entities)

See [references/phased-execution.md](references/phased-execution.md) for decision tree and examples.

### Phase Decomposition (During Design)

When phasing is beneficial, organize tasks into phases in the `tasks.md` document:

1. Identify natural phase boundaries. Good boundaries align with:
   - **Architectural layers**: storage complete → service complete → API complete
   - **Feature slices**: feature A vertical slice → feature B vertical slice
   - **Data flow stages**: data model + repo → business logic → API + integration tests
2. Group tasks into phases (2–4 phases; more than 4 indicates the task should be split into separate specs)
3. Define for each phase: objective, entry criteria, exit criteria, quality gate level
4. Verify each phase leaves the system in a consistent, testable state
5. Present the phased plan to the user for approval

### Phase Execution

Each phase is executed as a semi-independent unit:

1. **Load context**: Re-read requirements.md, design.md, and tasks.md. Do NOT rely on conversation memory from previous phases.
2. **Check entry criteria**: Verify the previous phase's exit criteria are met.
3. **Implement**: Work through the phase's tasks in dependency order.
4. **Update tasks.md**: Mark completed tasks, log deviations.
5. **Run quality gate**: Execute the gate level assigned to this phase.
6. **Handoff**: The updated tasks.md serves as the persistent anchor for the next phase.

### Quality Gate Levels

| Level | When to Use | Steps |
|-------|-------------|-------|
| **Light** | Simple phases (2–3 tasks, single layer) | Lint + quick self-review |
| **Standard** | Default for most phases | Steps 1–6 of task-completion-review |
| **Full** | Final phase, or phases with cross-feature impact | Full 8-step post-task-review |

### Context Handoff Rules

- The spec documents (requirements.md, design.md, tasks.md) are the **persistent memory** across phases
- Never depend on the AI remembering details from a previous phase's conversation
- After each phase, update tasks.md with: task completion status, deviations, and any discoveries
- If a phase reveals that the design needs changes, update the design document before proceeding

## During Implementation

When implementing from a spec (phased or non-phased):

- Work through tasks in dependency order
- Mark each task as complete in the tasks document when done
- If implementation reveals that the spec needs changes, update the spec first and note the deviation in the Deviations Log
- If scope grows beyond the original spec, stop and discuss with the user

## Spec Storage Convention

- All specs live in `.specs/{task-name}/` at the project root
- `{task-name}` uses lowercase with hyphens (e.g., `coach-voice-recording`, `feedback-sse-migration`)
- Completed specs remain in the repository as documentation of past decisions
- Abandoned specs should be deleted to avoid confusion

## Spec Quality Checklist

Before presenting a spec for approval, verify:

**Structure & Architecture**
- [ ] Files-to-modify and files-NOT-to-modify are explicit
- [ ] Risk assessment identifies at least one risk
- [ ] Alternatives section is filled in (at least one alternative considered)
- [ ] Design follows existing vertical slice architecture
- [ ] No implementation code in the spec documents
- [ ] Task dependencies form a valid DAG (no circular deps)

**Acceptance Criteria & Scenarios**
- [ ] All acceptance scenarios use a valid format — Gherkin (user-facing/goal-driven) OR Use Cases (system/technical flows) — or WHEN/THEN for purely internal/subtractive changes
- [ ] Gherkin: every Feature block has at least one happy-path scenario and one error/edge-case scenario
- [ ] Gherkin: `Background` used for shared preconditions where 2+ scenarios repeat the same Given steps
- [ ] Gherkin: `Scenario Outline` used for parameterized variants instead of duplicated scenarios
- [ ] Use Cases: every Use Case has at least one Exception Flow (happy-path-only Use Cases are incomplete)
- [ ] Use Cases: Postconditions (Failure) stated, enforcing invariants (no partial writes, error logged)
- [ ] Actors identified in the Actors section for all features with user-facing or multi-agent interaction
- [ ] Adversarial coverage applied — Gherkin error Scenarios OR Use Case Exception Flows answer the 5 boundary questions (auth, validation, AI failure, race condition, resilience)

**Requirements Output Contract** — a requirements document is READY when ALL of the following are true:
1. Every Gherkin Feature has at least 2 Scenarios (1 happy path, 1 error); every Use Case has a Main Success Scenario + at least 1 Exception Flow
2. Every Gherkin Scenario has exactly one `When` step (single trigger, not compound); every Use Case has a single Trigger
3. No Gherkin Scenario exceeds 7 steps; no Use Case Main Success Scenario exceeds 10 steps
4. All actors referenced in scenarios or use cases appear in the Actors section
5. NFRs have numeric or boolean targets — no adjectives without a threshold
