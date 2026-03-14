# Documentation Impact Matrix

## Code Path to Documentation Mapping

Use this matrix to determine which documentation files to check when code in a given path changes.

### Backend Feature Code

| Code Path Changed | Check These Docs |
|-------------------|-----------------|
| `backend/app/features/{feature}/` (any file) | `backend/app/features/{feature}/README.md` |
| `backend/app/features/{feature}/api/routes.py` | `docs/onboarding/{feature}/` FLOW docs |
| `backend/app/features/{feature}/storage/entities/` | `docs/onboarding/{feature}/` data model sections |
| `backend/app/features/{feature}/services/` | `docs/onboarding/{feature}/` service docs |
| New feature created | Must create `backend/app/features/{feature}/README.md` |

### Backend Core Code

| Code Path Changed | Check These Docs |
|-------------------|-----------------|
| `backend/app/core/auth/` | `backend/app/core/auth/README.md`, `docs/onboarding/01-WEBSOCKET-CONNECTION.md` |
| `backend/app/core/http/` | `backend/app/core/http/README.md` |
| `backend/app/core/ai/` | `backend/app/core/ai/README.md`, `docs/onboarding/04-OPENAI-INTEGRATION.md` |
| `backend/app/core/usage_limits/` | `backend/app/core/usage_limits/README.md` |
| `backend/app/core/prompts/` | `backend/app/core/prompts/README.md` |
| `backend/app/core/websocket/` | `docs/onboarding/01-WEBSOCKET-CONNECTION.md`, `docs/onboarding/FLOW-01-connection-establishment.md` |
| `backend/app/core/jobs/` | Related FLOW docs that reference job processing |

### Backend Services (Cross-Cutting)

| Code Path Changed | Check These Docs |
|-------------------|-----------------|
| `backend/app/services/interview_session.py` | `docs/onboarding/02-INTERVIEW-SESSION.md`, `docs/onboarding/FLOW-04-conversation-turn.md` |
| `backend/app/services/interview_service.py` | `docs/onboarding/FLOW-02-interview-initialization.md` |
| `backend/app/api/` | `docs/onboarding/00-SYSTEM-OVERVIEW.md` |

### Database and Migrations

| Code Path Changed | Check These Docs |
|-------------------|-----------------|
| `backend/app/storage/migrations/` | `docs/onboarding/05-DATA-SERVICES.md` |
| New entity or enum | Feature-specific onboarding data model sections |

### Frontend

| Code Path Changed | Check These Docs |
|-------------------|-----------------|
| `frontend/src/` | `frontend/README.md` |
| `frontend/src/services/` | `frontend/README.md` (API integration section) |
| `frontend/src/components/interview/` | `docs/onboarding/FLOW-*` docs referencing frontend behavior |

### Testing

| Code Path Changed | Check These Docs |
|-------------------|-----------------|
| `tests/` (conventions changed) | `tests/README.md`, `tests/conventions.md` |
| New test patterns introduced | `tests/conventions.md` |

### AI Infrastructure

| Code Path Changed | Check These Docs |
|-------------------|-----------------|
| `.claude/skills/` | `.cursor/rules.md` documentation index |
| `.cursor/rules/` | `.cursor/rules.md` documentation index |
| `.ai/` | `AGENTS.md` (if workflow sections affected) |
| `AGENTS.md` | `CLAUDE.md` (if structure changed) |

## Decision Tree: Does This Change Need a Doc Update?

```
Did you create a new feature?
  └─ YES → Create feature README.md → check if onboarding docs needed
  └─ NO ↓

Did you change an API endpoint (add/modify/remove)?
  └─ YES → Check FLOW docs and feature README
  └─ NO ↓

Did you change database schema?
  └─ YES → Check data model sections in onboarding docs
  └─ NO ↓

Did you change core infrastructure (auth, websocket, AI, HTTP)?
  └─ YES → Check core module README and related onboarding docs
  └─ NO ↓

Did you change testing conventions?
  └─ YES → Check tests/README.md and tests/conventions.md
  └─ NO ↓

Did you change only internal service logic with no external behavior change?
  └─ YES → No doc update needed
  └─ NO → Check the matrix above for the specific path
```

## Examples

### Changes That NEED Doc Updates

- Added a new WebSocket event type → update FLOW docs
- Changed the authentication flow → update auth README and onboarding
- Added a new API endpoint → update feature README
- Changed job processing behavior → update relevant FLOW docs
- Created a new feature → create feature README

### Changes That DON'T Need Doc Updates

- Refactored internal service method (same external behavior)
- Fixed a bug that docs never described
- Added logging or metrics
- Changed test implementation (not conventions)
- Updated dependencies in pyproject.toml
