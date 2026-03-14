# Learnings Entry Format Reference

## Entry Structure

Every entry in `.ai/learnings.md` must follow this exact format:

```markdown
### [YYYY-MM-DD] Short descriptive title
- **Context**: What task or situation triggered this
- **Finding**: The specific insight discovered
- **Impact**: What to do differently going forward
- **Category**: architecture | pitfall | external-api | performance | pattern | convention
```

### Field Rules

| Field | Required | Constraints |
|-------|----------|-------------|
| Date | Yes | ISO format `YYYY-MM-DD` |
| Title | Yes | Max 80 characters, descriptive, no generic titles |
| Context | Yes | Reference the task or situation specifically |
| Finding | Yes | One concrete insight per entry |
| Impact | Yes | Must be actionable — "do X" or "avoid Y" |
| Category | Yes | Must be one of the six defined categories |

## Good Entry Examples

### Example 1: Convention Clarification

```markdown
### [2026-02-15] Feature exception conversion must happen in routes, not services
- **Context**: Coach feature implementation — service was raising HTTPException directly
- **Finding**: Feature-specific exceptions (e.g., `CoachSessionNotFoundError`) must be caught in API routes and converted to shared exceptions (`NotFoundError`). Services should raise feature-specific exceptions only.
- **Impact**: When writing service code, always raise feature-specific exceptions. In routes, wrap service calls with try/except that converts to shared exceptions.
- **Category**: convention
```

### Example 2: External API Quirk

```markdown
### [2026-02-20] OpenAI Realtime API silently drops audio chunks over 15MB
- **Context**: Interview session audio streaming — users reported truncated responses
- **Finding**: The OpenAI Realtime API does not return an error when audio input exceeds ~15MB per chunk. It silently truncates. The session appears to continue normally but the AI response quality degrades.
- **Impact**: Always chunk audio input to stay under 10MB per segment. Add a size check before sending to the API.
- **Category**: external-api
```

### Example 3: Architecture Decision

```markdown
### [2026-03-01] Use SSE instead of polling for async job status
- **Context**: Feedback generation migration from polling to SSE
- **Finding**: Server-Sent Events provide real-time progress updates without the overhead of polling intervals. The existing job infrastructure supports SSE via the `StreamingResponse` pattern already used in other features.
- **Impact**: For new async operations that need progress updates, prefer SSE over polling. Use the existing `StreamingResponse` + job status pattern.
- **Category**: architecture
```

### Example 4: Common Pitfall

```markdown
### [2026-03-02] Missing await on async repository calls causes silent data loss
- **Context**: Coach test session — scores were intermittently not persisted
- **Finding**: Calling an async repository method without `await` returns a coroutine object that is silently discarded. No error is raised, but the database operation never executes.
- **Impact**: Always verify async/await usage in service methods, especially when calling repository save/update operations. The ruff linter does not catch missing awaits on coroutines.
- **Category**: pitfall
```

## Bad Entry Examples

### Bad: Too vague

```markdown
### [2026-03-01] Testing lesson
- **Context**: Working on tests
- **Finding**: Tests are important
- **Impact**: Write more tests
- **Category**: pattern
```

**Why it's bad:** No specific context, finding is not an insight, impact is not actionable.

### Bad: Duplicates existing rules

```markdown
### [2026-03-01] Use one class per file
- **Context**: Code review
- **Finding**: Each class should be in its own file
- **Impact**: Create separate files for each class
- **Category**: convention
```

**Why it's bad:** This is already documented in AGENTS.md and multiple skills. A learnings entry should add new insight, not restate known rules.

### Bad: Too granular

```markdown
### [2026-03-01] Fixed typo in feedback_service.py line 42
- **Context**: Bug fix
- **Finding**: Variable name was misspelled
- **Impact**: Check spelling
- **Category**: pitfall
```

**Why it's bad:** This is a task-specific fix with no broader lesson. Does not help future tasks.

## Consolidation Guidance

When `.ai/learnings.md` grows beyond ~200 entries:

1. Group related entries under the same category
2. Merge entries that describe the same pattern from different perspectives
3. Promote frequently referenced entries to project rules (AGENTS.md or .cursor/rules/)
4. Archive promoted entries with a note: "Promoted to {file} on {date}"
5. Remove entries that are no longer relevant due to codebase changes
