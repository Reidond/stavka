# Requirements: {task-name}

> Replace all `{placeholders}` with actual content. Delete instructional comments after filling in.
>
> **Section guide**:
> - `Actors` — include when the feature has user-facing interaction or involves multiple systems/agents. Omit for purely internal/subtractive changes.
> - `Acceptance Scenarios` — choose **one format per feature area**:
>   - **User Stories + Gherkin**: primary actor is a human user; flow is goal-driven; branching is simple.
>   - **Use Cases**: primary actor is a system, job runner, timer, or external API; flow has multiple sequential steps, branching, or exception paths.
>   - Both formats may coexist in the same document for different feature areas.
> - `AI Pipeline Behavior` — include only when the feature involves AI model interaction (LLM calls, Realtime API, prompt construction). Omit otherwise.
> - All other sections are mandatory.

## Problem Statement

<!-- Why does this work matter? What user pain or technical debt does it address? Quantify the impact where possible. -->

{Describe the problem this task solves and why it needs to be solved now.}

## Actors

<!-- CONDITIONAL: Include when the feature has user-facing interaction or involves multiple systems.
     Identify every actor that initiates actions or is affected by them.
     Common actors in this project:
       - User — end user interacting via frontend
       - AI Model — OpenAI API (Realtime, Chat Completions)
       - System — backend services, job runners, WebSocket connection manager
       - External Service — third-party APIs, Cloud Run infrastructure
       - WebSocket Client — frontend real-time consumer (distinct from User for wire protocol specs)
-->

| Actor | Role in this feature |
|-------|---------------------|
| {Actor name} | {What they initiate or how they are affected} |

## Acceptance Scenarios

<!-- Choose ONE format per feature area. Both may coexist in the same document.

     FORMAT A — User Stories + Gherkin
     Use when: primary actor is a human user; flow is goal-driven; branching is simple.
     See requirements-guide.md → "Gherkin Syntax Reference" for full rules.

     FORMAT B — Use Cases
     Use when: primary actor is a system, job runner, timer, or external API;
               flow has multiple sequential steps, branching, or exception paths.
     See requirements-guide.md → "Use Cases — Format and When to Use" for full rules.
-->

<!-- ═══════════════════════════════════════════════════════════
     FORMAT A: USER STORIES + GHERKIN
     Delete this block if all feature areas use Use Cases instead.
     ═══════════════════════════════════════════════════════════

     Gherkin rules:
     - Given = system context / pipeline state (what is true before the action)
     - When  = single trigger or action (one per scenario — never compound)
     - Then  = observable outcome at a verifiable boundary
     - And / But = additional steps within the same clause
     - Background = shared preconditions (use when 2+ scenarios repeat the same Given)
     - Scenario Outline + Examples = parameterized variants
     - Style: declarative ("Given the user is authenticated"), NOT imperative ("Given the user clicks login")
     - Length: max 7 steps per scenario (Given + When + Then + And/But combined)

     For AI pipeline features: Given = context, When = trigger event, Then = observable output

     ADVERSARIAL COVERAGE — after writing happy-path scenarios, answer these for each Feature:
       1. What if the actor is not authorized?              → auth boundary scenario
       2. What if the input is malformed or empty?          → validation boundary scenario
       3. What if the AI model is unavailable or slow?      → AI failure boundary scenario (if AI involved)
       4. What if a concurrent request hits the same resource? → race condition scenario (if stateful)
       5. What if the connection drops mid-operation?       → resilience scenario (if streaming/WebSocket)
     Each non-trivial answer becomes a Scenario. N/A answers are skipped.
-->

### Story: {As a [actor], I want [capability], so that [benefit]}

```gherkin
Feature: {Feature title — one capability area}

  Background:
    Given {shared precondition 1}
    And {shared precondition 2}

  Scenario: {Happy path — descriptive title}
    Given {additional context specific to this scenario, if any}
    When {the actor performs an action or an event occurs}
    Then {observable outcome 1}
    And {observable outcome 2, if needed}

  Scenario: {Error case — e.g., unauthorized access}
    Given {context that sets up the error condition}
    When {the same or related action}
    Then {expected error behavior}

  Scenario Outline: {Parameterized case title}
    Given {context with <variable>}
    When {action}
    Then {outcome referencing <variable>}

    Examples:
      | variable    |
      | {value 1}   |
      | {value 2}   |
```

<!-- Add more User Stories for additional feature areas. One Feature block per capability area. -->

---

<!-- ═══════════════════════════════════════════════════════════
     FORMAT B: USE CASES
     Delete this block if all feature areas use User Stories instead.
     Use Cases are better when the primary actor is a system component,
     job runner, external service, or timer — not a human user.
     ═══════════════════════════════════════════════════════════

     Use Case rules:
     - Preconditions: system state that must be true before the use case can run
     - Main Success Scenario: numbered steps — the nominal, uninterrupted flow
     - Alternative Flows: valid variants that deviate from the main flow (e.g., cache hit, retry success)
     - Exception Flows: failure conditions — these replace the adversarial 5-question protocol
       Required: at least one Exception Flow per Use Case (missing = incomplete spec)
     - Postconditions (Failure): state invariants guaranteed even after failure (no partial writes, error logged)
     - Keep Main Success Scenario to ≤10 steps; split longer flows into sub-use-cases
-->

### UC-{ID}: {Name}

| Field | Value |
|-------|-------|
| **Primary Actor** | {System component / service / external API / timer that initiates} |
| **Secondary Actors** | {Other participants, or "None"} |
| **Preconditions** | {What must be true before this use case can execute} |
| **Postconditions (Success)** | {State guaranteed after successful completion} |
| **Postconditions (Failure)** | {State guaranteed after failure — e.g., "no partial writes; error logged with reason"} |
| **Trigger** | {Event or condition that initiates this use case} |

**Main Success Scenario:**

1. {Primary actor} {initiating action}
2. System {validates / processes / stores}
3. System {next step}
4. {Continue numbered steps for the complete nominal flow}

**Alternative Flows:**

- **A1 — {Condition title}**: At step {N}, if {condition}: {1–3 steps to handle the variant}. Resume at step {M} / Use case ends successfully.

**Exception Flows:**

- **E1 — {Error condition}**: At step {N}, if {error}: {error-handling steps}. Use case ends with failure; {postcondition (failure) enforced}.

<!-- Add more Use Cases (UC-02, UC-03, ...) for additional system-level flows. -->

## AI Pipeline Behavior

<!-- CONDITIONAL: Include only when the feature involves AI model interaction.
     Specify behaviors that are specific to AI components and cannot be expressed
     as pure user stories: model response handling, fallback, streaming, prompt safety.
-->

### Model Interaction Contract

| Behavior | Expected Outcome |
|----------|-----------------|
| Successful model response | {What the system does with the response} |
| Model timeout (>{X}s) | {Fallback or error behavior} |
| Rate limit (429) | {Retry strategy: max attempts, backoff} |
| Unexpected response format | {Validation and error handling} |
| Prompt injection attempt | {Sanitization and rejection behavior} |

### Streaming Behavior

<!-- If the feature uses SSE, WebSocket audio, or chunked responses -->

- **Stream start**: {What signals stream is open}
- **Nominal flow**: {Expected event/chunk sequence}
- **Stream interruption**: {Behavior on disconnect or cancellation}
- **Stream completion**: {Final event and cleanup}

## Non-Functional Requirements

<!-- Performance targets, security constraints, reliability expectations.
     All values must be quantifiable — no adjectives like "fast" or "reliable".
     Mark "N/A" for categories that do not apply; do not delete sections. -->

- **Performance**: {e.g., "API response under 500ms at p95" | "N/A"}
- **Security**: {e.g., "Requires JWT authentication with user ownership check" | "N/A"}
- **Reliability**: {e.g., "Must handle WebSocket disconnects gracefully; reconnect within 3s" | "N/A"}
- **Scalability**: {e.g., "Must support 100 concurrent sessions without degradation" | "N/A"}
- **Observability**: {e.g., "All AI API calls logged with latency, token count, and model version" | "N/A"}

## Scope

### In Scope

- {Specific deliverable 1 — concrete and testable}
- {Specific deliverable 2}

### Out of Scope

- {Explicitly excluded item 1 — state why if non-obvious}
- {Explicitly excluded item 2}

## Dependencies and Constraints

- {Existing feature or module this depends on}
- {External service dependency and version/contract assumptions}
- {Known technical constraint that limits implementation choices}
