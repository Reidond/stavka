# Requirements Writing Guide

## The Context / Input / Output Mental Model

Before writing any scenario, understand the fundamental mapping:

| Gherkin keyword | Meaning | In AI pipelines |
|-----------------|---------|-----------------|
| **Given** | Pre-existing state — what is true before the trigger | System context, data availability, session state, config (analogous to a system prompt context) |
| **When** | The single trigger or input event | API call, WebSocket message, user action, model response, timer (analogous to user input arriving at a pipeline stage) |
| **Then** | Observable outcome at a verifiable boundary | API response, WebSocket event, DB state change, log entry, SSE event (analogous to model output or system state change) |

This model makes Gherkin intuitive for AI system specifications: every pipeline stage can be expressed as "Given this system state, When this event arrives, Then this observable output appears."

---

## Gherkin Syntax Reference

### Basic scenario

```gherkin
Feature: {One capability area}

  Scenario: {Descriptive title — not "Test 1"}
    Given {system state or context}
    When {single action or event}
    Then {observable outcome}
    And {additional outcome}
```

### Background — shared preconditions

Use `Background` when 2 or more scenarios in a Feature share the same `Given` steps. Do not repeat setup in every scenario.

```gherkin
Feature: Feedback Generation

  Background:
    Given the user has a completed interview
    And the interview has audio transcripts available

  Scenario: Successful feedback generation
    When the user requests feedback for the interview
    Then the system returns 202 Accepted with a job_id

  Scenario: Unauthorized access
    Given the user does not own the interview
    When the user requests feedback for the interview
    Then the system returns 401 Unauthorized
```

The `Background` runs before every `Scenario` in the Feature. Additional `Given` steps in individual scenarios add to the background context — they do not replace it.

### Scenario Outline — parameterized variants

Use `Scenario Outline` with an `Examples` table instead of duplicating scenarios with different data values.

```gherkin
  Scenario Outline: AI service failure handling
    Given the OpenAI API returns a <error_code> status
    When the feedback generation job processes the request
    Then the system retries up to 3 times with exponential backoff
    And if all retries exhaust, the job fails with reason "<error_code>"

    Examples:
      | error_code |
      | 429        |
      | 500        |
      | 503        |
```

### And / But

`And` continues the same clause type as the preceding step. `But` signals a negative or contrasting condition.

```gherkin
    Then the system returns 202 Accepted
    And a job_id is included in the response body
    But the feedback payload is not yet included
```

---

## Actor Identification Protocol

Before writing any scenario, identify all actors involved. List them in the `Actors` section of the requirements template with their role in the feature.

**Common actors in this project:**

| Actor | When to include |
|-------|----------------|
| **User** | Any user-facing interaction — API calls initiated by the frontend |
| **AI Model** | When the feature calls OpenAI (Realtime API, Chat Completions, Whisper) |
| **System** | Background services, job runners, WebSocket connection manager, schedulers |
| **External Service** | Third-party APIs, Cloud Run, database (when it's a direct actor, not just storage) |
| **WebSocket Client** | Distinguish from User when specifying wire protocol behavior — the WS client is the frontend real-time consumer, not the human user |

**Identification questions:**
1. Who initiates the primary action? → that is your main actor
2. What other systems respond or are affected? → those are secondary actors
3. Is there an AI model in the flow? → include AI Model as an actor with its response contract
4. Is there a real-time channel (WebSocket, SSE)? → include WebSocket Client or SSE Consumer

Actors who appear in scenarios must appear in the Actors table. Actors in the Actors table who never appear in scenarios should be removed.

---

## Use Cases — Format and When to Use

### When to Choose Use Cases vs User Stories

Use the following rule to pick the right format for each feature area. Both formats may coexist in the same `requirements.md` for different concerns.

| Signal | Use User Stories + Gherkin | Use Use Cases |
|--------|---------------------------|---------------|
| Primary actor | Human user making a goal-driven decision | System component, job runner, timer, external API, or service |
| Flow structure | Simple: one trigger, one or two outcomes | Complex: multiple sequential steps with branching |
| Alternative paths | None or one | Several distinct alternatives |
| Failure handling | One `Scenario:` per error type | Structured Exception Flows with step references |
| Typical examples in this project | User requests feedback, user starts interview, coach views session | Feedback job execution, audio chunk processing, WebSocket reconnect, prompt sanitization, JWT validation |

**Decision shortcut:**
> Can you write "As a [actor], I want [goal]…" and mean it? → User Story.
> Is the subject "the system" or "the job runner" or "the service"? → Use Case.

### Use Case Format Reference

```markdown
### UC-{ID}: {Name}

| Field | Value |
|-------|-------|
| **Primary Actor** | {System / service / external API / timer that initiates} |
| **Secondary Actors** | {Other participants, or "None"} |
| **Preconditions** | {What must be true before this use case can run} |
| **Postconditions (Success)** | {Guaranteed state after successful completion} |
| **Postconditions (Failure)** | {Guaranteed state after failure — no partial writes, error logged, etc.} |
| **Trigger** | {Event or condition that initiates this use case} |

**Main Success Scenario:**
1. {Primary actor} {initiating action}
2. System {validates / processes / stores}
3. ...

**Alternative Flows:**
- **A1 — {Condition}**: At step {N}, if {condition}: {steps}. Resume at step {M} / ends successfully.

**Exception Flows:**
- **E1 — {Error}**: At step {N}, if {error}: {handling steps}. Use case ends with failure; {postcondition enforced}.
```

**Element guide:**

| Element | Purpose | Notes |
|---------|---------|-------|
| **Primary Actor** | Initiates the use case | Must match an entry in the Actors table |
| **Secondary Actors** | Participate but don't initiate | Include AI Model, DB, external services when they are active participants |
| **Preconditions** | System state required before execution | These are system-level facts, not per-step setup — equivalent to a Gherkin `Background` |
| **Postconditions (Success)** | State guaranteed after happy-path completion | What is observable and verifiable |
| **Postconditions (Failure)** | State guaranteed even after failure | Enforces invariants: no partial writes, DB rolled back, error logged with reason |
| **Trigger** | The event that starts the use case | API call, WebSocket message, cron timer, job queue dequeue, external webhook |
| **Main Success Scenario** | Numbered steps of the nominal uninterrupted flow | Max 10 steps; split longer flows into sub-use-cases (UC-{ID}.{sub}) |
| **Alternative Flows** | Valid variants that deviate and return | Cache hit, retry success, optional field present — not errors |
| **Exception Flows** | Failure conditions with error handling | Required: ≥1 per Use Case. These replace the adversarial 5-question protocol |

### Project-Specific Example

```markdown
### UC-01: Execute Feedback Generation Job

| Field | Value |
|-------|-------|
| **Primary Actor** | Job Runner (async background worker) |
| **Secondary Actors** | OpenAI Chat Completions API, Feedback Repository, SSE Connection Manager |
| **Preconditions** | A feedback generation job exists in the queue with status "pending"; the associated interview has audio transcripts stored |
| **Postconditions (Success)** | Job status is "completed"; feedback payload is persisted; SSE stream emits "complete" event to the waiting client |
| **Postconditions (Failure)** | Job status is "failed" with reason recorded; no partial feedback persisted; SSE stream emits "failed" event; original transcripts unchanged |
| **Trigger** | Job runner dequeues a feedback generation job |

**Main Success Scenario:**
1. Job Runner dequeues the job and marks status as "processing"
2. Job Runner retrieves interview transcripts from Feedback Repository
3. Job Runner constructs the feedback prompt using sanitized transcript content
4. Job Runner submits the prompt to OpenAI Chat Completions API
5. OpenAI returns a structured feedback response
6. Job Runner validates the response schema
7. Feedback Repository persists the feedback payload
8. Job Runner marks job status as "completed"
9. SSE Connection Manager emits a "complete" event with the feedback payload to the subscribed client

**Alternative Flows:**
- **A1 — Rate limit with successful retry**: At step 4, if OpenAI returns HTTP 429: Job Runner waits with exponential backoff and retries up to 3 times. If retry succeeds, resume at step 5.
- **A2 — Client disconnected before completion**: At step 9, if no active SSE connection exists for this job: Job Runner skips SSE emission. Job status remains "completed"; client retrieves result via polling on reconnect.

**Exception Flows:**
- **E1 — All retries exhausted**: At step 4, if all 3 retry attempts return 429 or 5xx: Job Runner marks job as "failed" with reason "rate_limit_exhausted". No feedback persisted. SSE emits "failed" event. Postcondition (Failure) enforced.
- **E2 — Unexpected response format**: At step 6, if the OpenAI response does not match the expected schema: Job Runner logs the raw response for debugging, marks job as "failed" with reason "unexpected_model_output". No partial data persisted. Postcondition (Failure) enforced.
- **E3 — Transcript unavailable**: At step 2, if transcripts are missing or empty: Job Runner marks job as "failed" with reason "missing_transcripts". Use case ends immediately; no API call made.
```

### Exception Flows = Adversarial Coverage for Use Cases

When writing Use Cases, Exception Flows serve the same purpose as the adversarial 5-question protocol used for Gherkin scenarios. Use the same 5 boundary questions to identify required Exception Flows:

| Adversarial question | Maps to |
|---------------------|---------|
| What if the actor is not authorized? | E: auth check fails at step N |
| What if the input is malformed or empty? | E: validation fails at step N |
| What if the AI model is unavailable, slow, or returns unexpected output? | E: API error, timeout, or schema mismatch at step N |
| What if a concurrent request hits the same resource? | E: idempotency check fails / conflict at step N |
| What if the connection drops mid-operation? | E: client disconnected / stream interrupted at step N |

A Use Case with no Exception Flows is incomplete — it only describes what happens when nothing goes wrong.

### Anti-Patterns

**Use Case where the main actor is a human — use a User Story instead**

```
# Wrong
UC-01: User Requests Feedback
Primary Actor: User
Main Success Scenario:
  1. User navigates to the interview results page
  2. User clicks "Generate Feedback"
  ...

# Right — this is a User Story
Story: As a user, I want to request feedback for my interview so that I can improve.
Feature: Feedback Request
  Scenario: Successful feedback request
    When the user requests feedback for their interview
    Then the system returns 202 Accepted with a job_id
```

**Use Case with no Exception Flows — always incomplete**

```
# Wrong — happy path only
UC-01: Execute Feedback Generation Job
...
Main Success Scenario: [steps 1–9]
Exception Flows: (none)

# Right — at least one exception required
Exception Flows:
- E1 — API unavailable: At step 4, if OpenAI is unreachable: job fails with reason "service_unavailable". No feedback persisted.
```

**Overly long Main Success Scenario — split into sub-use-cases**

```
# Wrong — 15+ steps in one use case
UC-01: Process Interview Session
Main Success Scenario:
  1. WebSocket client connects
  2. Session initialized
  3. JWT validated
  ...
  15. Session closed

# Right — split into focused use cases
UC-01: Establish WebSocket Session (steps 1–4)
UC-02: Process Conversation Turn (steps 5–10)
UC-03: Close Session and Finalize Transcript (steps 11–14)
```

### Mixing Both Formats in One Document

A single `requirements.md` can and should use the right format for each feature area:

```markdown
## Acceptance Scenarios

### Story: As a user, I want to request feedback...   ← Gherkin (human actor, simple flow)
[Gherkin Feature block]

### UC-01: Execute Feedback Generation Job            ← Use Case (system actor, complex flow)
[Use Case table and steps]

### Story: As a coach, I want to view session history...  ← Gherkin (human actor)
[Gherkin Feature block]

### UC-02: Reconnect Dropped WebSocket Session        ← Use Case (system actor, branching)
[Use Case table and steps]
```

---

## Adversarial Scenario Generation Protocol

After writing happy-path scenarios, run this protocol for **every Feature block**. It forces adversarial coverage and prevents requirements that only describe success.

Answer each question. A non-trivial answer becomes a Scenario. "N/A — this feature has no {boundary}" is an acceptable skip.

| # | Question | Boundary type | Gherkin pattern |
|---|----------|--------------|-----------------|
| 1 | What if the actor is not authorized to perform this action? | Auth | `Given the user does not own {resource}` / `Then the system returns 401` |
| 2 | What if the input is malformed, missing, or empty? | Validation | `Given the request body is missing {field}` / `Then the system returns 400` |
| 3 | What if the AI model is unavailable, returns an unexpected format, or exceeds latency? | AI failure | `Given the OpenAI API is unavailable` / `Then the system {degrades gracefully / fails with reason}` |
| 4 | What if a concurrent request hits the same resource before this one completes? | Race condition | `Given a concurrent {action} is in progress` / `Then the system {rejects / queues / handles idempotently}` |
| 5 | What if the connection drops mid-operation? | Resilience | `Given the WebSocket connection drops during {operation}` / `Then the system {recovers / cleans up / surfaces error}` |

**Example application** for a Feedback Generation feature:
1. Auth → user requests feedback for another user's interview → 401 scenario ✓
2. Validation → request body missing `interview_id` → 400 scenario ✓
3. AI failure → OpenAI rate limit (429) → retry + eventual failure scenario ✓
4. Race condition → two feedback requests for the same interview → 409 or idempotent handling scenario ✓
5. Resilience → SSE stream drops before completion → client reconnect or job status polling ✓

---

## AI Pipeline Scenario Patterns

> **Doc-first rule**: Before writing scenarios that reference specific model IDs, event names,
> audio formats, session parameters, or API capabilities, fetch the official documentation
> using `WebFetch`. See `.claude/skills/ai-docs-lookup/SKILL.md` and the source table in
> `AGENTS.md`. Do not rely on in-memory knowledge for provider-specific facts.

Reusable copy-and-adapt Gherkin patterns for common AI pipeline behaviors in this project.

### Model response — success and failure variants

```gherkin
  Scenario: Successful model response
    Given the OpenAI API is available
    When the {feature} job submits the prompt
    Then the model returns a valid structured response
    And the response is stored and surfaced to the user

  Scenario Outline: Model error with retry
    Given the OpenAI API returns HTTP <status>
    When the {feature} job processes the request
    Then the system retries up to 3 times with exponential backoff
    And if all retries exhaust, the job fails with status "failed" and reason "<reason>"

    Examples:
      | status | reason       |
      | 429    | rate_limit   |
      | 500    | server_error |
      | 503    | unavailable  |

  Scenario: Model response timeout
    Given the OpenAI API does not respond within 30 seconds
    When the {feature} job is waiting for a response
    Then the system cancels the request and marks the job as failed
    And the failure reason is "timeout"
```

### Streaming — SSE or WebSocket audio

```gherkin
  Scenario: Nominal SSE stream
    When the client opens the SSE stream for job {job_id}
    Then the stream emits "processing" events while the job runs
    And the stream emits a "complete" event with the payload when the job finishes
    And the stream closes after the "complete" event

  Scenario: SSE stream for failed job
    Given the job has failed with reason "rate_limit"
    When the client opens the SSE stream for that job
    Then the stream emits a "failed" event with the failure reason
    And the stream closes immediately after

  Scenario: WebSocket audio stream — interruption handling
    Given an AI audio response is streaming to the client
    When the user sends a barge-in event
    Then the system cancels the current audio stream
    And the remaining buffered audio chunks are discarded
    And the session transitions to listening state
```

### Prompt safety

```gherkin
  Scenario: Prompt injection attempt in user input
    Given the user input contains a prompt injection string
    When the system constructs the prompt for the AI model
    Then the injection string is sanitized before inclusion
    And the model receives only the sanitized prompt

  Scenario: Unexpected model output format
    Given the AI model returns a response that does not match the expected schema
    When the service attempts to parse the model response
    Then the parsing error is caught and logged with the raw response
    And the job fails with reason "unexpected_model_output"
    And no partial or malformed data is persisted
```

### Graceful degradation

```gherkin
  Scenario: AI service circuit open — fallback
    Given the AI service circuit breaker is open due to repeated failures
    When a user requests {AI-powered feature}
    Then the system returns 503 with a user-friendly error message
    And the request is not forwarded to the AI service
    And the failure is logged for monitoring
```

---

## Declarative Style Rules

Gherkin scenarios must describe **behavior**, not **implementation** or **UI mechanics**.

| Wrong (imperative) | Right (declarative) |
|--------------------|---------------------|
| `Given the user navigates to /login and clicks the button` | `Given the user is unauthenticated` |
| `When the user fills in the email field with "test@example.com" and clicks Submit` | `When the user submits valid credentials` |
| `Then the page shows a red banner with text "Error: Not Found"` | `Then the system returns 404 Not Found` |
| `Given the developer sets the environment variable OPENAI_KEY` | `Given a valid OpenAI API key is configured` |

**Rules:**
- One behavioral step per line. Split compound actions with `And`.
- No CSS selectors, button IDs, URL paths, or HTML element references.
- No implementation details: database column names, function names, internal service names.
- Actor names must match the Actors section exactly (no aliases mid-spec).
- `When` must have exactly one trigger — never "When X and Y". Split into separate scenarios.

---

## Anti-Patterns with Corrections

### Imperative step (implementation details leak in)

```gherkin
# Bad
When the job_runner calls OpenAIClient.create_chat_completion() with temperature=0.7

# Good
When the feedback generation job submits the transcript to the AI model
```

### Giant scenario (too many steps, multiple behaviors bundled)

```gherkin
# Bad — 12 steps, tests 3 behaviors at once
Scenario: Interview flow
  Given the user logs in
  And the user navigates to interviews
  And the user clicks "New Interview"
  When the user fills in the position field
  And the user clicks Start
  Then the interview starts
  And the WebSocket connects
  And the AI greeting plays
  And the timer starts
  And the session is recorded in the database
  And a job is created for analysis
  And the user sees the speaking indicator

# Good — split into focused scenarios: session creation, WS connection, AI greeting
Scenario: Interview session created on start
  Given the user has selected a job position
  When the user starts the interview
  Then a new interview session is created with status "active"
  And the session_id is returned to the client
```

### Duplicated scenarios instead of Scenario Outline

```gherkin
# Bad — copy-pasted with one value changed
Scenario: Rate limit error
  Given the OpenAI API returns 429
  When the job runs
  Then the system retries

Scenario: Server error
  Given the OpenAI API returns 500
  When the job runs
  Then the system retries

# Good — Scenario Outline
Scenario Outline: Transient API error triggers retry
  Given the OpenAI API returns HTTP <status>
  When the job runs
  Then the system retries up to 3 times

  Examples:
    | status |
    | 429    |
    | 500    |
    | 503    |
```

### Missing error scenarios

```gherkin
# Bad — only happy path
Feature: Coach Test Submission
  Scenario: Successful submission
    When the user submits the test
    Then the system returns 202 and a job_id

# Good — add adversarial coverage
Feature: Coach Test Submission
  Scenario: Successful submission
    When the user submits the test
    Then the system returns 202 and a job_id

  Scenario: Duplicate submission while job is in progress  ← race condition
    Given a test evaluation job is already running for this test
    When the user submits the same test again
    Then the system returns 409 Conflict

  Scenario: Submission with invalid test configuration  ← validation
    Given the test configuration is missing required fields
    When the user submits the test
    Then the system returns 400 Bad Request with field-level errors
```

---

## Non-Functional Requirements

For this project, all NFR values must be quantifiable. No adjectives without a number.

| Category | Questions to Ask | Example |
|----------|-----------------|---------|
| **Performance** | Is there a latency target? Throughput need? | `API response under 500ms at p95` |
| **Security** | Does this need auth? What access level? | `Requires JWT authentication with user ownership check` |
| **Reliability** | What happens on failure? Retry? Degrade? | `Must handle WebSocket disconnects; reconnect within 3 seconds` |
| **Scalability** | Will this grow? Concurrent users? | `Must support 100 concurrent interview sessions` |
| **Observability** | What needs logging? Metrics? | `All AI API calls logged with latency, token count, and model version` |

Mark "N/A" if the category does not apply — do not delete the section.

---

## Scoping Boundaries

### In-Scope Rules

- Be specific: `Add POST /api/v1/coach/sessions endpoint` not `Add coach API`
- List concrete deliverables, not goals
- Each item must map to at least one task in the task list

### Out-of-Scope Rules

- Call out anything the reader might assume is included but isn't
- Be explicit about adjacent features that won't be touched
- If something is deferred, say so and reference the future task if known

---

## Migration from WHEN/THEN

If you have existing flat acceptance criteria in `WHEN/THEN` format, convert them to Gherkin by extracting the implicit precondition into a `Given` step.

```
# Old flat format
WHEN a user requests feedback for a completed interview
THEN the system returns a 202 Accepted with a job_id

# New Gherkin format
Scenario: Successful feedback request
  Given the user has a completed interview
  When the user requests feedback for the interview
  Then the system returns 202 Accepted with a job_id
```

**Conversion rules:**
1. The `WHEN` clause → split into `Given` (precondition) + `When` (action)
2. The `THEN` clause → `Then` (outcome)
3. Multiple `THEN` items → `Then` + one or more `And` steps
4. Group related criteria under a single `Feature` with a `Background` for shared preconditions
5. Error/edge case criteria → separate `Scenario` blocks, not `And` steps on the happy path
