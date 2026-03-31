---
name: post-task-review
description: >
  Comprehensive post-task review including code review, convention compliance, documentation
  impact analysis, and learnings extraction. Extends the existing task-completion-review
  process with two new mandatory steps. Use after completing any major task (3+ files
  modified, new feature, significant refactoring, or spec task completion).
---

# Post-Task Review — Comprehensive Completion Process

## When This Skill Activates

Run this review when any of these conditions are met:

- A new feature or significant functionality was implemented
- Refactoring touched 3 or more files
- A spec-driven development task was completed
- A bug fix revealed a systemic issue
- The human explicitly requests a review
- Any task that created or modified database migrations

## Review Pipeline

The review consists of 8 steps, executed in order. Steps 1–6 follow the existing process.
Steps 7–8 are extensions added by this skill.

### Steps 1–6: Code Review and Convention Compliance

Follow the existing task-completion-review process. The steps are:

1. **High-Level Conceptual Review** — Does the solution align with requirements? Any design flaws?
2. **Detailed File-by-File Review** — Check every function for correctness, edge cases, resource cleanup
3. **Project Conventions Review** — Imports, one-class-per-file, feature structure, logging, exceptions
4. **Self-Challenge** — Ask adversarial questions: "What could go wrong?", "What if input is empty?"
5. **Document Findings and Implement Fixes** — Fix each issue found with clear reasoning
6. **Run Linting and Diagnostics** — `ruff check --fix` on all modified files, `read_lints` on all modified files

### Step 7: Documentation Impact Analysis

After code review is complete, check whether any project documentation needs updating.

#### 7a. Identify Modified Files

List all files that were created, modified, or deleted during this task.

#### 7b. Consult the Documentation Impact Matrix

For each modified file, check [references/doc-impact-matrix.md](references/doc-impact-matrix.md) to
determine which documentation files might be affected.

#### 7c. Read and Evaluate Affected Docs

For each potentially affected documentation file:

1. Read the current content
2. Check for:
   - **Stale information** — Does the doc describe behavior that changed?
   - **Missing information** — Does the doc omit new functionality?
   - **Contradictions** — Does the doc contradict the current implementation?
   - **Broken references** — Do links or file paths still resolve?
3. If no issues found, move on

#### 7d. Update Documentation

For each doc that needs updating:

1. Update the content in-place to match the current implementation
2. Preserve the existing style and structure of the document
3. Do not create new documentation files unless the change warrants it (new feature README, new onboarding doc)
4. If a new feature was created, ensure it has a `README.md` in its feature directory

#### 7e. Report Results

In the review output, list:
- Which docs were checked
- Which docs were updated (and what changed)
- Which docs needed no changes

If no documentation was affected, explicitly state: "No documentation updates needed."

### Step 8: Learnings Extraction

After the full review is complete, extract and record learnings.

Invoke the `task-learnings` skill (`.claude/skills/task-learnings/SKILL.md`) to:

1. Review the entire task for discoveries, surprises, and corrections
2. Include findings from the review itself (steps 1–7) — if the review caught issues, those are learnings too
3. Classify findings as project-level or task-specific
4. Append project-level findings to `.ai/learnings.md`
5. Update project rules if any convention gaps were found

## Output Format

Present the review results using this structure:

```
## Post-Task Review

### 1. High-Level Assessment
{Summary of conceptual review findings}

### 2. Detailed Review Findings
{List of issues found with file:line references}

### 3. Convention Compliance
{Any violations of project conventions}

### 4. Self-Challenge Results
{Edge cases, race conditions, or other concerns identified}

### 5. Fixes Applied
{List of fixes implemented with reasoning}

### 6. Linting Results
{Summary of ruff and diagnostic results}

### 7. Documentation Impact
- **Docs checked**: {list}
- **Docs updated**: {list with brief description of changes}
- **No updates needed**: {list}

### 8. Learnings Extracted
- **Project-level findings recorded**: {count}
- **Rules updated**: {list of files updated, or "None"}
- **Summary**: {1-2 sentence summary of key learnings}
```

## Important Notes

- Do NOT skip any step, even if the implementation seems perfect
- Step 7 (docs) must read actual file content before deciding — never assume docs are up-to-date
- Step 8 (learnings) should capture findings from the review itself, not just the implementation
- Be thorough but efficient — focus on real issues, not nitpicks
- If no issues are found in a step, explicitly state "No issues found"
- Always run the linter as the final step of code review (step 6) before proceeding to docs

See [references/review-checklist.md](references/review-checklist.md) for a quick-reference checklist.
