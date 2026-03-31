# Design Writing Guide

## Designing Within the Vertical Slice Architecture

All new components must follow the project's vertical slice architecture. Reference the
`lemmi-vertical-slice` skill (`.claude/skills/lemmi-vertical-slice/SKILL.md`) for the
canonical feature directory template.

Key constraints:
- Feature code lives in `backend/app/features/{feature_name}/`
- Layer flow: API → Service → Storage (never reverse)
- No cross-feature imports — use internal APIs or shared core modules
- One class per file, file name matches class name in snake_case

## Data Model Design Checklist

When the design involves database changes:

- [ ] New entities defined with all required fields and types
- [ ] Relationships to existing entities identified (foreign keys, one-to-many, etc.)
- [ ] Indexes identified for common query patterns
- [ ] Enums placed correctly: `storage/enums/` for persisted, `services/enums/` for business-only
- [ ] Migration strategy defined (additive preferred over destructive)
- [ ] Backward compatibility considered (can the migration run while the old code is still serving?)

## API Design Checklist

When the design involves new endpoints:

- [ ] Route follows RESTful conventions and existing URL patterns
- [ ] Request/response schemas defined as separate Pydantic models (one class per file)
- [ ] Authentication requirement specified (JWT, internal JWT, or public)
- [ ] Error responses defined (which shared exceptions for which conditions)
- [ ] Rate limiting or usage limit considerations noted
- [ ] Route registered in the feature's `routes.py`, included via `backend/app/api/api.py`

## Integration Point Assessment

When the design touches multiple features or external services:

- [ ] Communication method defined (internal HTTP API with JWT, shared core module, or events)
- [ ] Failure modes identified for each integration point
- [ ] Timeout and retry strategy defined
- [ ] Data contracts (DTOs/schemas) defined at the boundary
- [ ] Impact on existing features assessed (will this change break anything?)

## Risk Assessment Template

Identify at least one risk per design. Use this structure:

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| External API rate limits hit during peak usage | Medium | High | Implement retry with backoff; add circuit breaker |
| Migration takes too long on production data | Low | High | Test migration on production-sized dataset first |
| WebSocket connection drops during long operation | Medium | Medium | Implement reconnect logic with state recovery |

### Common Risks in This Project

- OpenAI API latency spikes or rate limits
- PostgreSQL connection pool exhaustion under concurrent WebSocket sessions
- Audio data exceeding expected sizes
- Race conditions in concurrent session state updates
- Alembic migration conflicts when multiple branches modify schema
