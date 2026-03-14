---
name: task-learnings
description: >
  Extract and record project learnings after task completion. Captures architecture
  decisions, pitfalls, patterns, and convention gaps discovered during implementation.
  Automatically updates .ai/learnings.md and relevant project rules. Use after completing
  any coding task, bug fix, refactoring, or when the AI discovers something non-obvious
  about the project.
---

# Task Learnings — Extract and Record Project Knowledge

## When This Skill Activates

Run the learnings extraction process when any of these occur:

- A coding task, bug fix, or refactoring is completed
- A surprising or non-obvious behavior is discovered in the codebase
- The human corrects the AI's approach or assumption
- An external API or service behaves unexpectedly
- A pattern is discovered that could benefit future tasks
- A convention gap or ambiguity is identified

## Learnings Extraction Process

Follow these steps in order at the end of every qualifying task:

### Step 1: Review the Task

Look back at all changes made during the task:

- What files were created, modified, or deleted?
- What problems were encountered and how were they solved?
- Did the human provide any corrections or redirections?
- Were there any surprises in how the codebase behaved?
- Did any external service behave unexpectedly?

### Step 2: Identify Findings

For each potential finding, capture:

- **What happened**: The specific observation or discovery
- **Why it matters**: How it affects future work
- **What to do differently**: Actionable guidance for next time

### Step 3: Classify Each Finding

Use this decision tree to determine if a finding is project-level (worth recording) or task-specific (discard):

```
Is this finding specific to one file/function with no broader lesson?
  └─ YES → task-specific → discard
  └─ NO ↓

Would this help in a future task in a different feature?
  └─ YES → project-level → record it
  └─ NO ↓

Did the human correct the AI's approach or assumption?
  └─ YES → project-level → record it
  └─ NO ↓

Was an external API or service behavior surprising?
  └─ YES → project-level → record it
  └─ NO → task-specific → discard
```

### Step 4: Categorize Project-Level Findings

Assign each project-level finding to one of these categories:

| Category | What Belongs Here |
|----------|-------------------|
| **Architecture Decisions** | Structural choices, pattern selections, rationale for design |
| **Common Pitfalls** | Bugs that could recur, tricky edge cases, easy mistakes |
| **External Service Quirks** | OpenAI, GCS, PostgreSQL behaviors that aren't obvious |
| **Performance Insights** | Latency findings, optimization discoveries, scaling concerns |
| **Pattern Discoveries** | What worked well, reusable approaches, effective abstractions |
| **Convention Clarifications** | Ambiguous rules resolved, edge cases in conventions |

### Step 5: Write Entries to `.ai/learnings.md`

Append each finding to the appropriate category section using this format:

```markdown
### [YYYY-MM-DD] Short descriptive title
- **Context**: What task or situation triggered this
- **Finding**: The specific insight discovered
- **Impact**: What to do differently going forward
- **Category**: architecture | pitfall | external-api | performance | pattern | convention
```

See [references/learnings-format.md](references/learnings-format.md) for detailed format rules and examples.

### Step 6: Update Rules If Needed

If a finding reveals a gap in existing project rules:

| What Changed | Where to Update | How |
|-------------|-----------------|-----|
| New anti-pattern discovered | `AGENTS.md` "Do not" section | Append a new bullet |
| Convention ambiguity resolved | Relevant `.cursor/rules/*.md` | Add clarification |
| Skill instructions were insufficient | Relevant `.claude/skills/*/SKILL.md` | Extend instructions |
| New coding pattern to enforce | `AGENTS.md` conventions section | Append to relevant subsection |

**Rules for updating rules:**
- Always explain the rationale in the learnings entry first
- Only add to rules — never modify or remove existing rules without human approval
- Keep additions concise and consistent with the surrounding style
- If unsure whether something belongs in rules, record it in learnings only

## Quality Gates

A good learnings entry:
- Has a specific, descriptive title (not "miscellaneous finding")
- Includes concrete context (what task, what file, what happened)
- States an actionable impact (what to do differently)
- Does not duplicate information already in AGENTS.md or existing rules
- Is scannable — no narrative prose, use structured fields

A bad learnings entry:
- Is vague ("we learned something about testing")
- Has no actionable impact ("X is interesting")
- Duplicates an existing convention without adding new insight
- Is too granular ("line 42 of file X had a typo")
