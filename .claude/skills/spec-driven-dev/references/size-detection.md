# Task Size Detection — Detailed Reference

## Classification Criteria

Each dimension is scored 0 (small), 1 (medium), or 2 (large). Sum all scores for the final classification.

| Total Score | Size | Workflow |
|-------------|------|----------|
| 0–2 | Small | Direct implementation |
| 3–6 | Medium | Lightweight spec (single doc) |
| 7+ | Large | Full spec (requirements + design + tasks) |

## Concrete Examples from This Project

### Small Tasks (Score 0–2)

**"Add a new field to the feedback response"**
- Files: 1–2 (entity + response model) → 0
- Features: 1 existing (feedback) → 0
- DB migration: Simple add column → 1
- New endpoints: 0 → 0
- Cross-feature: None → 0
- Architecture: None → 0
- **Total: 1 → SMALL**

**"Fix logging in coach service"**
- Files: 1 → 0
- Features: 1 existing → 0
- DB migration: No → 0
- New endpoints: 0 → 0
- Cross-feature: None → 0
- Architecture: None → 0
- **Total: 0 → SMALL**

**"Add a new API endpoint to return interview stats"**
- Files: 2–3 (route, service method, schema) → 0
- Features: 1 existing → 0
- DB migration: No → 0
- New endpoints: 1 → 1
- Cross-feature: None → 0
- Architecture: None → 0
- **Total: 1 → SMALL**

### Medium Tasks (Score 3–6)

**"Switch VAD mode from semantic_vad to server_vad with explicit silence gate"**
- Files: 4 (realtime_settings interview, realtime_settings coach_test, protocol, service) → 1
- Features: 2 existing (interview + coach_test share protocol) → 1
- DB migration: No → 0
- New endpoints: 0 → 0
- Cross-feature: Shared protocol change both features must implement → 1
- Architecture: Minor (provider mode choice + new session parameter) → 1
- **Total: 4 → MEDIUM**
- **Note**: This would be wrongly classified as "configuration change" (exempt) without the
  clarification in SKILL.md. The mode switch changes interview behavior fundamentally and
  touches a shared protocol — it IS subject to spec classification.

**"Add SSE support for feedback generation progress"**
- Files: 5–8 (route, service, SSE handler, schemas, tests) → 1
- Features: 1 with new components → 1
- DB migration: Maybe (job status tracking) → 1
- New endpoints: 1 SSE endpoint → 1
- Cross-feature: None → 0
- Architecture: Minor (SSE pattern) → 1
- **Total: 5 → MEDIUM**

**"Add usage limits to the coach feature"**
- Files: 4–6 (middleware, service integration, config, tests) → 1
- Features: 1 with new components → 1
- DB migration: Yes (usage tracking table) → 1
- New endpoints: 1 (usage status) → 1
- Cross-feature: Reads from core/usage_limits → 1
- Architecture: None → 0
- **Total: 5 → MEDIUM**

### Large Tasks (Score 7+)

**"Implement new coach_test feature for voice-based testing"**
- Files: 15+ (full feature slice) → 2
- Features: New feature + integration with coach → 2
- DB migration: New tables → 2
- New endpoints: 4+ (CRUD + WebSocket) → 2
- Cross-feature: Coach, feedback, interview → 2
- Architecture: Major (voice pipeline) → 2
- **Total: 12 → LARGE**

**"Migrate interview system from polling to WebSocket"**
- Files: 10+ → 2
- Features: Core interview + all consumers → 2
- DB migration: Session state changes → 1
- New endpoints: WebSocket endpoints → 2
- Cross-feature: All features using interview → 2
- Architecture: Major paradigm shift → 2
- **Total: 11 → LARGE**

## Edge Cases

**"I just want to try something quickly"**
→ User wants to skip spec. Respect the override: classify as Small regardless of heuristic score.

**"This looks small but I'm not sure"**
→ Default to Medium if uncertain. A lightweight spec adds minimal overhead and catches scope creep.

**"This is a prototype / spike"**
→ Classify as Small. Prototypes are exploratory and shouldn't be constrained by specs. If the prototype succeeds and becomes production work, create a spec then.

## Override Mechanism

The user can override the classification at any time:
- "This is small, skip the spec" → proceed directly
- "Make this a full spec" → create all three documents regardless of score
- "Just do a lightweight spec" → create single combined document

Always accept overrides without argument.
