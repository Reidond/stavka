---
name: commit-message
description: >
  Generate concise, conventional commit messages that focus on "why" rather than "what".
  Analyzes staged changes, detects the change type, and produces a message following the
  project's existing commit style. Use when the user asks to commit, create a commit
  message, or when finalizing a task that requires a commit.
---

# Commit Message — Generate Conventional Commit Messages

## When This Skill Activates

- The user asks to commit changes or create a commit message
- A task is complete and the user requests a commit
- The user says "commit", "create commit", "commit message", or similar

## Message Generation Process

### Step 1: Analyze the Changes

Run `git diff --staged` (or `git diff` if nothing is staged) to understand:

- What files were modified, added, or removed
- The nature of the change (new feature, bug fix, refactor, docs, test, chore)
- The scope — which feature or module is primarily affected

### Step 2: Check Existing Conventions

Run `git log --oneline -10` to see the project's recent commit style.
Match the existing pattern (prefix style, capitalization, length).

### Step 3: Classify the Change Type

| Type | When to Use |
|------|-------------|
| `feat` | Wholly new feature or capability |
| `fix` | Bug fix (something was broken, now it works) |
| `refactor` | Code restructuring without behavior change |
| `docs` | Documentation-only changes |
| `test` | Adding or updating tests |
| `chore` | Maintenance, dependencies, CI/CD, tooling |
| `style` | Code formatting, whitespace (no logic changes) |
| `perf` | Performance improvement |

**Accuracy matters:** `feat` means genuinely new, not an update. `fix` means a real bug,
not a refactor. `refactor` means no behavior change. When in doubt, prefer the more
specific type.

### Step 4: Determine Scope (Optional)

If the change is scoped to a single feature or module, add it in parentheses:

- `feat(coach):` — Coach feature changes
- `fix(auth):` — Authentication bug fix
- `refactor(storage):` — Storage layer restructuring
- `docs(onboarding):` — Onboarding documentation

Omit scope for cross-cutting changes that touch multiple areas equally.

### Step 5: Write the Subject Line

**Format:** `type(scope): description`

**Rules:**
- Imperative mood: "Add", "Fix", "Refactor" (not "Added", "Fixes", "Refactored")
- Max 50 characters (hard limit 72)
- No trailing period
- Lowercase first word after the type prefix
- Complete the sentence: "When applied, this commit will..."

### Step 6: Decide If a Body Is Needed

**Subject-only** (most commits):
- Simple changes with obvious intent
- Single-concern modifications
- Renames, typo fixes, formatting

**Subject + body** (complex commits):
- Architectural decisions or trade-offs
- Breaking changes
- Non-obvious approach that needs justification
- Changes with known limitations

**Body rules:**
- Blank line between subject and body
- Wrap at 72 characters
- Explain **why**, not what — the diff shows the what
- 2–4 sentences maximum

### Step 7: Add Footer (When Applicable)

- `Fixes #123` — Link to issue being fixed
- `BREAKING CHANGE: description` — Breaking changes
- `Co-authored-by: Name <email>` — Only if explicitly required by project

## What to NEVER Include

- File listings ("Modified auth.py, session.py, test_auth.py")
- Line-by-line narration ("Updated function X to call Y")
- Obvious information readable from the diff
- AI attribution unless the project explicitly requires it
- Temporary context (preview URLs, WIP notes)
- Emoji prefixes unless the project already uses them

## Length Calibration

| Change Size | Format | Subject Length |
|-------------|--------|---------------|
| Trivial (typo, format) | Subject only | ~30–40 chars |
| Standard (fix, small feat) | Subject only | ~40–50 chars |
| Complex (multi-file refactor) | Subject + 2–4 line body | ~40–50 chars |

## Examples

**Good — simple fix:**
```
fix(auth): prevent session fixation on login
```

**Good — new feature:**
```
feat(coach): add voice test audio upload pipeline
```

**Good — refactor with body:**
```
refactor(storage): extract repository base class

Consolidate shared query patterns (get_by_id, create, soft_delete) into
a generic base repository. Reduces duplication across 6 feature repos.
```

**Bad — too verbose, lists files:**
```
fix: update auth.py and session.py to fix login bug

Modified the login function in auth.py to call regenerate_session().
Also updated session.py to add the regenerate_session method.
Updated tests in test_auth.py to cover the new behavior.
```

**Bad — vague:**
```
chore: update code
```

## Commit Execution

When creating the actual commit, always use a HEREDOC for proper formatting:

```bash
git commit -m "$(cat <<'EOF'
type(scope): subject line here

Optional body explaining why, wrapped at 72 characters.

Optional-footer: value
EOF
)"
```
