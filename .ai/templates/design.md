# Design: {task-name}

> Fill in each section. Reference the requirements document for acceptance criteria this design must satisfy.

## Technical Approach

<!-- High-level architecture: which patterns to use, how the solution fits into the existing system. -->

{Describe the overall approach. Reference the vertical slice architecture and existing patterns where applicable.}

## Component Design

<!-- Files to create or modify, organized by feature layer. Include rationale for each. -->

### New Files

| File Path | Purpose |
|-----------|---------|
| `backend/app/features/{feature}/...` | {What this file does} |

### Modified Files

| File Path | Change Description |
|-----------|--------------------|
| `backend/app/...` | {What changes and why} |

### Files NOT to Modify

<!-- Explicit guardrails to prevent unintended side effects. -->

| File Path | Reason to Preserve |
|-----------|-------------------|
| `backend/app/...` | {Why this file must not change} |

## Data Model Changes

<!-- New entities, enums, migrations. Skip if no DB changes. -->

- **New entities**: {entity names and key fields, or "None"}
- **New enums**: {enum names and values, or "None"}
- **Migration required**: {Yes/No — if yes, describe the migration}

## API Changes

<!-- New or modified endpoints. Skip if no API changes. -->

| Method | Path | Description | Auth Required |
|--------|------|-------------|---------------|
| `POST` | `/api/v1/...` | {What it does} | Yes/No |

## Integration Points

<!-- Cross-feature communication, external service calls. -->

- {How this interacts with other features or external services}

## Risk Assessment

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| {What could go wrong} | Low/Med/High | Low/Med/High | {How to prevent or handle it} |

## Alternatives Considered

<!-- At least one alternative, even if the chosen approach seems obvious. -->

| Approach | Pros | Cons | Why Rejected/Chosen |
|----------|------|------|---------------------|
| {Chosen approach} | {Benefits} | {Drawbacks} | **Chosen** — {rationale} |
| {Alternative} | {Benefits} | {Drawbacks} | Rejected — {rationale} |
