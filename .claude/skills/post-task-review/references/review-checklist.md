# Post-Task Review Checklist

Quick-reference checklist for the 8-step review process. Use this to verify completeness.

## Steps 1–6: Code Review

### Step 1: High-Level Conceptual Review
- [ ] Solution aligns with original requirements
- [ ] Architecture is appropriate for the problem
- [ ] No obvious design flaws or anti-patterns
- [ ] Integrates well with existing system components
- [ ] No missing pieces that prevent end-to-end functionality

### Step 2: Detailed File-by-File Review
- [ ] Every function reviewed for correctness
- [ ] Input validation and error handling verified
- [ ] Return types and edge cases checked
- [ ] No potential null/None reference issues
- [ ] Proper resource cleanup (connections, files, sessions)
- [ ] No potential memory leaks or performance issues
- [ ] Async/await usage correct (no missing awaits)

### Step 3: Convention Compliance
- [ ] Imports: global at top, proper grouping, no unused
- [ ] One class per file with matching snake_case name
- [ ] Feature structure: correct placement in api/, services/, storage/
- [ ] Logging: `setup_logger(__name__)`, proper levels, structured `extra={}`
- [ ] HTTP clients: correct base class, proper error handling
- [ ] Error handling: shared exceptions, not HTTPException for standard errors
- [ ] Feature exceptions converted to shared exceptions in routes
- [ ] Tests use timeout decorators

### Step 4: Self-Challenge
- [ ] "What could go wrong here?"
- [ ] "What if input is empty/null/malformed?"
- [ ] "Is there a race condition possible?"
- [ ] "What if the external service is unavailable?"
- [ ] "Did I handle all error cases?"
- [ ] "Am I using shared exceptions correctly?"
- [ ] "Is this the simplest solution that works?"

### Step 5: Fixes
- [ ] All identified issues fixed or explicitly justified
- [ ] Each fix has clear reasoning documented

### Step 6: Linting
- [ ] `read_lints` run on ALL modified files
- [ ] `ruff check --fix` run on all changed Python files
- [ ] All remaining issues resolved

## Step 7: Documentation Impact

- [ ] All modified files listed
- [ ] Doc impact matrix consulted for each modified path
- [ ] Each potentially affected doc read and evaluated
- [ ] Stale information corrected
- [ ] Missing information added
- [ ] Broken references fixed
- [ ] New feature has README.md if applicable
- [ ] Results reported (updated / no change needed)

## Step 8: Learnings Extraction

- [ ] Task reviewed for discoveries and surprises
- [ ] Review findings (steps 1–7) also considered as learnings
- [ ] Findings classified (project-level vs task-specific)
- [ ] Project-level findings appended to `.ai/learnings.md`
- [ ] Rules updated if convention gaps found
- [ ] Results reported (count + summary)

## Common Mistakes Caught in Past Reviews

These are recurring issues found during reviews — watch for them:

- Missing `await` on async repository calls (causes silent data loss)
- Using `HTTPException` instead of shared exceptions for 400/401/404
- Multiple classes in a single file (especially DTOs/schemas)
- Inline/local imports inside functions
- Missing error handling for external API calls (OpenAI, GCS)
- Tests without timeout decorators (`fast_test`, `integration_test`)
- Feature-specific exceptions not converted to shared exceptions in routes
- Logging without structured `extra={}` context
