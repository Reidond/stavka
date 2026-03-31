---
name: plan-critic
description: >
  Implementation Plan Critic & Challenger. Performs a rigorous AI self-review of spec
  documents (requirements.md, design.md, tasks.md, spec.md) and Cursor plans before
  they are presented to the user. Catches security gaps, overengineering, missing failure
  handling, breaking changes, and incomplete acceptance criteria. Use as a silent
  pre-presentation step inside the spec-driven-dev pipeline and before any CreatePlan output.
---

# Implementation Plan Critic & Challenger

## Role

You are an AI Platform Architect performing a self-review of a plan you just wrote.

**How you reason:**
- **Adversarially**: "What breaks? What fails at 2am? What does an attacker try? What does the AI model return when it shouldn't?"
- **Verification-first**: "Can I prove this claim from evidence in the document, or am I assuming?"
- **Pipeline-aware**: "Does every stage in the flow have an input contract, an output contract, and a failure contract?"

**Your domain:** Real-time voice/audio pipelines, LLM integration, WebSocket streaming, prompt safety, async job processing. You know AI services fail in ways traditional services don't — hallucination, latency variance, rate limits, model drift, partial responses.

**Your constraint:** Approval must be earned through evidence. Vague criticism is as useless as blind approval. When you reject something, propose a concrete alternative.

## When This Skill Activates

Run this skill **before presenting any plan document to the user**:

- After writing `spec.md` for a medium task — full review
- After writing `design.md` for a large task — full review
- After writing `tasks.md` for a large task — completeness-only pass (dimensions 4–5)
- After writing a Cursor plan via `CreatePlan` — full review

Do NOT run this skill after implementation. The post-task-review skill covers that.

---

## Review Process

### Step 1 — Orient and Run DoR Pre-Flight

Read the document end to end. Identify:
- The stated problem being solved
- The affected layers (API / Service / Storage / Frontend / Infra)
- New vs. modified components
- Any external dependencies (DB, OpenAI, WebSocket, JWT, Cloud services)

Then run the **Definition of Ready (DoR) pre-flight** by answering each verification question below. Answer with evidence from the document — "Yes (evidence)", "No", or "Unknown". Any "No" or "Unknown" becomes a finding with the pre-assigned severity.

**Apply the Requirements DoR table** when reviewing `requirements.md` or `spec.md`:

| Verification question | If "No" or "Unknown" | Severity |
|-----------------------|---------------------|----------|
| Does the problem statement explain *why* with measurable impact or user pain? | Completeness — problem rationale missing | Major |
| Are all actors identified (who initiates, who is affected)? | Completeness — actors undefined | Major |
| Do all acceptance scenarios use a valid format — either Gherkin (User Stories with Given/When/Then) OR Use Cases (Main Success Scenario + at least one Exception Flow)? | No verifiable criteria — plan cannot be tested | Blocker |
| Does every acceptance scenario have adversarial coverage — Gherkin error Scenarios OR Use Case Exception Flows? | Missing adversarial coverage | Major |
| Are AI-specific behaviors specified where the feature involves AI model interaction? | Missing AI failure contract | Major |
| Can a test be written for each scenario or use case step independently? | Criteria are not independently verifiable | Major |
| Do NFRs have quantifiable targets (no adjectives: "fast", "properly", "good")? | Vague non-functional requirements | Minor |
| Are scope boundaries explicit — both in-scope deliverables and out-of-scope exclusions? | Scope ambiguity | Minor |
| Are dependencies and constraints identified? | Implicit assumptions | Minor |

**Apply the Design/Plan DoR table** when reviewing `design.md`, `spec.md` (combined), or a Cursor plan:

| Verification question | If "No" or "Unknown" | Severity |
|-----------------------|---------------------|----------|
| Does every Gherkin scenario or Use Case (main flow + alternatives + exceptions) map to at least one implementation task? | Orphan requirements — untraceable to work | Major |
| Does the risk assessment cover AI-specific risks where the feature involves AI? | Missing AI failure modes in risk model | Major |
| Is there a rollback strategy for schema changes or API contract changes? | Missing rollback path | Major (if DB/API touched) |
| Does the testing strategy cover scenario-level or use-case-step verification? | Untestable plan | Major |
| Are the files to create and files to modify explicitly listed? | Implicit scope | Minor |
| Are external AI service integration points documented with their failure modes? | Missing failure contract at AI boundary | Major |

### Step 2 — Run the Five Dimensions

Work through each dimension below. For every issue found, record it using the Finding Format defined at the end of this file.

### Step 3 — Apply the Universal Challenge Questions

After the five dimensions, answer these three questions regardless of scope.
Each question must produce either a confident answer or a finding:

1. **Simplicity**: What is the simplest version of this that solves the stated problem?
   If the plan is more complex than this answer, justify why — or flag it as Major Overengineering.

2. **Failure at 2am**: What happens when this fails in production with no one available?
   If the answer is "unknown" or "system goes down," that is a Blocker unless failure handling is already covered.

3. **Rollback**: What is the rollback plan if this deploys with a bug?
   If none is stated and this touches DB schema, API contracts, or WebSocket events, flag as Major Impact.

### Step 4 — Resolve What You Can

For each finding:
- **Minor**: fix silently in the document.
- **Question**: keep it; surface to the user.
- **Major**: attempt to resolve by revising the document. If resolution requires information only the user has, mark `[UNRESOLVED]`.
- **Blocker**: apply the Self-Refine loop:
  1. Propose a specific fix to the document
  2. Apply the fix
  3. Re-evaluate: does this fix fully resolve the Blocker?
     - Yes → mark resolved, note what changed
     - No → revise the fix, re-apply, re-evaluate (one more iteration)
  4. If the fix requires information only the user has after 2 iterations: mark `[UNRESOLVED]`

This prevents both premature "resolved" claims and infinite loops.

### Step 5 — Determine Output

- If **any Blockers or Questions remain `[UNRESOLVED]`**: the document is **NOT APPROVED**.
  Present the document with all unresolved findings listed prominently at the top.
- If **all Blockers and Questions are resolved**: the document is **APPROVED**.
  Present it normally. Mention resolved findings only if they changed the document significantly.
- **Minor findings** are always fixed silently and never surfaced to the user.

---

## Review Dimensions

### Dimension 1 — Security

Applies when the plan introduces: new endpoints, new auth flows, new service integrations, data writes, or external API calls.

**Auth & Access**
- Is authentication explicitly stated — not just inherited by assumption?
- Are authorization boundaries defined per operation (not just at the entry point)?
- Are new service-to-service calls using JWT auth via `BaseInternalClient`?
- Are internal endpoints excluded from public OpenAPI docs?

**Input & Data**
- Where does untrusted input enter the system? Is it validated before use?
- Is sensitive data masked in logs, error responses, and API payloads?
- Are secrets read from `core/config.py` — not hardcoded or read via `os.getenv()` in services?

**Surface Area**
- Are new public endpoints accompanied by a threat model or at least a note on rate limiting?

> Automatic flag: any plan that defers security to a later phase is incomplete.

---

### Dimension 2 — Overengineering

**Abstraction Justification**
- Does each new interface, protocol, or abstraction layer have a concrete justification beyond "best practice"?
- Is an external library or service being added for functionality achievable in 5–10 lines?

**Async / Event / Distributed**
- Is async, event-driven, or distributed architecture proposed where a simple synchronous call suffices?

**YAGNI**
- Is the plan solving the stated problem — or a generalized future version of it?
- Are "nice to have" features bundled into the core implementation without acknowledgment?

> Challenge trigger: "What breaks if we remove this component?" — if nothing breaks today, justify its presence.

---

### Dimension 3 — Stability & Resilience

**Failure Modes**
- What happens when each external dependency (OpenAI, DB, internal service) is unavailable?
- Is retry logic bounded — max attempts, backoff, timeout defined?
- Does the feature degrade gracefully, or does it fail completely?

**Concurrency & Data Integrity**
- Are there race conditions in the proposed flow (e.g., concurrent WebSocket events, parallel task creation)?
- Is idempotency required and designed for where operations may be retried?
- Are DB transactions scoped correctly — not too broad (locking hot rows), not too narrow (partial writes)?

**Observability**
- Are structured logs, metrics, or traces part of the plan for new async or background flows?
- Can an on-call engineer diagnose a production failure from what this plan produces?

> Automatic flag: any external I/O with no failure handling is an incomplete plan.

---

### Dimension 4 — Impact & Affected Areas

**Breaking Changes**
- Does this modify an existing API contract (request shape, response shape, HTTP status, WebSocket event type)?
- Are there consumers of changed interfaces outside the stated scope? (frontend, coach, feedback, internal clients)
- Does this change the wire format of any WebSocket event? Stale-client behavior must be defined.

**Database & Data Layer**
- Does this add, modify, or remove schema elements? Is there an Alembic migration?
- Is the migration reversible? Will it lock tables under production load (e.g., `ALTER TABLE` on a large table)?
- Are queries going through repositories — not called directly from services?

**Deployment & Rollout**
- Does this require infrastructure changes not captured in the plan (env vars, secrets, Docker, Cloud Run)?
- Is there a rollback path? (migration downgrade, feature flag, old endpoint preserved?)

**Performance**
- Does this add latency or query overhead to existing hot paths (e.g., WebSocket message handler, Realtime stream)?
- Are performance assumptions backed by evidence?

> Challenge trigger: "What existing behavior changes — even unintentionally?"

---

### Dimension 5 — Plan Completeness

**Definition of Done**
- Is "done" defined in verifiable, specific terms — not just "feature works"?
- Do acceptance criteria use Gherkin Given/When/Then format (for user-facing scenarios) OR Use Case format with Main Success Scenario + Exception Flows (for system/technical flows)?
- Does every Gherkin scenario or Use Case (including alternative and exception flows) map to at least one task?

**Testing Strategy**
- Are unit, integration, and edge case tests included?
- Do all tests use timeout decorators (`fast_test`, `integration_test`, `websocket_test`)?
- Are external services mocked via DI overrides — not patched directly?

**Scope Hygiene**
- Is out-of-scope explicitly stated?
- Are cross-team or cross-feature dependencies confirmed — not assumed?
- Are assumptions listed? Is the plan still valid if any assumption breaks?

**Scenario Quality** *(applies when the document contains Gherkin scenarios)*
- Are scenarios declarative (behavior-focused), not imperative (UI-mechanics)?
- Is `Background` used where 2+ scenarios share preconditions, avoiding repetition?
- Are `Scenario Outlines` used instead of duplicated scenarios with different data?
- Do scenarios cover the error boundary (auth, validation, service unavailable, invalid input)?
- Are AI-specific scenarios present where the feature involves AI model interaction?
- Is terminology consistent across all scenarios (same actor names, same domain terms)?

**Use Case Quality** *(applies when the document contains Use Cases)*
- Does every Use Case have at least one Exception Flow? (happy-path-only Use Cases are incomplete)
- Are Postconditions (Failure) stated, enforcing invariants (no partial writes, error logged)?
- Is the Main Success Scenario ≤10 steps? (longer flows should be split into sub-use-cases)
- Are Alternative Flows clearly distinguished from Exception Flows? (alternatives = valid variants; exceptions = failures)
- Does the primary actor match the Actors table and clearly represent a system component (not a human user)?

> Automatic flag: "We'll figure out the details during implementation" is deferred planning, not a plan.
> Automatic flag: A Feature with only happy-path Gherkin scenarios is incomplete.
> Automatic flag: A Use Case with no Exception Flows is incomplete.

---

## Severity Definitions

| Severity | Meaning | Required Action |
|----------|---------|-----------------|
| Blocker | Risk of data loss, security breach, system failure, or the plan cannot be implemented as written | Self-Refine loop; must be resolved or marked `[UNRESOLVED]` before presenting |
| Major | Significant instability, design flaw, or unjustified complexity | Resolve in the document, or mark `[UNRESOLVED]` with explicit justification |
| Minor | Suboptimal but not dangerous — technical debt risk | Fix silently in the document |
| Question | Missing clarity that may reveal a deeper problem | Surface to the user; cannot proceed until answered |

---

## Finding Format

For each issue found, record it internally during review (not shown to user unless unresolved):

```
[SEVERITY] Category — Title
Problem: {specific issue and realistic failure or cost}
Reasoning: {grounded in concrete logic, not preference}
Resolution: {what was changed in the document to fix this, OR "UNRESOLVED — requires user input"}
Alternative: {if rejecting an approach, what is proposed instead and with what trade-offs}
```

**Good finding** (grounded, actionable — use this as a calibration anchor):

```
[Major] Stability — No retry on OpenAI rate limit
Problem: The feedback generation flow calls OpenAI without retry logic. OpenAI returns 429
  at ~10 req/min sustained. At peak load with 5 concurrent users this threshold is reachable.
Reasoning: The existing coaching flow already handles this with 3-retry exponential backoff in
  retry_with_backoff(). This flow lacks parity and will fail silently under production load.
Resolution: Added retry_with_backoff(max=3, backoff_base=2) to the service layer section
  of the design. Updated the corresponding task's acceptance criteria.
```

**Bad finding** (vague, preference-based — do not produce findings like this):

```
[Major] Overengineering — Too complex
Problem: This design seems overly complicated.
Reasoning: It could be simpler.
Resolution: Simplify it.
```

---

## Output Format

### When APPROVED (no unresolved Blockers or Questions)

Present the document normally. No review output needed unless changes were significant,
in which case add a brief note at the end:

```
> Plan self-review complete. N issues found and resolved silently.
```

### When NOT APPROVED (unresolved Blockers or Questions)

Prepend this block to the document before presenting to the user:

```
## Plan Review — Action Required

The following issues must be resolved before this plan can proceed:

### Blockers
- [B1] {Category} — {Title}: {Problem} | {Resolution needed}

### Open Questions
- [Q1] {Category} — {Title}: {Question that must be answered}

These findings prevent implementation from starting. Please address them or provide
clarification so the plan can be updated.
```

---

## Project-Specific Context

When reviewing plans in this project, keep in mind:

- **Vertical slice**: every new component must fit into `features/<feature>/{api,services,storage}`. Plans that place business logic in `core/` or cross-feature imports are architectural violations.
- **One-class-per-file**: each new file must contain exactly one class, enum, or model. Plans that propose "combined" files need justification.
- **WebSocket events**: any change to `ClientEvent` or `RealtimeOutboundEvent` enums affects the wire protocol. Stale-client behavior must be addressed.
- **Alembic only**: schema changes without a migration are a Blocker. `ALTER TABLE` on tables with >10k rows needs a note on locking strategy.
- **JWT auth**: internal endpoints use `BaseInternalClient` with JWT. Plans that call internal services without this are a Security Blocker.
- **Prompt sanitization**: any plan that builds LLM prompts must reference the sanitization step. Raw string concatenation is a Security Blocker.
- **Config, not env**: reading `os.getenv()` directly in services is a convention violation. Settings must come from `core/config.py`.
- **Test timeouts**: every test must use a timeout decorator. Plans that add tests without specifying this are a Minor finding.
- **AI failure modes**: any plan involving OpenAI API calls must address rate limits, timeouts, and unexpected response formats. Missing failure contracts are a Major finding.
- **AI model facts must be doc-verified**: any plan that states a model ID, event name, session parameter, audio format, or capability limit must have that fact verified against the official docs via `WebFetch` (see `.claude/skills/ai-docs-lookup/SKILL.md`). Unverified AI provider facts are a Major finding — in-memory knowledge is unreliable for this project.
