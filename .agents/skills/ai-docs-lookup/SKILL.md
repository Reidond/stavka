---
name: ai-docs-lookup
description: >
  Fetches official AI provider documentation in real time before answering questions
  about model capabilities, API parameters, WebSocket event schemas, audio formats,
  session configuration, rate limits, or any provider-specific behavior. Use whenever
  the question concerns AI model internals that may have changed since the model's
  training cutoff. Prevents stale in-memory knowledge from producing incorrect answers.
---

# AI Documentation Lookup

## Why This Skill Exists

AI model documentation changes frequently — new models ship, event schemas evolve,
parameter names are renamed, and limits are revised. Answering from memory risks
giving the user wrong or outdated information. This skill mandates fetching the
authoritative source before answering.

**Rule:** For any question that touches AI provider internals, fetch first, answer second.

---

## When This Skill Activates

Activate when the question or task involves **any** of the following:

| Category | Examples |
|---|---|
| Model names / IDs | "Which model should I use?", "What's the latest realtime model?" |
| API capabilities | "Does the Realtime API support X?", "What events does it emit?" |
| Session / connection config | Turn detection params, audio formats, voice IDs, modalities |
| Token / context limits | Max tokens, context window size, output length limits |
| Rate limits & quotas | Requests per minute, concurrent sessions, token budgets |
| SDK usage | `openai` Python package classes, async client, streaming patterns |
| Claude / Anthropic specifics | Model IDs, tool use format, system prompt handling, pricing |
| Event / message schemas | WebSocket event types, event field names, response shapes |
| Audio specifics | Sample rates, codecs, transcription models, VAD settings |

Do **NOT** activate for:

- General Python or React programming questions unrelated to AI providers
- Internal project architecture questions (answered by reading the codebase)
- Tasks where no AI-provider-specific fact is needed

---

## Documentation Sources

Use these sources in priority order. Fetch the most specific source for the question.

### OpenAI

> **Known access issue**: `platform.openai.com/docs/*` returns HTTP 403. The `developers.openai.com` guide returns empty JS/CSS with no content. Use the **SDK raw source** URLs below for authoritative type and field verification.

| Source | URL | Use for | Status |
|---|---|---|---|
| Realtime session types | `https://raw.githubusercontent.com/openai/openai-python/main/src/openai/types/beta/realtime/session.py` | TurnDetection fields, audio config, VAD params | **Working — use first** |
| Realtime session update event | `https://raw.githubusercontent.com/openai/openai-python/main/src/openai/types/beta/realtime/session_update_event.py` | Session update wire format | Working |
| Realtime incoming events | `https://raw.githubusercontent.com/openai/openai-python/main/src/openai/types/beta/realtime/` | All event types (list directory on GitHub) | Working |
| Realtime API guide | `https://developers.openai.com/api/docs/guides/realtime` | Conceptual guide (may return empty content) | Unreliable |
| Models overview | `https://platform.openai.com/docs/models` | Model IDs, context windows | May return 403 |
| Python SDK README | `https://raw.githubusercontent.com/openai/openai-python/main/README.md` | SDK usage patterns, client setup | Working |

### Anthropic / Claude

| Source | URL | Use for |
|---|---|---|
| Claude docs home | `https://platform.claude.com/docs/en/home` | Navigation starting point, all Claude docs |
| Models overview | `https://docs.anthropic.com/en/docs/about-claude/models/overview` | Model IDs, context windows, capabilities |
| Tool use guide | `https://docs.anthropic.com/en/docs/build-with-claude/tool-use` | Function/tool calling format |
| Claude API reference | `https://docs.anthropic.com/en/api/messages` | Messages API schema |

---

## Lookup Process

### Step 1 — Identify the Question Type

Classify what needs to be looked up:

- **Model facts**: name, ID, context window, modality support → fetch **Models** page
- **API behavior**: events, parameters, session config → fetch the **Guide** page
- **SDK usage**: class names, method signatures → fetch the **SDK README**
- **Multiple aspects**: fetch 1–2 most relevant pages, not all of them

### Step 2 — Fetch the Source

Use `WebFetch` with the URL from the table above.

```
WebFetch(url="https://platform.openai.com/docs/guides/realtime")
```

If the fetched content is a navigation page (table of contents, no direct content),
follow one specific link from it that targets the actual answer.

Limit: fetch at most **2 pages** per question. Do not crawl indefinitely.

### Step 3 — Extract and Answer

From the fetched content:

1. Quote or paraphrase the relevant section directly
2. State the source URL
3. Distinguish between what the docs say and any project-specific inference you make
4. If the docs don't answer the question clearly, say so — do not fall back to memory silently

### Step 4 — Flag If Documentation Is Unclear

If the fetched page does not contain a clear answer:

```
The official documentation at {URL} does not explicitly address this.
The closest relevant information is: {quote or summary}.
My interpretation: {inference}.
Recommend verifying directly in the OpenAI/Anthropic dashboard or by testing.
```

---

## Project-Specific AI Integration Points

When looking up information for this project, keep these integration points in mind:

| Concern | Where in codebase | What to verify |
|---|---|---|
| Realtime model ID | `backend/app/core/ai/config/` | Match the model ID string against the current docs |
| Session config params | `backend/app/core/realtime/session/` | Turn detection fields, audio format fields |
| Realtime event types | `backend/app/core/realtime/session/openai_event_router.py` | Event names match current schema |
| Chat completions model | `backend/app/core/ai/chat/` | Model ID, response format, tool use schema |
| Audio format | `backend/app/core/realtime/audio/` | Sample rate, encoding (pcm16 vs others) |

After fetching docs, cross-reference any discovered differences against the codebase
and flag them to the user as potential update candidates.

---

## Output Format

When this skill drives an answer, present it as:

```
**Source:** {URL fetched}

{Direct quote or accurate paraphrase from the docs}

**Project impact:** {Any implication for the codebase, or "None identified"}
```

If the question required no lookup (purely internal project question), do not invoke
this skill and do not mention it.
