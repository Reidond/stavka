# Stavka — LLM-Powered AI Commander for Arma Reforger

**PRODUCT.md — Unified Product Document**

> Stavka is an orchestration layer that wraps Arma Reforger's existing Commander /
> Game Master systems with LLM-powered decision-making, enabling solo or coop play
> against a dynamic AI opponent. A thin Enforce Script mod bridges the game to a
> TypeScript commander running on Cloudflare Workers + Durable Objects. The commander
> perceives the battlefield as JSON state, decides via LLM (Claude Fable 5 as the
> strategic orchestrator, Sonnet 5 squad "sergeants" — or the GPT-5.6 tier as the
> cost-effective alternative), and issues orders executed through the game's
> native spawning, waypoint, and AI-group systems.

| | |
|---|---|
| **Compiled** | 2026-08-01 |
| **Validation sessions** | 2026-02-22 → 2026-02-24 (Workbench 1.6.0.119, Arland Game Master) |
| **Codename** | Stavka (Ставка — Soviet supreme high command HQ) |
| **Status** | ✅ Engine validation complete — 12/12 critical Workbench tests passed |
| **Revision** | **B — 2026-08-02** · REST-only · Vite+ · TS 7 native · Effect · Agents SDK · 5-series models |
| **Revision** | **C — 2026-08-02** · **Poligon** — the THREE.js proving-ground sim; macOS-first dev without the game |
| **Revision** | **D — 2026-08-02** · **Maskirovka** — subscription-seat LLM proxy for dev/test; \$0 deterministic CI |
| **Revision** | **E — 2026-08-02** · seats in **production** (BYO subscription) · Responses-API-only OpenAI · direct Kumo web surfaces |
| **Revision** | **F — 2026-08-02** · everything **TanStack** on the frontend — Start · Router · Query · Table · Form · Virtual |
| **Revision** | **G — 2026-08-02** · **all-Cloudflare hosting** — the only box left is the game; seats move into Cloudflare Containers |
| **Revision** | **H — 2026-08-02** · **Cloudflare Access** in front of every human surface — dashboards, viewer, admin |
| **Next milestone** | Vite+ workspace scaffold + mod `CommanderLink`/`RestLink` implementation |

## Document Map

This document merges every artifact and finding produced during the design and
hands-on validation of Stavka:

- **Part I — Product Specification.** Vision, architecture, transport strategy,
  auth, monorepo layout, LLM decision engine, sergeant sub-agents, REST protocol,
  command types, state schema, difficulty, mod bridge design, the Poligon proving-ground sim, the Maskirovka seat proxy, direct Kumo web surfaces, persistence,
  six-phase implementation plan, resolved decisions, open questions.
- **Part II — Engine Research.** Everything learned about Enfusion / Enforce
  Script: communication options, AI system surface, Conflict mode internals,
  navmesh/terrain, networking, BattlEye analysis, plus all hands-on findings
  (waypoints, spawning, health, vehicles, events, combat, REST round-trip).
- **Part III — Workbench Validation Log.** The chronological record of the 13
  hands-on tests: what was tested, how, results, and the engine quirks discovered.
- **Part IV — Appendices.** Master prefab GUID registry (incl. full 43-waypoint
  catalog), reusable Enforce Script patterns, the Node.js test commander server,
  terrain benchmark summary, and artifact provenance.

## Validation Scorecard (at a glance)

| # | Test | Result |
|---|------|--------|
| 1 | Terrain extraction benchmark | ✅ ~8K samples/ms; Everon ≈ 120 ms at 10 m grid |
| 2 | REST outbound + auth headers | ✅ Async callbacks work; `_now` methods broken |
| 3 | Waypoint types | ✅ ForcedMove/Attack/Defend/S&D/Patrol work; **Move broken** |
| 4 | Multi-group spawn + despawn | ✅ Clean deletion; order reassignment works |
| 5 | State extraction → JSON | ✅ ~890 B/group full, ~135 B/group lean |
| 6 | Group enumeration | ✅ No engine API → **mod keeps own registry** |
| 7 | Health / alive status | ✅ Dead agents auto-remove; wiped groups auto-null |
| 8 | Vehicle spawn + boarding | ✅ UAZ469; GetInNearest boards in ~25–30 s |
| 9 | Vehicle drive + dismount | ✅ Full board → drive → dismount lifecycle |
| 10 | Event hooks | ✅ `GetOnAgentRemoved` — event-driven casualties |
| 11 | Combat engagement | ✅ No auto-engage; Attack orders → attritional combat |
| 12 | Full REST round-trip | ✅ State → POST → parse commands → execute |
| 13 | Conflict bases & objectives | 🔄 Probe script ready — needs a Conflict scenario run |

---

## Revision B — 2026-08-02

Applied on top of the validated Rev A baseline:

1. **Transport** — the WebSocket / native-plugin path is deleted from the product. REST over the engine's built-in `RestApi` is the sole transport, singular and final. (Stale "Python" references from an early draft purged with it.)
2. **Toolchain** — Vite+ (`vp`) replaces the pnpm + Turborepo + Biome + Vitest assembly: one CLI for dev, test, lint, format, and monorepo task running with caching (MIT; beta since July 2026).
3. **Compiler** — TypeScript 7 native (`tsgo`, the Go port; ~10× faster type-checks; RC since June 2026, shipping as `tsc` in the standard `typescript` package).
4. **Runtime & validation** — Effect v4 everywhere: Effect Schema for the wire format (replacing Zod), services/layers for DI, structured concurrency; `@effect/ai` (+ `-anthropic`, `-openai`) replaces the Vercel AI SDK.
5. **Models** — commander: Claude **Fable 5** (alt `gpt-5.6-sol`); sergeants: Claude **Sonnet 5** (alt `gpt-5.6-luna`); optional heavy tier: Opus 5 / `gpt-5.6-terra`. The `gpt-5.6` family (July 2026: sol $5/$30 · terra $2.50/$15 · luna $1/$6 per MTok) is the current cost-effective default; tiers swap per provider via `@effect/ai` layers.
6. **Agent harness** — adopted the **Cloudflare Agents SDK** instead of a hand-rolled orchestrator loop: the orchestrator is a parent agent (Durable Object); sergeants are sub-agents with their own SQLite state and typed **bidirectional** RPC, detached background runs with live progress, scheduling, and hibernation.

Part I below is fully revised; Part II keeps the engine research, with the dead transport investigation collapsed to a tombstone.

## Revision C — 2026-08-02 · Poligon

Development constraint: Arma Reforger has no macOS build, and the current dev
machine is a Mac. Rather than idle the commander work behind Windows access:

1. **Poligon** (полигон — *proving ground*) — a deterministic, quirk-faithful
   simulation of the validated engine behaviors, written in TypeScript/Effect,
   rendered by a React + THREE.js viewer, hosted on Cloudflare. It speaks the
   **same wire contract** (`POST /api/tick` · Effect Schema · Bearer key) from
   its own Worker — the commander cannot tell which front it is fighting.
2. **The stable ground is the wire plus a mirrored link layer**:
   `@stavka/protocol` stays the single contract; `@stavka/sim-link` is a
   line-for-line TypeScript twin of the mod's `CommanderLink`, so the later
   Enforce port is transcription, not design.
3. **Behavior parameters come from Part III, not invention** — movement speeds,
   the 75–85 m stall band, boarding and dismount times, async spawn latency,
   group auto-deletion, even the broken `Move` waypoint as a toggleable quirk.
4. Full design below in Part I (**“Poligon — The Proving Ground”**); Phases 1–3
   and the decisions table updated accordingly.

---

## Revision D — 2026-08-02 · Maskirovka

Testing constraint: the commander is chatty by design (sergeant bursts reach
150–300 calls/min), and metered API testing at that volume is not in the budget.
Both vendors now officially support subscription-authenticated programmatic use,
so:

1. **Maskirovka** (маскировка — *military deception*) — a local dev proxy that
   masquerades the developer's existing subscription seats as ordinary API
   endpoints. It speaks both dialects (`/v1/messages` and
   `/v1/chat/completions` · `/v1/responses`), so the commander's `@effect/ai`
   layers point at it with nothing but a base-URL override.
2. **Two live subscription seats**: `claude` via the Claude Agent SDK on the
   plan's monthly Agent SDK credit; `codex` via Stavka's direct Responses/SSE
   transport and ChatGPT OAuth (serving `gpt-5.6-terra` / `-luna`).
   Plus an `api` passthrough seat and a `mock` seat.
3. **Record / replay cache** — content-addressed responses make Poligon's
   seeded eval scenarios free and deterministic; CI runs in `replay` mode and
   never touches a paid seat.
4. **DX contract for humans and coding agents** — one start command, tier
   aliases instead of model names, a `doctor` that catches the silent
   API-key-overrides-OAuth trap, machine-readable health, and a root
   `AGENTS.md` + `CLAUDE.md` so Codex and Claude Code know the house rules.
5. Full design below in Part I (**“Maskirovka — Subscription-Seat LLM
   Proxy”**); Phases 1–2 and the decisions table updated.

---

## Revision E — 2026-08-02

1. **Production seats** — Maskirovka graduates from dev tool to **seat gateway**:
   any operator can register their own subscription seat(s) to power their
   server's commander in production, with metered API as the automatic
   fallback. Two postures: a co-located gateway on the game host, or an
   outbound-only contributor seat that dials in. BYO-seat only — a seat powers
   the deployment of the person who owns it.
2. **Latest APIs only** — OpenAI access is **Responses API exclusively**
   (`gpt-5.6-sol` underperforms on legacy chat completions; `@effect/ai-openai`
   is Responses-backed); Anthropic access is the latest Messages API. The
   chat-completions dialect is removed from Maskirovka's surface.
3. **One visual language** — direct granular **Cloudflare Kumo 2.9.2** imports
   on **Tailwind CSS v4**: Kumo semantic tokens and styled components are used
   on every web surface, while feature-specific compositions remain local to
   the Poligon viewer, Maskirovka dashboards, and future panels.

---

## Revision F — 2026-08-02 · Everything TanStack

Frontend stack unified on TanStack, end to end:

1. **TanStack Start** is the framework for every deployed web app — the Poligon
   viewer first, then the replay viewer, decision-log explorer, and commander
   admin. Start runs on Cloudflare Workers through the official
   `@cloudflare/vite-plugin`, and the custom server entrypoint exports the
   Agents SDK Durable Objects — so the `SimWorld` agent and the Start app share
   one Worker (`routeAgentRequest` first, Start's handler as the fallback).
2. **TanStack Router** carries scenario · seed · time-scale · camera as
   **search params validated by Effect Schema** (through Standard Schema) —
   every Poligon URL is a shareable, exact repro case.
3. **TanStack Query** owns request/response data (admin, health, logs, scenario
   CRUD). Boundary stated plainly: real-time sim/agent state stays on the
   Agents SDK WebSocket sync — Query never wraps the socket.
4. **Table · Virtual · Form** run headless in the applications that need them
   (`@tanstack/react-table`, `@tanstack/react-virtual`, and
   `@tanstack/react-form`; forms validate with Effect Schema via Standard
   Schema). Kumo supplies styled controls and accessible interaction surfaces.
5. The Maskirovka dashboard remains a static **Router + Query SPA** with direct
   Kumo imports and no SSR inside a CLI tool.

---

## Revision G — 2026-08-02 · All-Cloudflare

Hosting principle, stated once: **everything we write runs on Cloudflare.** The
Arma Reforger dedicated server is the sole exception — a game binary needs a
real machine — so the Hetzner box runs exactly one thing: the game plus its
mod. Nothing else lives on a box.

1. **Maskirovka's hosted posture becomes a Cloudflare Container per seat.** The
   image bundles the gateway plus the Claude Agent runtime and Stavka Codex transport; the
   `Container` class extends `DurableObject`, so each seat's own DO handles
   routing and lifecycle. Named accounts arrive through an Access-admin API,
   stay AES-GCM encrypted in DO SQLite, and refreshed auth state is checkpointed
   there — restarts re-inject current credentials.
   `sleepAfter` gives scale-to-zero between play sessions.
2. **The Hetzner co-location posture is retired.** The outbound home-seat
   dial-in survives only as a privacy alternative for anyone who'd rather keep
   a subscription token off cloud secrets.
3. Durable artifacts — replay corpus, terrain grids, decision-log exports —
   live in KV / R2, as already specced.

---

## Revision H — 2026-08-02 · Access

The wire was always locked (`sk-stavka-…` bearer keys); the *human* surfaces —
dashboards, the Poligon viewer, admin routes — were not. Resolved with the
Cloudflare-native answer rather than a third-party user system:

1. **Cloudflare Access** fronts every human surface at the edge: identity via
   email one-time PIN or GitHub, policy = a short allowlist, free tier covers
   up to 50 users — orders of magnitude more than this project needs.
2. **In-Worker verification** as the second wall: an Effect middleware
   validates the `Cf-Access-Jwt-Assertion` JWT (issuer, audience, signature
   against the team's public certs) on every HTTP request *and* WebSocket
   upgrade, so a routing mistake can never expose a naked Worker.
3. **Service tokens** give headless clients — CI, coding agents — access to
   protected admin APIs on deployed previews without a browser flow.
4. **Clerk is deliberately not used**: it solves user *management* (sign-ups,
   orgs, sessions) for products with a public audience. Stavka's human
   audience is an allowlist. Clerk — or self-hosted Better Auth on D1, to stay
   all-Cloudflare — is reserved for a hypothetical future where server
   operators sign up publicly.

---

# Part I — Product Specification

## Overview

Stavka is an **orchestration layer** that wraps Arma Reforger's existing Commander/Game Master
module with LLM-powered decision-making, enabling solo or coop play against a dynamic AI opponent.

**Key principle: Reuse, don't recreate.** Arma Reforger already has a Commander module with
spawning, waypoints, objectives, and AI group management. Stavka does not replace this —
it creates a **virtual AI commander** that drives the existing systems through an orchestration harness.

The system consists of:

1. **Stavka (TypeScript)** — An LLM-powered strategic orchestrator that makes high-level
   decisions (where to attack, when to reinforce, how to react). It manipulates the game through
   Arma Reforger's existing commander systems, not by reimplementing them.
2. **Orchestration Mod (Enforce Script)** — A thin bridge mod that exposes Arma Reforger's
   Commander module capabilities over a single REST transport (the engine's built-in
   `RestApi`). It translates AI Commander decisions into native game commands
   and reports game state + sub-agent feedback back up.

The core scenario is **conflict** — players face an AI-driven enemy force that captures objectives,
deploys units, reacts to threats, and adapts its strategy over time.

### Multi-Commander Support

The system supports **commander vs commander** — two AI Commander instances (or one AI + one human)
each controlling a faction. Players can join either side and receive tasks from their faction's
commander. This creates emergent PvE, PvPvE, and AI-vs-AI scenarios.

---

## Architecture

```
┌──────────────────────────────┐                              ┌───────────────────────────────┐
│   Stavka (TypeScript/CF)     │                              │   Orchestration Mod (ES)      │
│                              │   ┌──────────────────────┐   │                               │
│  ┌────────────────────────┐  │   │  Transport Layer     │   │  ┌─────────────────────────┐  │
│  │  LLM Provider          │  │   │  (CommanderLink)     │   │  │  AR Commander Module    │  │
│  │  (Claude/OpenAI/       │  │   │                      │   │  │  (existing game system)  │  │
│  │   Ollama/etc.)         │  │◄─►│  Phase 1: REST API   │◄─►│  │                         │  │
│  └────────────────────────┘  │   │  (HTTP/JSON polling) │   │  │  • Spawning             │  │
│                              │   │                      │   │  │  • Waypoints            │  │
│  ┌────────────────────────┐  │   │                      │   │  │  • Objectives           │  │
│  │  Orchestrator          │  │   │                      │   │  │  • AI Group Mgmt        │  │
│  │  • Strategic Decisions │  │   └──────────────────────┘   │  └─────────────────────────┘  │
│  │  • Sub-Agent Coord.    │  │                              │                               │
│  │  • Resource Allocation │  │                              │  ┌─────────────────────────┐  │
│  └────────────────────────┘  │                              │  │  Sub-Agent Layer        │  │
│                              │                              │  │  (Group Sergeants)      │  │
│  ┌────────────────────────┐  │                              │  │                         │  │
│  │  Game State Model      │  │                              │  │  • AIDangerEvent hooks  │  │
│  │  • World State         │  │                              │  │  • Situation reports    │  │
│  │  • Unit Tracking       │  │                              │  │  • AIOrder execution    │  │
│  │  • Terrain/NavMesh     │  │                              │  └─────────────────────────┘  │
│  └────────────────────────┘  │                              │                               │
└──────────────────────────────┘                              └───────────────────────────────┘

                          ┌────────────────────┐
                          │  Command Hierarchy  │
                          │                    │
                          │  AI Commander      │  ← Strategic (LLM-powered)
                          │    ├── Platoon 1   │
                          │    │   ├── Squad A │  ← Tactical (sub-agent / sergeant)
                          │    │   └── Squad B │
                          │    ├── Platoon 2   │
                          │    │   └── Squad C │
                          │    └── Reserve     │
                          │        └── Squad D │
                          └────────────────────┘
```

### Communication Flow

The Stavka commander and the Enforce Script mod communicate through a thin
**transport layer** (`CommanderLink`) that keeps HTTP plumbing out of the game
logic. The transport is REST over the engine's built-in `RestApi` — singular
and final.

```
┌─────────────────────────────────────────────────────────────────────┐
│                        Transport Boundary                           │
│                                                                     │
│  Stavka side:                    Mod side (Enforce Script):         │
│  ┌──────────────────────┐        ┌──────────────────────┐           │
│  │  Transport           │        │  CommanderLink       │           │
│  │  └── RestTransport   │  ◄──►  │  └── RestLink        │           │
│  └──────────────────────┘        └──────────────────────┘           │
│                                                                     │
│  One message contract (Effect Schema), one transport — end to end.  │
└─────────────────────────────────────────────────────────────────────┘
```

#### Transport: Optimized REST

- Enforce Script has a built-in `RestApi` with GET/POST support and `JsonApiStruct`
  for JSON serialization — the engine's only outbound networking, and all this
  design needs.
- Zero dependencies beyond the base game. Works on any server.
- Communication is optimized for **sub-second latency** via batching, compression,
  and combined request/response patterns.

> **Why REST?** No external dependencies, guaranteed compatibility with all
> server configurations and BattlEye. Proven pattern from DayZ modding community.

#### Design Contract: Clean Message Boundary

Regardless of transport, the message format is identical. Both sides code against
an abstract interface, never against raw HTTP directly:

```typescript
// TypeScript — abstract transport
interface Transport {
  sendCommands(commands: Command[]): Promise<void>;
  receiveState(): Promise<GameStateUpdate>;
}

class RestTransport implements Transport { ... }   // Phase 1
```

```c
// Enforce Script — abstract link
class CommanderLink {
    void SendState(string json);         // State + events up
    string ReceiveCommands();            // Commands down
    bool IsConnected();
}

class RestLink : CommanderLink { ... }       // Phase 1
```

The mod reads a config value to decide which link to instantiate. Switching
transport is a one-line config change, not a code change.

#### REST Optimization Strategy (Phase 1)

**1. Combined Request/Response (single round-trip per tick)**

Instead of separate POST + GET calls, every mod tick is a single POST that sends
state/events AND receives commands in the response body. One HTTP round-trip per tick.

```
Mod tick (every 500ms–2s):
  POST /api/tick
  Body:    { snapshot, sergeant_reports, events, command_results }
  Response: { commands, config_updates, commander_status }
```

This halves the HTTP overhead — the mod never needs a separate GET.

**2. Delta State Updates**

After the initial full snapshot, the mod only sends **changes** since last tick:
- New/destroyed units
- Units that moved beyond a threshold (e.g., >50m since last report)
- Changed objective status
- New sergeant reports / events

Full snapshots are sent every N ticks (e.g., every 30s) as a consistency checkpoint.

```json
{
  "type": "delta",
  "tick_id": 142,
  "since_tick": 141,
  "changes": {
    "units_moved": [
      { "id": "grp_01", "position": [2340.0, 0.0, 5120.0] }
    ],
    "units_destroyed": ["grp_04"],
    "new_events": [ ... ],
    "sergeant_reports": [ ... ]
  }
}
```

**3. Compact JSON**

- Short field names (e.g., `"p"` instead of `"position"`, `"id"` instead of `"group_id"`)
- Omit unchanged/default fields
- Array-of-arrays for bulk position data instead of array-of-objects
- Target: <50KB per tick for typical 20-30 unit scenarios (well under 1MB limit)

**4. Adaptive Tick Rate**

- **Idle**: 2–3 second intervals when nothing significant is happening
- **Active**: 500ms–1s during combat or when events are buffered
- **Burst**: Immediate extra tick on high-priority events (objective captured,
  mass casualties) — mod doesn't wait for next scheduled tick

```
┌─────────────────────────────────────────┐
│         Communication Timeline          │
│                                         │
│  Idle:    ──●────────●────────●──       │  (~2s intervals)
│  Active:  ──●───●───●───●───●───       │  (~1s intervals)
│  Burst:   ──●●──●───●───●●●────        │  (event-driven extras)
│                                         │
│  Each ● = single POST /api/tick         │
│  Response carries pending commands      │
└─────────────────────────────────────────┘
```

**5. Server-Side Command Batching**

The commander batches multiple decisions into a single response. If the LLM
produced 5 commands between ticks, all 5 are returned in one response — the mod
doesn't need to poll multiple times.

---

## Stavka — TypeScript / Cloudflare Workers

### Tech Stack

| Tool / Library | Purpose |
|----------------------------|--------------------------------------------|
| **TypeScript 7 native (`tsgo`)** | Language + Go-native compiler — ~10× faster type-checks; RC, ships as `tsc` |
| **Node.js 22+** | Local dev runtime, managed per-project via `vp env` |
| **Vite+ (`vp`)** | Unified toolchain — dev server, bundled Vitest, Oxlint, Oxfmt, builds, monorepo task runner with caching |
| **Effect v4** | Runtime core — services/layers, structured concurrency, retries, config |
| **Effect Schema** | Wire-format validation & codecs — single source of truth for the protocol |
| **@effect/ai** (+ `-anthropic`, `-openai`) | Provider-agnostic LLM services |
| **Cloudflare Agents SDK** | Agent = Durable Object — orchestrator + sergeant sub-agents, typed RPC, state, scheduling, hibernation |
| **Cloudflare Workers** | Production serverless runtime |
| **Durable Objects** | Persistent per-faction session state (underneath the Agents SDK) |
| **Cloudflare Containers** | Linux runtime for the seat CLIs (Claude Code · Codex) behind Maskirovka's gateway DO — secret-injected auth, DO-SQLite-persisted token state, scale-to-zero |
| **Wrangler** | CF deploy / dev / secrets |
| **TanStack** (Start · Router · Query · Table · Form · Virtual) | The entire frontend stack — SSR framework on Workers, type-safe routing with Effect-Schema'd search params, data layer, headless tables/lists/forms |

### Deployment Model

```
┌────────────────────────────────────────────────────────────────┐
│                     Production Deployment                      │
│                                                                │
│  Cloudflare Edge                        Hetzner                │
│  ┌───────────────────────┐              ┌──────────────────┐   │
│  │  Worker (stateless)   │  ◄─ REST ──► │  AR Dedicated    │   │
│  │  • /api/tick handler  │    (~10-30ms) │  Server          │   │
│  │  • Auth middleware    │              │  • BattlEye ON   │   │
│  │  • Rate limiting     │              │  • Orchestration  │   │
│  │                       │              │    Mod installed  │   │
│  │  Durable Object       │              └──────────────────┘   │
│  │  ┌─────────────────┐  │                                     │
│  │  │ Orchestrator·DO  │  │              ┌──────────────────┐   │
│  │  │ • Game state     │  │              │  LLM Providers   │   │
│  │  │ • Decision log   │  │  ◄─ API ──► │  • Anthropic     │   │
│  │  │ • Memory layers  │  │              │  • OpenAI        │   │
│  │  │ • sub-agents     │  │              └──────────────────┘   │
│  │  │   (Agents SDK)   │  │                                     │
│  │  └─────────────────┘  │                                     │
│  └───────────────────────┘                                     │
│                                                                │
│  Dev: Node + Wrangler local → same code, local runtime         │
└────────────────────────────────────────────────────────────────┘
```

### Authentication

**Model:** Shared secret (pre-shared API key). One AR server = one API key = one
Durable Object session. No user accounts, OAuth, or JWT — just a symmetric key
between the dedicated server and its paired Worker.

**Setup flow:**

```
1. Admin deploys the production services →  pnpm run deploy:production (after main CI verification)
2. Admin generates API key      →  pnpm run generate-key  (outputs sk-stavka-...)
3. Admin sets key on Worker     →  cd apps/commander && npx wrangler secret put API_KEY
4. Admin sets key on AR server  →  paste into mod server config (see below)
5. Mod sends key every request  →  Authorization: Bearer <key>
6. Worker middleware validates   →  constant-time compare, reject 401 if mismatch
```

> **Scope note:** this section is **machine** auth — mod ↔ commander ticks and
> seat registration. Every **human** surface (dashboards, the Poligon viewer,
> admin routes) sits behind Cloudflare Access; see *Auth — Securing the Human
> Surfaces* below.

**Worker side** (`apps/commander/src/api/middleware.ts`):
```typescript
// Auth guard on the tick route — an Effect service run inside the
// Orchestrator agent's onRequest, before the handler
const authorize = (req: Request) =>
  Effect.gen(function* () {
    const header = req.headers.get('Authorization');
    if (!header?.startsWith('Bearer ')) return yield* Effect.fail(unauthorized());

    const token = header.slice(7);
    const expected = yield* Config.redacted('API_KEY'); // Wrangler secret

    // Constant-time comparison to prevent timing attacks
    if (!timingSafeEqual(token, Redacted.value(expected)))
      return yield* Effect.fail(unauthorized());
  });
```

**Mod side**```

**Mod side** (`mods/shared/Configs/Stavka/default.conf`):
```
// Server admin pastes key here (or passes via startup param)
StavkaApiKey = "sk-stavka-your-key-here"
StavkaEndpoint = "https://stavka.your-account.workers.dev"
```

The mod reads `StavkaApiKey` at init and passes it via `RestContext.SetHeaders()`:
```csharp
// StavkaRestLink.c — comma-delimited key,value pairs
ctx.SetHeaders("Content-Type,application/json,Authorization,Bearer " + m_sApiKey);
```

**Key properties:**
- Key never leaves the server (not sent to clients, not in Workshop files)
- One key per server — if compromised, rotate on both sides
- HTTPS only (Cloudflare enforces TLS) — key encrypted in transit
- No per-player auth needed — the mod runs server-side, players never talk to the Worker
- `generate-key` is a convenience script: `node -e "console.log('sk-stavka-' + crypto.randomBytes(32).toString('hex'))"`

**Future (Phase 6):** If multi-server support is needed, each server gets its own key
and the Worker routes to per-server Durable Objects based on a server ID in the request.

### Monorepo Structure

```
stavka/
├── package.json                    # Root — thin wrapper over vp tasks
├── pnpm-workspace.yaml             # Workspace member definitions
├── pnpm-lock.yaml
├── vite.config.ts                  # Vite+ root config — workspaces, tasks, cache
├── tsconfig.base.json              # Shared TS config (extended by packages)
├── oxlint.json                     # Optional Oxlint overrides (vp check)
├── .github/
│   └── workflows/
│       └── ci.yml                  # Verification plus gated ordered production deploy
├── README.md
├── SPEC.md
├── RESEARCH.md
│
│── ─── TypeScript (managed by Vite+ / vp ) ────────────────
│
├── packages/
│   ├── protocol/                   # @stavka/protocol — shared types & schemas
│   │   ├── package.json
│   │   ├── tsconfig.json
│   │   └── src/
│   │       ├── index.ts            # Re-exports everything
│   │       ├── messages.ts         # Effect Schemas for all wire messages
│   │       ├── commands.ts         # Command types (spawn, move, attack, etc.)
│   │       ├── events.ts           # Event types (sitrep, contact, casualty)
│   │       └── state.ts            # Game state types (objectives, units, resources)
│   │
│   └── doctrine/                   # @stavka/doctrine — commander personality configs
│       ├── package.json
│       ├── tsconfig.json
│       └── src/
│           ├── index.ts
│           ├── types.ts            # Doctrine schema
│           ├── aggressive.json
│           ├── defensive.json
│           └── balanced.json
│
├── apps/
│   └── commander/                  # @stavka/commander — CF Workers app
│       ├── package.json
│       ├── tsconfig.json
│       ├── wrangler.toml           # CF Workers config
│       ├── src/
│       │   ├── index.ts            # Worker entry point
│       │   ├── durable/
│       │   │   └── commander-session.ts
│       │   ├── api/
│       │   │   ├── router.ts       # tick route (Agents SDK onRequest)
│       │   │   ├── tick.ts         # POST /api/tick handler
│       │   │   ├── connect.ts      # POST /api/connect handler
│       │   │   ├── map.ts          # POST /api/map handler
│       │   │   └── middleware.ts   # Auth, rate limiting, logging
│       │   ├── transport/
│       │   │   ├── types.ts        # Transport interface
│       │   │   ├── rest.ts         # REST transport (Phase 1)
│       │   ├── state/
│       │   │   ├── game-state.ts   # World model maintained from ticks
│       │   │   ├── objectives.ts   # Objective tracking
│       │   │   ├── units.ts        # Unit/group tracking
│       │   │   └── memory.ts       # Three-layer memory system
│       │   ├── brain/
│       │   │   ├── commander.ts    # Commander decision engine (strategic LLM)
│       │   │   ├── sergeant.ts     # Sergeant sub-agent (tactical LLM)
│       │   │   ├── llm-client.ts   # @effect/ai provider layers
│       │   │   ├── prompts.ts      # System/user prompt templates
│       │   │   └── planner.ts      # LLM decisions → commands
│       │   ├── logging/
│       │   │   ├── decision-log.ts # Structured decision logging
│       │   │   └── types.ts        # Log entry schemas
│       │   └── config.ts           # Environment & configuration
│       └── tests/
│           ├── protocol.test.ts
│           ├── state.test.ts
│           ├── brain.test.ts
│           └── sergeant.test.ts
│
│── ─── Enforce Script (managed by Enfusion Workbench) ──────
│
└── mods/
    ├── shared/                     # Shared Enforce Script library (dependency for all mods)
    │   ├── addon.gproj
    │   ├── Scripts/
    │   │   └── Game/
    │   │       └── Stavka/
    │   │           ├── StavkaCommanderLink.c     # Abstract link interface
    │   │           ├── StavkaRestLink.c          # REST implementation
        │   │           ├── StavkaStateReporter.c     # Collects game state each tick
    │   │           ├── StavkaCommandExecutor.c   # Translates commands → AR actions
    │   │           ├── StavkaSergeant.c          # Per-group event filtering
    │   │           ├── StavkaEventFilter.c       # ROUTINE/NOTABLE/URGENT classifier
    │   │           ├── StavkaConfig.c            # Runtime configuration
    │   │           └── StavkaUtil.c              # Common helpers
    │   ├── Configs/
    │   │   └── Stavka/
    │   │       └── default.conf
    │   └── Prefabs/
    │       └── Stavka/
    │
    ├── commander/                  # Main mod — the AI commander (depends on shared)
    │   ├── addon.gproj             # Dependency: shared
    │   ├── README.md               # Workshop description, setup instructions
    │   ├── Scripts/
    │   │   └── Game/
    │   │       ├── Stavka/
    │   │       │   ├── StavkaGameModeComp.c     # SCR_BaseGameMode component
    │   │       │   ├── StavkaTaskManager.c      # Dynamic task creation for players
    │   │       │   └── StavkaFactionSetup.c     # Per-faction commander init
    │   │       └── Modded/
    │   │           └── StavkaGameMode.c         # modded SCR_BaseGameMode hook
    │   ├── Configs/
    │   │   └── Commander/
    │   │       └── scenarios.conf               # Scenario-specific overrides
    │   └── Prefabs/
    │       └── Commander/
    │
    ├── debug/                      # Debug/admin overlay (depends on shared)
    │   ├── addon.gproj             # Dependency: shared
    │   ├── Scripts/
    │   │   └── Game/
    │   │       └── StavkaDebug/
    │   │           ├── StavkaDebugHUD.c         # On-screen state display
    │   │           ├── StavkaDebugConsole.c     # In-game console commands
    │   │           ├── StavkaDebugMarkers.c     # Map markers showing AI intent
    │   │           └── StavkaDebugReplay.c      # Decision log replay
    │   └── Configs/
    │       └── Debug/
    │           └── keybinds.conf
    │
    └── terrain-tool/               # Standalone terrain extractor (no dependency on shared)
        ├── addon.gproj
        ├── README.md               # How to run benchmark, export heightmaps
        └── Scripts/
            └── Game/
                └── StavkaTerrain/
                    ├── StavkaTerrainBenchmark.c # Grid sampling benchmark (from tutorial)
                    ├── StavkaTerrainExport.c    # Export heightmap to JSON/binary
                    └── StavkaCoverQuery.c       # Cover point extraction test
```

### Why This Layout

**TypeScript side** (managed by Vite+ `vp run`):
- **`packages/protocol`** — Shared Effect Schemas for the wire format. Both `apps/commander`
  and future tooling (replay viewer, dashboard) import from here. Single source of truth
  for the contract between mod and commander.
- **`packages/doctrine`** — Personality configs as a separate package. Easy to add new
  doctrines without touching commander code.
- **`apps/commander`** — The Cloudflare Workers application. Has its own `wrangler.toml`,
  deploys independently.

**Enforce Script side** (managed by Enfusion Workbench):
- **`mods/shared`** — Core library: transport, state reporting, command execution, config.
  Every other mod depends on this. Published to Workshop as a dependency addon.
- **`mods/commander`** — The main mod players install. Hooks into GameMode, wires up the
  shared library, manages faction setup and player tasks. Depends on `shared`.
- **`mods/debug`** — Optional server-admin tool. HUD overlay showing AI state, map markers
  for group intentions, console commands to inspect/override decisions. Not loaded in
  production. Depends on `shared`.
- **`mods/terrain-tool`** — Standalone utility for benchmarking terrain extraction and
  exporting heightmap data. No dependency on `shared` — useful even without the commander
  running. This is where the benchmark tutorial script lives.

**Mod dependency chain** (set in each `addon.gproj`):
```
terrain-tool  (standalone)
shared  ←── commander
        ←── debug
```

Server admins install: `shared` + `commander` (required), `debug` (optional).
Developers use `terrain-tool` independently in Workbench.

**Future mods** slot in easily: a spectator overlay, a scenario editor integration,
a player-facing companion app bridge — each gets its own `mods/<name>/` folder
depending on `shared` where needed.

**Deferred: Protocol codegen** — `@stavka/protocol` Effect Schemas could generate
Enforce Script enum/constant files for `mods/shared`, ensuring the wire format stays
in sync across TypeScript and Enforce Script. Decision deferred to Phase 2+ when
the protocol stabilizes.

### Root Configuration Files

```yaml
# pnpm-workspace.yaml — vp install drives pnpm underneath
packages:
  - 'packages/*'
  - 'apps/*'
  # mods/ intentionally excluded — Enforce Script, not JS packages
```

```ts
// vite.config.ts (root) — Vite+ workspaces & task graph
import { defineConfig } from 'vite-plus';

export default defineConfig({
  workspaces: ['packages/*', 'apps/*'],   // mods/ excluded — Enforce, not JS
  tasks: {
    build:  { dependsOn: ['^build'], outputs: ['dist/**'] },  // cached, dependency-aware
    dev:    { persistent: true, cache: false },
    test:   { dependsOn: ['^build'] },                        // bundled Vitest
    check:  {},                                               // tsgo + Oxlint + Oxfmt
    deploy: { dependsOn: ['build', 'test', 'check'] },
  },
});
```

```jsonc
// package.json (root)
{
  "name": "stavka",
  "private": true,
  "scripts": {
    "dev": "vp dev",
    "build": "vp run build",
    "test": "vp test",
    "check": "vp check",
    "deploy:production": "pnpm --filter @stavka/tasks deploy:production"
  },
  "devDependencies": {
    "vite-plus": "latest",
    "typescript": "latest"
  },
  "packageManager": "pnpm@9.15.0",
  "engines": {
    "node": ">=22"
  }
}
```

### Commander App Configuration

Managed via `apps/commander/wrangler.toml` (non-secret) + Wrangler secrets (API keys):

```toml
# apps/commander/wrangler.toml
name = "stavka"
main = "src/index.ts"
compatibility_date = "2025-01-01"

[durable_objects]
bindings = [
  { name = "ORCHESTRATOR", class_name = "OrchestratorAgent" } # Agents SDK parent — sergeants are sub-agents, no extra bindings
]

[[kv_namespaces]]
binding = "TERRAIN_CACHE"
id = "..."

[vars]
COMMANDER_MODEL = "claude-fable-5"       # alt: gpt-5.6-sol
SERGEANT_MODEL = "claude-sonnet-5"       # alt: gpt-5.6-luna
DECISION_INTERVAL_SECONDS = "45"
DOCTRINE = "balanced"
MAX_ACTIVE_UNITS = "50"
DIFFICULTY = "0.5"
PLAYER_SCALING = "true"
TICK_INTERVAL_IDLE_MS = "2000"
TICK_INTERVAL_ACTIVE_MS = "750"
TICK_INTERVAL_BURST_MS = "300"

# Secrets (via `wrangler secret put`):
# API_KEY — mod authentication
# ANTHROPIC_API_KEY — LLM provider
# OPENAI_API_KEY — alternative LLM provider
```

---

## Commander Brain — LLM Decision Engine

### Decision Loop (Hybrid: Tick + Event-Driven)

```
┌──────────────────────────────────────────────────────┐
│                    Decision Loop                      │
│                                                       │
│  1. TICK (every N seconds):                          │
│     - Collect current game state snapshot             │
│     - Build context (objectives, units, threats)      │
│     - Send to LLM with doctrine prompt               │
│     - Parse response → command queue                  │
│     - Execute commands from response                  │
│                                                       │
│  2. EVENT-DRIVEN (immediate reaction):               │
│     - Objective captured/lost                         │
│     - Squad eliminated                               │
│     - Players detected in new area                   │
│     - Significant casualties taken                   │
│     - Priority events bypass tick timer and           │
│       trigger immediate LLM evaluation               │
│                                                       │
│  3. RATE LIMITING:                                   │
│     - Min interval between LLM calls (prevent spam)  │
│     - Event batching (group rapid events)            │
│     - Cost tracking per session                      │
└──────────────────────────────────────────────────────┘
```

### LLM Prompt Architecture

The commander uses structured prompts with:

- **System Prompt** — Defines the commander's role, doctrine, available actions, and response format.
- **Game State Context** — Current snapshot: objectives, unit positions/status, player activity, resources.
- **Event History** — Recent events as context for decision-making.
- **Response Schema** — LLM must return structured JSON commands (enforced via prompt + validation).

Example LLM response:
```json
{
  "assessment": "Players are pushing north toward OBJ_BRAVO. Eastern flank is exposed.",
  "commands": [
    {
      "type": "spawn_group",
      "params": {
        "template": "infantry_squad",
        "position": [2340.0, 0.0, 5120.0],
        "behavior": "defend",
        "target_objective": "OBJ_BRAVO"
      }
    },
    {
      "type": "move_group",
      "params": {
        "group_id": "grp_04",
        "destination": [2100.0, 0.0, 4900.0],
        "behavior": "flank_left"
      }
    }
  ],
  "priority": "high"
}
```

### Sub-Agent Architecture (Group Sergeants — LLM-Powered)

Each spawned AI group has a **sergeant** — an LLM-powered sub-agent that operates at
the tactical level. Sergeants process filtered game events through a fast/cheap LLM model,
make tactical decisions, and report summaries upward to the Commander.

```
┌─────────────────────────────────────────────────────────────────┐
│                    Two-Tier LLM Hierarchy                        │
│                                                                  │
│  AI COMMANDER (Agents SDK parent / Fable5)   STRATEGIC LEVEL    │
│  ├── Receives sergeant summaries, not raw events                │
│  ├── "Attack OBJ_BRAVO from the east"                           │
│  ├── "Reinforce OBJ_ALPHA, it's under pressure"                 │
│  └── Decisions every ~45s or on priority events                  │
│                                                                  │
│  ──────────── single HTTP REST tick boundary ────────────     │
│                                                                  │
│  GROUP SERGEANTS (sub-agents / Sonnet 5)      TACTICAL LEVEL    │
│  ├── Receive batched + filtered game events from mod             │
│  ├── LLM decides: take cover, reposition, request support, etc. │
│  ├── Report upward:                                              │
│  │   • "Squad A: engaged enemy at grid 2450, 2 casualties"      │
│  │   • "Squad B: reached OBJ_BRAVO, holding position"           │
│  │   • "Squad C: under heavy fire, requesting support"           │
│  └── Commands sent back to mod for AR native AI execution        │
│                                                                  │
│  AR NATIVE AI              MICRO LEVEL (existing game system)   │
│  ├── Individual soldier pathfinding                              │
│  ├── Cover selection, stance, aiming                             │
│  └── Formation keeping                                           │
└─────────────────────────────────────────────────────────────────┘
```

#### Sergeant Event Pipeline

Raw game events flow through a **significance filter** before reaching the sergeant LLM:

```
AIDangerEvent stream (per group)
  │
  ▼
Rule-Based Filter (Enforce Script, mod-side)
  ├── ROUTINE  → Discarded (distant gunfire, minor movement)
  ├── NOTABLE  → Buffered, batched every ~10s → Sergeant LLM
  └── URGENT   → Immediate → Sergeant LLM (first contact, casualties, objective change)
  │
  ▼
Sergeant LLM (Sonnet 5 / gpt-5.6-luna — fast tier)
  ├── Tactical decision → Command back to mod (reposition, take cover, etc.)
  └── Summary report → Commander (sitrep for strategic context)
```

**Cost model (30-50 groups):**
- Idle group: ~1 sergeant call/min (periodic sitrep)
- Active combat group: ~5-6 sergeant calls/min (event-driven)
- Worst case: ~150-300 sergeant calls/min during heavy combat
- At `gpt-5.6-luna` pricing ($1 / MTok in · $6 / MTok out): negligible cost

#### LLM Model Tiers (Configurable)

| Tier | Anthropic | OpenAI (cost default) | Call frequency | Purpose |
|------|-----------|----------------------|----------------|---------|
| Commander | **Claude Fable 5** | `gpt-5.6-sol` — $5 / $30 per MTok | ~1/45 s + events | Strategic orchestration |
| Sergeant | **Claude Sonnet 5** | `gpt-5.6-luna` — $1 / $6 per MTok | ~1–6/min/group | Squad tactics |
| Heavy (optional) | Claude Opus 5 | `gpt-5.6-terra` — $2.50 / $15 per MTok | rare | Deep planning · after-action review |

Tiers are `@effect/ai` layers — the same program runs on either provider (or a
local model, or a mock in tests) by swapping the provided layer. The `gpt-5.6`
family (launched July 2026) is the current cost-effective default; Fable 5 is
the capability ceiling for the commander seat.

**API dialects — latest only.** OpenAI access is the **Responses API,
exclusively** — `@effect/ai-openai` is Responses-backed, and `gpt-5.6-sol`
underperforms on the legacy chat-completions surface, so nothing in Stavka may
call it. Anthropic access is the latest Messages API.

#### Agent Harness — Cloudflare Agents SDK (don't reinvent the wheel)

The orchestrator ↔ sergeant pattern is not hand-rolled. It maps 1:1 onto the
**Cloudflare Agents SDK**, which this design already sits on (Agent = Durable
Object):

- **Orchestrator** — the parent agent, one per faction session. Owns the tick
  endpoint (`onRequest`), the game-state model, and the physical DO alarm.
- **Sergeants** — sub-agents: isolated children with their own SQLite state and
  typed RPC **in both directions** (`this.subAgent(Sergeant, id)` down;
  callbacks and reports route back up through the parent).
- **Detached runs** — a sergeant can be dispatched without blocking the
  commander's turn, with live progress and durable, eviction-surviving
  completion.
- **For free** — scheduling routed to children, hibernation when idle (a quiet
  faction costs nothing), crash-recovery fibers, and the optional Project Think
  base class if the opinionated harness beats raw primitives.

Alternatives reviewed: the Claude Agent SDK and OpenAI Agents SDK model
sub-agents as one-shot tool delegations, and LangGraph / Mastra bring their own
state stores — none are DO-native. The Agents SDK is the only option where the
harness *is* the deployment substrate, so persistence, comms, and identity come
from the platform instead of extra code. Effect wraps the logic inside each
agent; `@effect/ai` keeps every model seat swappable.
#### Sergeant Reports (Mod → Commander)

```json
{
  "type": "sergeant_report",
  "timestamp": 1700000000.0,
  "payload": {
    "group_id": "grp_01",
    "report_type": "sitrep",
    "position": [2450.0, 0.0, 4800.0],
    "strength": { "current": 6, "max": 12 },
    "status": "engaged",
    "contacts": [
      { "type": "infantry", "estimated_count": 4, "bearing": 45, "distance": 200 }
    ],
    "ammo_status": "adequate",
    "morale": "steady",
    "local_decision": "Took cover in tree line, returning fire",
    "request": "requesting_support"
  }
}
```

### Doctrine / Personality

```toml
[doctrine]
name = "Soviet Aggressive"
description = "Overwhelming force, rapid assault, accepts casualties"

aggression = 0.9          # 0.0 = passive, 1.0 = relentless
caution = 0.2             # 0.0 = reckless, 1.0 = extremely careful
flanking_preference = 0.6
counterattack_threshold = 0.3   # How quickly to respond to lost objectives
reinforcement_bias = 0.8        # Preference for reinforcing vs new attacks
max_simultaneous_assaults = 3

[doctrine.personality]
# Injected into LLM system prompt for flavor
brief = """You are a Soviet battalion commander in the 1980s. You believe in
overwhelming force and rapid combined-arms assault. You accept high casualties
to achieve objectives. You favor armored thrusts supported by infantry."""
```

### Memory System (Three-Layer)

The commander maintains a three-layer memory architecture to manage LLM context efficiently:

```
┌─────────────────────────────────────────────────────────────────┐
│                     Memory Architecture                          │
│                                                                  │
│  WORKING MEMORY (included in every LLM call, ~2-4K tokens)     │
│  ├── Current unit positions and status                          │
│  ├── Objective control state                                     │
│  ├── Active contacts                                             │
│  ├── Pending commands and their status                           │
│  └── Resource budget                                             │
│                                                                  │
│  SHORT-TERM MEMORY (rolling window, ~10 min)                    │
│  ├── Recent sergeant reports (auto-compacted)                    │
│  ├── Recent events (summarized every few minutes)               │
│  ├── Last N commander decisions and outcomes                     │
│  └── Provides continuity without flooding context                │
│                                                                  │
│  LONG-TERM MEMORY (Durable Object storage, never truncated)     │
│  ├── Full decision log (every LLM call + response)              │
│  ├── Complete event history                                      │
│  ├── Session state snapshots                                     │
│  └── Post-session analysis data                                  │
└─────────────────────────────────────────────────────────────────┘
```

Working + short-term memory are injected into LLM context. Long-term memory is
stored in the Durable Object and persisted for analysis.

### Decision Logging

**Every** LLM call (commander AND sergeant) is logged as a structured record:

```typescript
interface DecisionLogEntry {
  id: string;                    // "dec_00142"
  timestamp: string;             // ISO 8601
  agent: string;                 // "commander" | "sergeant:grp_07"
  trigger: string;               // "scheduled_tick" | "event:objective_lost"
  input: {
    stateSnapshot: object;       // game state sent to LLM
    events: object[];            // events in context
    prompt: string;              // full prompt text
  };
  output: {
    rawResponse: string;         // raw LLM response
    parsedCommands: object[];    // validated commands
  };
  commandsIssued: string[];      // ["cmd_42", "cmd_43"]
  model: string;                 // "claude-sonnet-4-20250514"
  latencyMs: number;             // 2340
  tokenUsage: {
    input: number;               // 1200
    output: number;              // 350
  };
  costUsd: number;               // 0.0045
}
```

Logs are stored in the Durable Object with configurable retention. They enable:
- **Full replay** — reconstruct exactly what the commander saw, thought, and decided
- **Decision chain visualization** — trace cause → decision → outcome
- **Doctrine tuning** — identify patterns in bad decisions
- **Cost analysis** — track spend per session, per agent tier
- **Post-session debrief** — exportable as JSON for external analysis tools

---

## REST API Protocol

### Design: Single-Endpoint Tick

All communication flows through a **single POST endpoint** per tick. The mod sends
state/events in the request body and receives commands in the response. This minimizes
HTTP overhead to one round-trip per tick.

### Endpoints

| Endpoint              | Method | Description                                      |
|-----------------------|--------|--------------------------------------------------|
| `/api/tick`           | POST   | **Primary**: Send state, receive commands (every tick) |
| `/api/connect`        | POST   | Register game session on startup (once)          |
| `/api/disconnect`     | POST   | Graceful session teardown                        |
| `/api/health`         | GET    | Health check / latency probe                     |
| `/api/map`            | POST   | Upload terrain/map data (once on connect)        |

### Tick Request (Mod → Commander)

```json
{
  "tick_id": 142,
  "timestamp": 1700000000.0,
  "type": "delta",
  "full_snapshot_interval": 30,
  "snapshot": {
    "objectives": [ ... ],
    "friendly_groups": [ ... ],
    "known_enemies": [ ... ],
    "resources": { ... }
  },
  "sergeant_reports": [ ... ],
  "events": [ ... ],
  "command_results": [
    { "command_id": "cmd_38", "status": "completed" },
    { "command_id": "cmd_39", "status": "failed", "reason": "position_unreachable" }
  ]
}
```

### Tick Response (Commander → Mod)

```json
{
  "tick_id": 142,
  "commands": [
    {
      "command_id": "cmd_42",
      "type": "spawn_group",
      "params": { "template": "infantry_squad", "position": [2340.0, 0.0, 5120.0] }
    },
    {
      "command_id": "cmd_43",
      "type": "move_group",
      "params": { "group_id": "grp_01", "destination": [2100.0, 0.0, 4900.0] }
    }
  ],
  "tick_rate_hint": 1000,
  "request_full_snapshot": false
}
```

The `tick_rate_hint` (ms) lets the commander tell the mod to speed up or slow down
polling based on the tactical situation. `request_full_snapshot` forces a full state
dump on the next tick (for consistency recovery).

### Command Types

| Command Type          | Description                                  |
|-----------------------|----------------------------------------------|
| `spawn_group`         | Spawn an AI group from template at position  |
| `despawn_group`       | Remove a group from the world                |
| `move_group`          | Order group to move to position (uses `AIWaypoint_ForcedMove`) |
| `attack_group`        | Order group to attack toward position (uses `AIWaypoint_Attack`) |
| `defend_group`        | Order group to hold/defend position (uses `AIWaypoint_Defend`) |
| `patrol_group`        | Order group to patrol area around position (uses `AIWaypoint_Patrol`) |
| `sweep_group`         | Search and destroy toward position (uses `AIWaypoint_SearchAndDestroy`) |
| `set_objective`       | Create/modify a dynamic objective            |

> **Implementation note**: Normal `AIWaypoint_Move` is broken — AI stays idle.
> All movement commands must use `AIWaypoint_ForcedMove` (`{06E1B6EBD480C6E0}`).
> Attack, Defend, SearchAndDestroy, and Patrol all work natively via `AddWaypoint()`.
> Agents spawn asynchronously (~1 second); wait for `IsInitializing() == false` before
> assigning waypoints. Use `CallLater()` for cleaner delayed execution.

### State Snapshot Schema

```json
{
  "type": "state_snapshot",
  "timestamp": 1700000000.0,
  "payload": {
    "mission": {
      "name": "Conflict_Everon",
      "map": "Everon",
      "time_elapsed_seconds": 1200,
      "player_count": { "friendly": 0, "enemy": 3 }
    },
    "objectives": [
      {
        "id": "OBJ_ALPHA",
        "name": "Tyrone Airfield",
        "position": [3200.0, 0.0, 4100.0],
        "status": "friendly",
        "capture_progress": 1.0
      }
    ],
    "friendly_groups": [
      {
        "id": "grp_01",
        "template": "infantry_squad",
        "position": [3150.0, 0.0, 4050.0],
        "strength": { "current": 8, "max": 12 },
        "behavior": "defend",
        "status": "idle",
        "last_sitrep": "Holding position, no contacts"
      }
    ],
    "known_enemies": [
      {
        "reported_by": "grp_01",
        "type": "infantry",
        "estimated_count": 4,
        "last_known_position": [2800.0, 0.0, 3900.0],
        "confidence": "confirmed",
        "age_seconds": 30
      }
    ],
    "resources": {
      "manpower": 150,
      "vehicle_pool": 5,
      "reinforcement_cooldown_seconds": 0
    }
  }
}
```

> **Note**: `known_enemies` is derived from sergeant reports, NOT from omniscient game state.
> Enemy positions are only known when reported by friendly sub-agents. Reports age and
> lose confidence over time.

---

## Difficulty & Scaling

The commander adjusts its behavior based on:

- **Difficulty setting** (0.0–1.0): Affects spawn rates, reaction speed, unit quality, LLM aggressiveness prompting.
- **Player count scaling**: More players → more enemy units, faster reinforcements.
- **Adaptive difficulty**: Track player performance (K/D, objective control rate) and adjust mid-session. The LLM receives this context and can modulate its strategy.

### Resource Budget System

The commander operates within a budget to prevent infinite spam:

- **Manpower pool** — Replenishes over time, spent on spawns.
- **Vehicle pool** — Limited, high-value assets.
- **Reinforcement cooldowns** — Minimum time between spawn waves.
- **Max active units cap** — Hard limit for game performance.

---

## Arma Reforger Mod — Orchestration Bridge

> *Detailed mod spec is separate — this covers the interface contract.*

### Design Principle: Reuse AR's Commander Module

The mod is **NOT** a custom commander implementation. It is a thin orchestration bridge that:

- Wraps Arma Reforger's **existing Commander module** (SCR_CommanderComponent, etc.)
- Exposes native AR capabilities (spawning, waypoints, objectives, AI groups) via `CommanderLink`
- Adds a **sub-agent (sergeant) layer** on top of AR's native AI group system
- Translates between the AI Commander's strategic commands and AR's native scripting API

This means we inherit all of AR's existing AI behaviors, pathfinding, formation systems,
and group management — we just add a strategic brain on top.

### Mod Responsibilities

1. **CommanderLink (Transport)** — Abstract communication layer. Phase 1 uses AR's
   built-in `RestApi` + `JsonApiStruct`. Game logic never touches transport
   plumbing directly.
2. **AR Commander Wrapper** — Interfaces with AR's Commander module to execute actions.
3. **State Reporter** — Collects game state each tick via `CommanderLink.SendState()`.
4. **Sergeant Layer** — Monitors each AI group via `AIDangerEvent` and perception system,
   makes local tactical decisions using AR's native AI, and includes `sergeant_report`
   data in state updates.
5. **Command Executor** — Receives commands via `CommanderLink.ReceiveCommands()`,
   translates to native AR API calls: spawning via prefab instantiation, waypoints via
   `AIWaypoint`, orders via `AIOrder` (Hold, Move, Attack, Defend, etc.).
6. **Event Buffer** — Hooks into AR's event system and buffers events between ticks.

### AR Script API Classes We Wrap

| Our Concept | AR Class(es) | Usage |
|---|---|---|
| AI Group | `SCR_AIGroup`, `ChimeraAIGroup`, `AIGroup` | Group creation, management, events |
| Waypoints | `AIWaypoint`, `SCR_DefendWaypoint`, `AIWaypointCycle` | Movement, patrol, defense orders |
| Orders | `AIOrder` (Move, Attack, Defend, Hold, Follow) | Direct group commands |
| Spawning | Prefab instantiation + `SCR_AIGroup` creation | Agents spawn async (~1s). Use `AIWaypoint_ForcedMove` for movement. |
| Perception | `AIDangerEvent`, `AICommunicationComponent` | Threat detection, sergeant reports |
| Objectives | `SCR_CampaignMilitaryBaseComponent` | Base/objective state tracking |
| Cover | `ChimeraCoverManagerComponent` | Cover point queries |
| NavMesh | `NavmeshWorldComponent` on `SCR_AIWorld` | Pathfinding validation |
| Game Mode | `SCR_GameModeCampaign` (Conflict) | Base game mode integration |

### Terrain & NavMesh Data

The mod should expose terrain awareness to the AI Commander:

- **NavMesh accessibility** — Which areas are traversable by infantry, vehicles.
- **Elevation data** — High ground positions, defilade.
- **Key terrain features** — Roads, buildings, forests, water (tagged zones or grid-based).
- **Cover density** — Rough classification of terrain (open, light cover, heavy cover, urban).

This data can be sent as a **one-time map briefing** on connection, with a simplified grid
representation the LLM can reason about:

```json
{
  "type": "map_briefing",
  "payload": {
    "map_name": "Everon",
    "grid_size": 100,
    "grid_resolution_meters": 50,
    "terrain_grid": [
      { "grid": [23, 41], "type": "forest", "cover": "heavy", "elevation": 145, "traversable": true },
      { "grid": [23, 42], "type": "road", "cover": "none", "elevation": 140, "traversable": true },
      { "grid": [24, 41], "type": "urban", "cover": "heavy", "elevation": 142, "traversable": true }
    ],
    "key_features": [
      { "name": "Hill 205", "grid": [30, 55], "type": "high_ground", "elevation": 205 },
      { "name": "Bridge Crossing", "grid": [28, 40], "type": "chokepoint" }
    ]
  }
}
```

> **Benchmarked**: `World.GetSurfaceY()` runs at ~8,000 samples/ms. A 10m grid
> over a 4km² map completes in 20ms (160K samples). Everon extrapolates to ~120ms
> for 1M samples. Extract at load time — no caching needed. Heights below sea level
> (sentinel value -256) indicate out-of-bounds areas and should be filtered.
> NavMesh queries, raycasting, and cover classification still need experimentation.

### Fog of War

The commander **does not receive omniscient game state**. Instead:

- Commander only knows what its **sub-agents (sergeants) report**.
- Sergeant reports include contacts they've **detected** (using AR's native detection/awareness).
- Player positions are only known when spotted by friendly units.
- The `state_snapshot` includes a `known_enemies` section (reported contacts) separate from
  ground-truth positions, which the mod tracks internally but does not expose.
- This creates natural information asymmetry and realistic command fog.

### Mod Configuration

Set via in-game mission settings or config file:
- Commander server address (`http://localhost:8080` or `ws://localhost:8080/ws`)
- Transport: REST (fixed — the engine's `RestApi`)
- Tick rate: idle/active/burst intervals
- Delta movement threshold (meters)
- Faction assignment
- Allowed unit templates
- Terrain data resolution (default 50m — 10m proven feasible at ~8K samples/ms)

---

## Persistence & Reconnection

The system supports state persistence across commander restarts and reconnections:

### Commander-Side Persistence

- **Game state model** is serializable to JSON/disk.
- On disconnect, the commander saves current state (unit positions, orders, resource budget,
  decision history).
- On reconnect, it requests a fresh `state_snapshot` from the mod, reconciles with saved state,
  and resumes operations.
- Decision history / event log is persisted for post-session analysis.

### Mod-Side Resilience

- If HTTP requests fail, the mod continues running — AI groups continue their last orders
  using AR's native AI (sergeants keep operating autonomously).
- Mod retries HTTP connection on a configurable interval.
- On reconnect, mod sends a full state snapshot so the commander can rebuild context.

### Session Save/Load

```toml
[persistence]
save_directory = "./sessions"
auto_save_interval_seconds = 60
save_decision_history = true
max_history_entries = 500
```

---

## Poligon — The Proving Ground (Simulation Layer)

> полигон — the training ground where a formation drills before it meets a real front.

**Why it exists.** Arma Reforger does not run on macOS, and most of the remaining
work — harness, sergeants, doctrine, protocol — never needed the game anyway; it
needs *something on the other end of the wire that behaves like the game*. Poligon
is that something: a deterministic simulation of the engine behaviors validated in
Part III, hosted on Cloudflare next to the commander, rendered in THREE.js, and
driveable from pause to ×100 time. It also permanently upgrades testability:
seeded, replayable engagements in CI instead of screenshots from Workbench.

### The One Rule

**The commander must not be able to tell which front it is fighting.** Poligon
connects from its own Worker, over the public URL, with the same Bearer key, the
same `POST /api/tick`, the same Effect Schemas. No sim flags in the protocol, no
special cases in the commander. If the commander needs a change to fight Poligon,
that change was owed to the real front too.

```
                    ┌──────────────────────────────┐
                    │   STAVKA HQ  (unchanged)     │
                    │   Orchestrator + sergeants   │
                    └──────────────▲───────────────┘
                                   │  one wire contract
                      POST /api/tick · Effect Schema · Bearer
                                   │
             ┌─────────────────────┴─────────────────────┐
             │                                           │
┌────────────▼───────────┐                ┌──────────────▼──────────────┐
│  REAL FRONT (later)    │                │  POLIGON (now)              │
│  AR dedicated server   │                │  apps/poligon Worker        │
│  mods/shared           │     twins      │  SimWorld agent (DO)        │
│   └ CommanderLink      │  ◄─────────►   │   └ @stavka/sim-link        │
│     (Enforce Script)   │                │  @stavka/sim-core           │
│  Enfusion engine       │                │   deterministic world       │
└────────────────────────┘                │       ▲ WS state sync       │
                                          │  React + THREE.js viewer    │
                                          └─────────────────────────────┘
```

### Packages

| Package | What it is |
|---|---|
| `@stavka/sim-core` | Headless deterministic world: terrain grid, groups, agents, waypoints, combat, vehicles, events. Pure Effect — no DOM, no THREE, no network. Fixed 100 ms steps, seeded PRNG, snapshot/restore. |
| `@stavka/sim-link` | The TypeScript twin of `mods/shared`: group registry, state-JSON assembly, tick POSTs, command parse/dispatch, the ROUTINE / NOTABLE / URGENT event filter. Written function-for-function against the Enforce plan so the later port is transcription. |
| `apps/poligon` | A separate Worker — same trust topology as the Hetzner box: `SimWorld` agent (Agents SDK) hosts sim-core + sim-link and steps the world on alarms; the viewer is a **TanStack Start** app sharing the same Worker via a custom server entrypoint (`routeAgentRequest` first, Start's handler as fallback). Authenticates to the commander with a normal `sk-stavka-…` key. |
| Viewer (inside `apps/poligon`) | TanStack Start + React + THREE.js (`@react-three/fiber` + `drei`): heightmap mesh, unit markers, waypoint pins, engagement rings, live decision-log feed, time controls (pause · step · ×1 ×10 ×100), scenario picker, doctrine selector. Live state over the Agents SDK's built-in WebSocket sync (`useAgent`). |

**Scenario URLs are repro cases.** Scenario · seed · time-scale · camera live in
TanStack Router search params, validated by Effect Schema (via Standard
Schema). Paste a link, get the exact world — bug reports become URLs.

**Three hosts, one core.** `sim-core` runs (1) inside Vitest for fast-forward unit
and scenario tests, (2) inside the `SimWorld` agent for the hosted proving ground,
and (3) directly in the browser for offline tinkering. Only the host differs; the
world code is identical.

### Quirk-Faithful Behavior Model

Every parameter is sourced from the Part III validation log — including the
engine's warts, because commander logic must survive them:

| Behavior | Sim rule | Source |
|---|---|---|
| ForcedMove | beeline ≈2 m/s to waypoint, stop inside completion radius | Tests 3 · 9 |
| Attack | advance ≈2 m/s, engages en route | Test 3 (≈6 m / 3 s) |
| Defend | hold + micro-drift inside a small radius | Test 3 |
| Patrol | bounded random wander around the waypoint | Test 3 |
| SearchAndDestroy | advance with a widened detection cone | Test 3 |
| `Move` waypoint | **does nothing** — AI idles (quirk toggle, default ON) | Test 3 |
| Spawn | group exists instantly; agents materialize after ≈1 s | Tests 3–12 |
| Casualties | dead agents leave the roster immediately | Test 7 |
| Wipe | the group object nulls itself when the last agent dies | Test 7 |
| Combat pacing | zero auto-engage without orders; a closing fight stalls at 75–85 m; attritional casualty rate tuned to ≈1 KIA / 2 min at the 6v4 baseline | Test 11 |
| Dispersion | squads spread 50 m+ while advancing | Test 11 |
| Boarding | GetInNearest ≈25–30 s, with occasional stuck-then-recover | Tests 8–9 |
| Driving | ForcedMove drives mounted groups ≈10 km/h with brief self-recovering stalls | Test 9 |
| Dismount | GetOut ≈9 s | Test 9 |
| Terrain | 10 m heightmap grid; `-256` = ocean / out-of-bounds | Test 1 |
| Payloads | state serializer matches the ≈135 B/group lean shape | Tests 5 · 12 |

Combat resolution is intentionally coarse — a stochastic exchange model over range,
cover noise, and numbers, tuned to reproduce the observed pacing. Poligon proves
command decisions, not ballistics.

### Terrain

Procedural seeded heightmaps on day one. The `terrain-tool` mod already specs a
JSON heightmap export, so Poligon later loads **real Arland / Everon grids** — the
commander drills on the actual maps it will fight on.

### Conformance — the Graduation Exam

The stable ground is only stable if the real mod must pass what the sim passes:

1. **Wire fixtures** — the captured Test 12 round-trip JSON is the golden corpus;
   sim-link output must survive Effect Schema decode + canonical re-encode against it.
2. **Behavioral specs** — table-driven scenario tests run against sim-core in CI:
   “ForcedMove covers ≥180 m in 120 s”, “a wiped group vanishes from the next state
   report”, “no contact without orders at 150 m”, and so on down the table above.
3. **Graduation** — when Windows access returns, the same black-box suite replays
   against the real mod in Workbench. Divergences become either sim fixes or new
   Part III findings. Only a graduated commander build gets pointed at Hetzner.

### Non-Goals

Not a game, not a renderer showcase. No pathfinding beyond straight-line + slope
cost, no per-bullet ballistics, no client-side prediction. The viewer is
read-mostly (scenario + time controls only); the `SimWorld` agent stays
authoritative — the same topology as a dedicated server.

### Monorepo Additions

```
packages/
├── sim-core/            # deterministic world (pure Effect)
├── sim-link/            # TS twin of mods/shared CommanderLink
apps/
├── poligon/             # SimWorld agent + React/THREE viewer (own Worker + assets)
```

---

## Maskirovka — Subscription-Seat LLM Proxy (Dev · Test · Production Seats)

> маскировка — the art of making the enemy see a different army than the one that exists.

**Why it exists.** A commander that thinks every 45 seconds and fields dozens of
sergeants is expensive to exercise against metered APIs — sergeant bursts alone
hit 150–300 calls/min. Meanwhile the developer already pays for two seats that
now *officially* permit programmatic use: a Claude plan (monthly Agent SDK
credit) and a ChatGPT plan (Codex sign-in). Maskirovka is a small proxy
that presents those seats as ordinary API endpoints — the commander cannot tell
the difference, and neither can any other OpenAI/Anthropic-shaped client. Since
Revision E it is also the **production seat gateway**: operators register their
own seats to power their server's commander, metered API standing by as the
automatic fallback.

### Shape

One codebase, two homes — a local Node/Effect process in dev (`tools/maskirovka`,
default `:4141`), and the same code inside a **Cloudflare Container** behind a
gateway Durable Object in production:

```
Commander (wrangler dev)                    MASKIROVKA (localhost:4141)
  @effect/ai-anthropic ──┐                  ┌──────────────────────────────┐
  @effect/ai-openai    ──┤ base-URL        │  /v1/messages (Anthropic, new)│
                          └───────────────► │  /v1/responses (OpenAI, only)│
  model = tier alias:                       │  — latest dialects, no legacy│
    stavka/commander                        │  /v1/models · /healthz · /_/ │
    stavka/sergeant                         │                              │
    stavka/heavy                            │  tier map → seat + model     │
                                            │  cache: record / replay      │
                                            │  per-seat governor + queue   │
                                            └───┬──────┬──────┬──────┬────┘
                                                │      │      │      │
                                          claude│ codex│   api│  mock│
                                           seat │  seat│  seat│  seat│
```

### Seats

| Seat | Mechanism | Billing | Notes |
|---|---|---|---|
| `claude` | **Claude Agent SDK** `query()` — tools disallowed, `maxTurns: 1`, system prompt passthrough; named subscription account from `claude setup-token` | The plan's **monthly Agent SDK credit** ($20 Pro · $100 Max 5x · $200 Max 20x, at API rates, no rollover) | Subscription auth is accepted only through the Agent SDK runtime; API keys remain a distinct metered credential type |
| `codex` | **Stavka Codex** — direct ChatGPT Responses/SSE, cancellation, structured output, usage and diagnostics; named ChatGPT OAuth account | ChatGPT plan's included Codex usage (5-hour windows) | No Pi, Fold, Codex SDK, or Codex CLI runtime dependency |
| `api` | Plain passthrough with real keys | Metered | Parity / A-B checks and pre-prod smoke |
| `mock` | Deterministic scripted commander (rule-based, seed-aware) | $0 | Poligon CI default; no network |

### Tier Aliases

The commander never names a concrete model. It asks for `stavka/commander`,
`stavka/sergeant`, or `stavka/heavy`; `maskirovka.config.ts` resolves each alias
to a seat + model per environment. Swapping "everything on Codex" for
"commander on Claude, sergeants mocked" is a config edit, not a code change —
and in production the same aliases resolve inside the commander via
`@effect/ai` — healthy registered seats first, metered API as the automatic
fallback.

### Production Seats — Bring Your Own Subscription

Registered seats are a first-class deployment option, not a dev trick:

- **Posture A — Cloudflare Container (default).** `maskirovka deploy-seat`
  ships the gateway image — Node plus the Claude Agent runtime and Stavka Codex — as a
  per-seat Container. `Container` extends `DurableObject`, so the seat's own DO
  handles routing and lifecycle; the CLI pushes named accounts through
  Cloudflare Access and credentials stay encrypted in DO SQLite. Refreshed auth
  is checkpointed so restarts re-inject current credentials. `sleepAfter` gives
  scale-to-zero between play sessions. The game box
  runs the game — nothing else.
- **Posture B — contributor seat (outbound-only).** `maskirovka serve --register
  wss://<commander>/seats --token <reg-token>` — the seat dials the commander
  over the Agents SDK WebSocket, holds the connection, and pulls jobs. A home
  Mac behind NAT contributes a seat with zero inbound exposure. Kept as the
  privacy-preserving alternative for anyone who'd rather not place a
  subscription token in cloud secrets.

**Why not a plain Worker with an R2-backed filesystem?** Considered, and half
of it even exists: Workers ship a virtual `node:fs` (ephemeral, per-request)
that could be hydrated from R2. But storage was never the blocker — **process
execution is**. Workers' `node:child_process` is a stub; an isolate cannot
spawn the `claude` subprocess the Agent SDK requires, or run the `codex`
binary at all. The Workers-native alternative — reimplementing the CLIs'
subscription OAuth against provider backends — is exactly the non-SDK
subscription use Anthropic prohibits, and brittle reverse-engineering on the
OpenAI side. The Container *is* the R2-filesystem idea with a CPU attached.

**Where R2-as-filesystem does earn a place — inside the seat Container:**
auth state stays on the boot-materialize / checkpoint-to-DO-SQLite pattern
(tiny, transactional), while the CLIs' *cache* directories (`~/.cache`) may be
FUSE-mounted onto an R2 bucket so warm caches survive `sleepAfter` restarts
and shave cold-start off a session's first tick. Not SSD-fast — caches are the
tolerant workload that doesn't care.

**Seat registry.** The Orchestrator agent stores registered seats — name, mode
(push URL / pull socket), served models, monthly budget, priority, health — and
resolves each tier alias through: healthy registered seats in priority order →
the metered `api` seat. Admin via config plus `/admin/seats`.

**Budget-aware degradation.** The Agent SDK credit is capped and does not roll
over; Codex runs in plan windows. When a seat exhausts, the commander either
falls to metered API or stretches its tick interval — the operator picks the
policy, and the decision log records every downgrade.

**BYO policy, stated plainly.** A seat belongs to the operator who runs it and
powers *their* deployment — the same sanctioned class as Agent-SDK third-party
apps and `claude -p` in CI. Stavka never brokers strangers' seats as a hosted
service, and per-seat keys make every seat individually revocable.

### Record / Replay Cache

Content-addressed on-disk cache keyed by `(tier, canonical request hash)`:

- **`record`** — miss → seat → store. First run of a seeded Poligon scenario
  pays once.
- **`replay`** — miss → **fail**. CI mode: the eval suite is byte-deterministic
  and costs $0, forever.
- **`live`** — bypass, for interactive tinkering.

Combined with Poligon's seeded worlds, the entire fast-forward eval suite
becomes free, instant, and diffable.

### Burst Discipline

Sergeant storms must never hit a subscription seat raw. Per-seat governors cap
concurrency (`claude`: 1–2 lanes; `codex`: plan-window aware) with a fair queue
and backpressure; per-tier policy defaults to `sergeant: cache-first` with an
explicit `--live-sergeants <n>` budget per run. A window tracker estimates
remaining plan headroom and the console shows a running
**"saved ~$X.XX vs API list"** meter.

### Doctor & Guardrails

`maskirovka doctor` checks, in order: Claude Agent runtime → named provider
accounts → **the silent-override trap** (a set
`ANTHROPIC_API_KEY` / `OPENAI_API_KEY` beats OAuth and quietly moves billing to
the metered account — doctor warns loudly) → 1-token seat pings → writes
`.dev.vars` for `wrangler dev` (`STAVKA_AI_BASE_URL`, tier aliases). Guardrails:
dev mode binds to localhost only; `serve` modes demand an explicit per-seat
bearer key (push) or registration token (pull), so production use is always
deliberate — a seat only powers a commander that has it registered, and
registration is revocable per seat.

### DX Contract

**For the human** — `vp run ai:up` (start + first-run doctor), `ai:doctor`,
`ai:smoke`, `ai:models`, `ai:serve` (production gateway / seat registration); a live dashboard at `/_/` — a static TanStack Router + Query SPA built from
direct Kumo imports, behind Cloudflare Access in hosted postures (request feed, seat
status, tier remap, kill switch); readable per-request log lines
(tier · seat · tokens · ms · queue depth · cache hit).

**For coding agents** — a shared section in root `AGENTS.md` (Codex) and
`CLAUDE.md` (Claude Code):

- how to start it, and that dev LLM traffic goes through `:4141` — never add
  real API keys to dev env files;
- the three tier aliases and a copy-paste `curl` probe per dialect;
- `GET /healthz` returns machine-readable seat status; `GET /v1/models` lists
  aliases → resolutions;
- the eval rule: `vp run eval -- --replay` before commit; `record` only when a
  scenario legitimately changed.

Because `.dev.vars` is auto-generated, an agent running `vp dev` gets a working
commander with zero plumbing.

### Fidelity Ladder

| Rung | What runs | Valid for | Not valid for |
|---|---|---|---|
| `mock` | scripted commander | Poligon mechanics, protocol, harness wiring | any model behavior |
| `replay` | cached seat outputs | CI, regression, prompt-diff review | novel prompts |
| `seat` | subscription models | commander/sergeant *logic* against real models | pricing, latency, exact prod-model parity |
| `api` | metered models | pre-prod parity, latency/cost benchmarks | bulk iteration |
| prod | registered seats → `api` fallback | the real thing | — |

Known seat caveats, stated plainly: sampling control is partial (the SDK
harnesses own some parameters), latency is higher than raw API (mitigated with
persistent warm threads per seat), and the Claude seat serves the *plan's*
models. Graduate up the ladder before drawing conclusions the rung can't
support.

### Monorepo Additions

```
tools/
├── maskirovka/          # local proxy — Effect + @effect/platform-node, no deploy target
AGENTS.md                # Codex house rules (shared LLM-in-dev section)
CLAUDE.md                # Claude Code house rules (same section)
```

---

## Auth — Securing the Human Surfaces (Cloudflare Access)

Two kinds of clients, two systems, deliberately separate: **machines** hold
pre-shared bearer keys (the mod, seat gateways, registration tokens — specced
above); **humans** authenticate at the edge through **Cloudflare Access**,
before a single line of Worker code runs.

### The Four Layers

| Layer | What | Where |
|---|---|---|
| 0 · Machine wire | `sk-stavka-…` bearer keys, seat keys, registration tokens — constant-time checks | Worker middleware (unchanged) |
| 1 · Edge identity | Cloudflare Access app per surface; login via email one-time PIN or GitHub; policy = allowlist (free ≤ 50 users) | Cloudflare edge, before the Worker |
| 2 · In-Worker verification | Effect middleware validates the `Cf-Access-Jwt-Assertion` JWT — issuer (team domain), audience (app AUD tag), signature against cached team certs — on HTTP **and** WebSocket upgrades (`onRequest` / `onConnect`) | Every Worker with a human surface |
| 3 · App authorization | Identity → role: `owner` (everything) · `operator` (their server's seats, doctrine, difficulty) · `spectator` (read-only viewer). Day one: owner-only. | App code |

### Protected Surfaces

| Surface | Access app | Notes |
|---|---|---|
| Poligon viewer (`poligon.<domain>`) | ✔ | Covers the Agents SDK WebSocket sync too — the browser sends the Access cookie on the upgrade; Layer 2 re-verifies it in `onConnect` |
| Commander admin (`/admin/*`, incl. `/admin/seats`) | ✔ | Service tokens allowed for headless clients |
| Maskirovka dashboard (`/_/`, hosted postures) | ✔ | The Container sits behind its gateway DO's Worker route — same Access app; the LLM endpoints themselves still demand seat keys (Layer 0) |
| Future panels (replay viewer, decision-log explorer) | ✔ | New route → same pattern, one policy edit |

### Non-Interactive Clients

Access **service tokens** (client-id/secret header pair) let CI and coding
agents hit protected admin APIs on deployed previews without a browser. They
slot into the `AGENTS.md` / `CLAUDE.md` contract next to the tier aliases;
Layer 2 accepts a valid service-token assertion in place of a user JWT and
maps it to a constrained `automation` role.

### Dev Semantics

`wrangler dev` runs without Access. The Layer-2 verifier accepts a synthetic
dev identity **only** when running locally (injected via `.dev.vars`, refused
in deployed environments), so the auth code path is exercised in dev instead
of skipped.

### Public Sharing, Later

If a Poligon replay ever needs to be publicly viewable, the answer is a
**signed, expiring spectate URL** (HMAC over replay-id + expiry) on a
read-only route — not a hole in the allowlist.

### Why Not Clerk

Clerk is excellent at what it is: user *management* — sign-ups, sessions,
orgs, profiles — for products with a public audience. Stavka's human audience
is an allowlist of one-to-few, the doctrine is all-Cloudflare, and Access
costs zero code and zero vendors. If Stavka ever grows public multi-tenant
sign-up (operators self-serving their servers), that is the moment to add a
real user system — Clerk, or Better Auth on D1 to stay self-hosted — *behind*
Access-protected admin, not instead of it.

---

## Direct Kumo Frontend Composition (Tailwind 4 + app-local features)

Every web surface in this project — the Poligon viewer, the Maskirovka
dashboards, and future replay or decision-log panels — uses the same Kumo
semantic vocabulary without introducing another shared UI package. Each app
imports only the Kumo component or primitive it renders, then keeps its
feature-specific compositions beside the feature that owns them.

### Stack

- **Cloudflare Kumo 2.9.2** — direct granular imports from
  `@cloudflare/kumo/components/*` and `@cloudflare/kumo/primitives/*`. Prefer
  Kumo styled components; use a primitive only when the surface needs behavior
  not covered by a styled component.
- **Tailwind CSS v4** — CSS-first entrypoints use Kumo's stylesheet and semantic
  tokens. App-local CSS is limited to layout, viewport fallbacks, and feature
  composition; it does not recreate a generic design-system facade.
- **TanStack headless libraries** — Table, Virtual, and Form are direct app
  dependencies only where a surface needs those capabilities. Forms validate
  at the boundary with Effect Schema through Standard Schema.
- Built and shipped through the Vite+ workspace like any other application.

### Semantic token vocabulary

Kumo semantic classes such as `bg-kumo-base`, `bg-kumo-contrast`,
`text-kumo-strong`, `text-kumo-subtle`, `border-kumo-line`,
`border-kumo-hairline`, and `bg-kumo-success`/`bg-kumo-danger`/`bg-kumo-info`
carry the visual identity. The apps do not define private color-name classes;
Kumo remains the source of truth for color, contrast, and state.

### Feature compositions

Poligon owns `PoligonFigure`, `PoligonLegend`, `PoligonDataTable`,
`PoligonLogFeed`, and `PoligonTimeScrubber`. Maskirovka owns its hosted-seat,
gateway, and local operations forms, badges, feeds, and cards. These names are
feature-specific and may evolve with their owning surface; they are not a
replacement shared package.

### THREE.js Integration

The canvas is content and the chrome is Kumo: the Poligon viewport sits inside
an app-local figure composition, and every HUD overlay (unit tags, engagement
readouts, scenario picker) is DOM-styled with Kumo semantic tokens. No styles
are defined inside the scene layer.

### Rules

Import Kumo components and primitives directly, keep feature compositions local,
and use semantic token classes in both JSX and app CSS. Accessibility and
keyboard behavior come from the Kumo component or the explicitly selected
primitive. Every human surface keeps its Cloudflare Access gate.

---

## Phased Implementation

### Phase 1 — Foundation (MVP)
- [ ] Vite+ workspace scaffolding (`vp create` monorepo · TypeScript 7 native `tsgo` · wrangler.toml)
- [ ] **Transport boundary**: `Transport` interface with `RestTransport` — the only implementation
- [ ] Tick endpoint on the Orchestrator agent (`onRequest`: `POST /api/tick` → commands in response)
- [ ] Auth guard (Effect service — constant-time API-key validation)
- [ ] Human auth: Access apps + allowlist policies for `poligon.*` and `/admin/*`; Effect middleware verifying `Cf-Access-Jwt-Assertion` on HTTP + WS upgrades; synthetic dev identity for `wrangler dev`
- [ ] Protocol message schemas (Effect Schema) with delta/full snapshot support
- [ ] `OrchestratorAgent` (Agents SDK — one per faction) with basic game state model + delta tracking
- [ ] Simple rule-based commander (no LLM yet) — spawn units on timer
- [ ] Decision logging foundation — structured log entries to DO storage
- [ ] Mod: **`CommanderLink` interface** with `RestLink` implementation using AR's
      `RestApi` + `JsonApiStruct`, adaptive tick rate
- [ ] Mod: Audit AR Commander module API surface — test `SCR_AIGroup`, `AIWaypoint`,
      `AIOrder`, `SCR_GameModeCampaign` classes hands-on
- [x] ~~Mod: Wrap AR's spawn system~~ — Confirmed: prefab spawn → `SCR_AIGroup` (6 agents, async ~1s), `AIWaypoint_ForcedMove` for movement. Normal `AIWaypoint_Move` unreliable; `ForcedMove` required.
- [ ] Mod: Basic state reporting — extract objective, unit, and player data from AR systems
- [ ] Benchmark: REST round-trip latency (Hetzner ↔ CF edge), payload sizes, tick rate limits
- [x] ~~Validate: BattlEye compatibility with outbound REST calls from mod~~ — Confirmed in Workbench: GET, POST, headers, auth all work
- [ ] **Poligon**: `@stavka/sim-core` — deterministic world (groups · waypoints · combat · vehicles), quirk-faithful, seeded RNG, fixed 100 ms steps
- [ ] **Poligon**: `@stavka/sim-link` — TS twin of the mod's `CommanderLink` (state build → POST tick → parse → execute), 1:1 port map to Enforce
- [ ] **Poligon**: `apps/poligon` — `SimWorld` agent + **TanStack Start** viewer (R3F canvas, Effect-Schema'd scenario URLs, time-scale controls), one Worker via custom entrypoint
- [ ] Conformance fixtures: the Test 12 wire captures as the golden corpus, validated against sim-link output
- [ ] **Maskirovka**: `tools/maskirovka` skeleton — latest dialects only (`/v1/messages` + `/v1/responses`), tier aliases, `mock` seat, record/replay cache (CI never touches a paid seat)
- [x] **Direct Kumo frontend composition**: Kumo 2.9.2 styled components and primitives, semantic tokens, and app-local TanStack Table/Virtual/Form compositions across Poligon and Maskirovka surfaces
- [ ] Deploy: `wrangler deploy` to CF Workers; test against Poligon first, the Hetzner AR server when available
- **Goal**: Mod connects via HTTP through `CommanderLink`, reports state, commander spawns
  units via AR's native systems. Same tick, two fronts — Poligon goes green before
  any Windows time is spent.

### Phase 2 — LLM Integration
- [ ] `@effect/ai` provider layers (`-anthropic`, `-openai`) behind one language-model service
- [ ] **Maskirovka** live seats: `claude` (Agent SDK · subscription credit) + `codex` (Stavka direct Responses · ChatGPT OAuth) + `api` passthrough — named accounts, doctor, burst governor, savings meter, `AGENTS.md`/`CLAUDE.md` contract; **production seat registry** (push/pull registration, budget-aware API fallback); Container-hosted seat image (`maskirovka deploy-seat`)
- [ ] Commander prompt engineering (system prompt, state context formatting, response schema)
- [ ] LLM decision parsing and validation (Effect Schema)
- [ ] Tick-based decision loop (hybrid: scheduled + event-driven)
- [ ] Command planning (translate LLM output → AR `AIOrder` and `AIWaypoint` calls)
- [ ] Basic doctrine system (aggression, caution params injected into prompt)
- [ ] Three-layer memory system (working, short-term, long-term in DO storage)
- [ ] Full decision logging (every LLM call: input, output, cost, latency)
- **Goal**: LLM makes strategic decisions, AR's Commander module executes them.
  Every decision is logged for analysis.

### Phase 3 — Sergeant Sub-Agents & Reactivity
- [ ] Mod: Event significance filter (ROUTINE/NOTABLE/URGENT classification)
- [ ] Mod: Event batching — buffer NOTABLE events, immediate URGENT dispatch
- [ ] Mod: Sergeant data extraction — hook `SCR_AIGroup` events + `AIDangerEvent` system
- [ ] Commander: sergeant sub-agents (Agents SDK · Sonnet 5 / `gpt-5.6-luna`) — tactical decisions per group
- [ ] Poligon: fast-forward engagement scenarios (seeded, replayable) as the sergeant / commander eval suite
- [ ] Sergeant prompt engineering (narrow scope: this squad's situation only)
- [ ] Sergeant → mod command pipeline (reposition, take cover, etc. via AIOrder)
- [ ] Fog of war — commander only sees sergeant summaries, not raw game state
- [ ] Event-driven commander triggers (objective lost, mass casualties)
- [ ] Counterattack logic driven by sergeant reports
- [ ] Full unit behavior set (patrol, ambush, flank) via AR waypoints
- **Goal**: Realistic two-tier LLM command hierarchy. Sergeants handle tactics
  autonomously, commander handles strategy. Both tiers fully logged.

### Phase 4 — Terrain & Map Awareness
- [x] ~~Investigate AR terrain/navmesh scripting API~~ — `World.GetSurfaceY()` benchmarked: ~8K samples/ms, 10m grid on 4km² map = 20ms
- [ ] Terrain data extraction and grid representation (extract at load time, no cache needed)
- [ ] Map briefing upload → stored in CF KV (per map: Everon, Arland, Kolguev)
- [ ] Filter -256 sentinel values (out-of-bounds / ocean)
- [ ] LLM prompt integration — terrain-aware decisions (use high ground, avoid chokepoints)
- [ ] Key terrain feature identification (auto or manual markup)
- [ ] Cover classification (open, light, heavy, urban) — investigate `ChimeraCoverManagerComponent`
- **Goal**: Commander makes terrain-informed strategic decisions.

### Phase 5 — Multi-Commander & Player Integration
- [ ] Support multiple commander instances (one per faction, separate DOs)
- [ ] Commander-vs-commander mode
- [ ] Player task assignment via native `SCR_GameModeSFManager` task system
- [ ] Dynamic task creation from commander decisions (Move, Defend, Attack tasks)
- [ ] Players receive tasks from their faction's AI commander
- [ ] Difficulty scaling based on player count and performance
- [ ] Coordinate with Conflict mode's existing base defense AI (additive offensive layer)
- **Goal**: Full PvE, PvPvE, and AI-vs-AI scenarios with player participation.

### Phase 6 — Polish & Production
- [ ] Persistence — DO state survives commander restarts + reconnection handling
- [ ] Resource budget system with balancing (30-50 group scale)
- [ ] Adaptive difficulty (mid-session performance tracking)
- [ ] Decision replay tools and post-session analysis export
- [ ] Cost tracking dashboard (per session, per agent tier, per model)
- [ ] Performance profiling at 30-50 active AI groups
- [ ] Workshop preparation and distribution (public release)
- [ ] Server operator documentation (setup guide, config reference)
- **Goal**: Balanced, configurable, production-quality experience.


---

## Resolved Decisions

| Question | Decision |
|---|---|
| **Deployment** | **All-Cloudflare** — Workers · Durable Objects · Containers · KV/R2. Hetzner runs exactly one thing: the AR dedicated server + mod |
| **Language & compiler** | TypeScript 7 native (`tsgo`, the Go port — RC, ships as `tsc`) |
| **BattlEye** | Confirmed safe — REST calls tested from Workbench, headers + JSON + auth all work |
| **Distribution** | Public Workshop release (eventually) |
| **API security** | Pre-shared opaque API key (`sk-stavka-...`), `Authorization: Bearer` header, constant-time validation, HTTPS enforced by CF. One key per server, set via `wrangler secret put` + mod config. |
| **Dev loop** | Local dev first (Node + Vite+ `vp` + Wrangler), deploy remote when stable |
| **AI group scale** | 30-50 active groups (battalion-scale) |
| **Sergeant intelligence** | LLM sub-agent (fast tier — Sonnet 5 / `gpt-5.6-luna`) with rule-based event filter |
| **Conflict mode** | Coordinate — commander adds offensive layer, existing defense AI stays |
| **LLM model tiers** | Via `@effect/ai` layers: Fable 5 ∥ `gpt-5.6-sol` commander · Sonnet 5 ∥ `gpt-5.6-luna` sergeants · Opus 5 ∥ `gpt-5.6-terra` heavy. `gpt-5.6` is the current cost default. |
| **Terrain extraction** | Extract at load time (not cached). 10m grid: ~8K samples/ms, entire Everon ~120ms. Filter -256 sentinel values. |
| **Target maps** | Everon, Arland, Kolguev |
| **Player tasks** | Native `SCR_GameModeSFManager` task system |
| **Context management** | Three-layer memory (working, short-term, long-term) |
| **Decision logging** | Full structured logging of every LLM call to DO storage |
| **BattlEye + HTTP** | Low risk — built-in engine API, proven by existing mods. See RESEARCH.md §10 |
| **RestApi capabilities** | GET/POST/PUT/DELETE, custom headers via `SetHeaders("Key,Value,Key,Value")` comma format. Async callbacks required for reading responses (`RestCallback` + `GetData()`). Blocking `_now` methods unreliable for response data. |
| **CF Workers CPU** | Non-issue — LLM calls are I/O wait, state processing ~50-100ms/tick |
| **DO storage strategy** | One key per log entry, R2 export for long sessions |
| **Transport** | REST only — the WebSocket / native-plugin path was removed in Revision B |
| **Toolchain** | Vite+ (`vp`) — unified dev/test/lint/fmt + cached monorepo task runner (Turborepo retired) |
| **Validation & runtime** | Effect v4 — Schema wire contract, services/layers, structured concurrency |
| **Agent harness** | Cloudflare Agents SDK — parent orchestrator + sergeant sub-agents: typed bidirectional RPC, per-child SQLite, scheduling, hibernation |
| **Dev without the game** | Poligon proving ground — quirk-faithful deterministic sim behind the identical wire contract; macOS-first dev loop, graduation suite gates the real mod |
| **Sim topology** | `sim-core` is pure TS/Effect with three hosts — Vitest (CI fast-forward), `SimWorld` agent (hosted, authoritative), browser (offline); viewer syncs via Agents SDK WebSockets |
| **LLM seats** | Maskirovka — seat gateway for dev *and* production: BYO subscription seats (Claude Agent SDK credit · Codex ChatGPT sign-in) registered per deployment and hosted as Cloudflare Containers (or dialing in from home), `mock` seat + record/replay cache for $0 deterministic CI, metered API as automatic fallback |
| **Coding-agent DX** | Root `AGENTS.md` + `CLAUDE.md` contract — one start command, tier aliases, `/healthz` machine-readable seats, auto-generated `.dev.vars`; agents never plumb keys |
| **API dialects** | Latest only — OpenAI **Responses API** exclusively (legacy chat completions degrades `gpt-5.6-sol`); Anthropic Messages, latest version |
| **Frontend composition** | Direct granular `@cloudflare/kumo` 2.9.2 imports, Kumo semantic tokens, and app-local feature components across Poligon, Maskirovka, and future panels |
| **Human-surface auth** | Cloudflare Access in front of every dashboard/viewer/admin route (email OTP / GitHub, allowlist, free ≤ 50 users) + in-Worker JWT verification on HTTP and WS; service tokens for headless clients; machine wire keys unchanged. Clerk / Better Auth reserved for a hypothetical public multi-tenant future |
| **Frontend stack** | Everything TanStack — Start for all deployed apps (on Workers, sharing the Worker with the agents via custom entrypoint), Router with Effect-Schema'd search params (URLs are repro cases), Query for request/response data (real-time stays on Agents SDK sync), direct Table/Virtual/Form dependencies only where a surface needs them, and Kumo for styled controls |

## Open Questions

### Resolved (moved from open)

| # | Question | Resolution |
|---|---|---|
| 1 | BattlEye + outbound HTTP | **Confirmed safe.** Tested in Workbench: outbound HTTP/HTTPS, custom headers, JSON POST, auth Bearer — all work. See RESEARCH.md §10. |
| 2 | AR RestApi to remote host | **Confirmed and tested.** SetHeaders uses comma-delimited pairs. Auth + Content-Type headers arrive correctly. JSON POST body intact. Must use async `RestCallback` + `GetData()` — `_now` methods don't return server responses reliably. |
| 3 | CF Workers CPU limits | **Non-issue.** 30s CPU (paid). LLM calls are I/O wait (free). Schema decode + state processing ~50-100ms/tick. Benchmark in Phase 2 to confirm. |
| 4 | DO storage limits | **Manageable.** 128KB/key, unlimited keys. One key per decision log (~1-2KB each). Export to R2 bucket for long sessions. |
| 5 | REST API data limits | **Non-issue for ticks.** 1MB limit, we target <50KB deltas. Full snapshot ~100-200KB at 50 groups. Terrain upload chunked if needed (one-time). |
| 6 | Native-plugin transport + BattlEye | **Retired (Revision B).** The native-plugin path was cut from the product; REST is the sole transport. |
| 7 | Native-plugin distribution | **Retired (Revision B).** No plugin ships; nothing to distribute beyond the mod itself. |
| 8 | Terrain data extraction | **Trivially fast.** Benchmarked on ~4km² Game Master map: 160K samples (10m grid) in 20ms, rate ~8K samples/ms. Everon (~10km²) extrapolates to ~1M samples in ~120ms. **Extract at load time, no cache files needed.** Note: `min=-256` is out-of-bounds sentinel, filter during extraction. |
| 9 | AI group spawn + waypoint | **Confirmed.** `SCR_AIGroup` spawns from prefab with 6 agents (async, ~1s). `AIWaypoint_Move` broken (idle). **ForcedMove, Attack, Defend, SearchAndDestroy, Patrol all work** via `AddWaypoint()`. Use `CallLater()` for delayed assignment. |
| 10 | Group enumeration | **No engine API exists.** `AIWorld.GetAIGroupCount()`, `QueryEntitiesByClassName` don't compile. Groups aren't spatial entities. Character→Group trace works (21K entity scan) but too slow. **Mod must maintain its own group registry array.** |
| 11 | Health / alive status | **Confirmed.** `SCR_CharacterDamageManagerComponent.GetHealth()`, `.IsDestroyed()`, `CharacterControllerComponent.IsDead()` all work. Dead agents auto-remove from `GetAgents()`. **Groups auto-delete when all agents die** — registry must null-check. `GetAgentsCount()` is the only metric needed for state extraction. |
| 12 | Vehicle spawn + boarding | **Confirmed full lifecycle.** UAZ469 `{259EE7B78C51B624}` spawns with 5 compartments, 2000 HP. `GetInNearest` → board (~25s). `ForcedMove` → AI drives vehicle to destination. `GetOut` → dismount (~9s). Full mechanized sequence works: board → drive → dismount → infantry orders. |
| 13 | Event hooks | **Confirmed.** `group.GetOnAgentRemoved().Insert(callback)` fires on death with group + agent refs. `GetOnAgentAdded()` also hooks. `GetOnDamage()` exists but callback takes `BaseDamageContext` (not individual params). Agent removal is sufficient for Phase 1 casualty tracking — no polling needed. |
| 14 | Combat engagement | **Confirmed.** AI does NOT auto-engage at 150m — Attack waypoints required. Groups advance, take cover, engage cautiously. 1 kill in 2min at ~75m (6v4). Combat is attritional, not instant. `OnAgentRemoved` fires correctly during combat. Commander must always issue explicit orders. |
| 15 | Full round-trip REST | **Confirmed.** Mod builds state JSON → POST to server with auth → receives JSON response → parses commands → executes (move_group, spawn_group). Callback must be `ref` member (GC risk). `string.Format` limited to 9 params. JSON parsing via IndexOf/Substring/Split/ToFloat works. Complete commander loop proven. |

### Needs Hands-On Testing

- **SCR_GameModeSFManager dynamic tasks**: Can we create/remove tasks programmatically
  at runtime, or only editor-placed? Need to inspect the API. **Test in Phase 5.**
- **Performance at 50 groups**: AR's AI group ceiling on Hetzner hardware. Profile with
  30, 40, 50 active groups measuring server FPS and network load. **Test in Phase 1-2.**
- **Sergeant LLM latency**: provider rate limits and fast-tier (Sonnet 5 / `gpt-5.6-luna`) response times under burst
  load (~150-300 calls/min). Synthetic load test. **Test in Phase 3.**
- **Conflict defense AI coordination**: Can we query or control Conflict mode's existing
  remnant/defense groups via `SCR_GameModeCampaign`? Need runtime inspection to see if
  we can avoid conflicts with commander's offensive groups. **Explore in Phase 1.**


---

# Part II — Engine Research (Enfusion / Enforce Script)

## 1. Communication: How Commander ↔ Mod Can Talk

### Available Options in Enforce Script

**REST API (Built-in)**
- AR has a built-in `RestApi` scripting API for HTTP requests
- Created via `GetGame().GetRestApi().GetContext("https://host/")`
- Supports: GET, POST, PUT, DELETE (both async callback and blocking `_now` variants)
- `SetHeaders("Key,Value,Key,Value")` — comma-delimited pairs for custom headers
- Async callbacks via `RestCallback`: `SetOnSuccess()` / `SetOnError()`, read response via `GetData()`
- ⚠️ Blocking `_now` methods unreliable for reading responses — use async callbacks
- `FILE()` / `FILE_now()` methods for file downloads
- **Limitations**: HTTP request/response only, max 1MB data per request
- This is a **client** — the mod can call OUT to external services, not serve them
- **Tested**: Authorization Bearer, Content-Type JSON, POST body all confirmed working

**JsonApiStruct (Built-in)**
- Full JSON serialization/deserialization support
- Can encode/decode script objects to/from JSON
- `RegV()` method to register variables for auto-conversion
- Import/export from files and strings
- This is the data layer for any communication approach

**File I/O**
- Enforce Script can read/write files (JSON, text)
- Used by some mods for data persistence
- Could be used for polling-based communication (crude)

Given that Enforce Script only supports HTTP GET/POST (no raw sockets,
no TCP/UDP access), the **MVP communication** uses **aggressively optimized REST polling**:

**Confirmed: No socket access of any kind in Enforce Script.**
- No raw TCP/UDP sockets
- No low-level networking primitives
- DayZ modding community confirms the same limitation (same Enfusion engine)

**Phase 1 approach: Single-endpoint tick with optimizations**

```
Mod tick (adaptive 300ms–2s):
  POST /api/tick
  Body:    { delta_state, sergeant_reports, events, command_results }
  Response: { commands[], tick_rate_hint, request_full_snapshot }
```

Key optimizations:
1. **Single round-trip per tick** — commands return in the POST response (no separate GET)
2. **Delta state updates** — only changed data sent after initial full snapshot
3. **Compact JSON** — short field names, omit defaults, array-of-arrays for bulk data
4. **Adaptive tick rate** — 2s idle, 750ms active, 300ms burst on priority events
5. **Server-side command batching** — multiple LLM decisions in one response
6. **Tick rate hints** — commander can tell mod to speed up/slow down

Target: <50KB per tick, <500ms round-trip on localhost, <100ms on loopback.

### Native-Plugin Transport — Investigated and Cut

A C++ native-plugin path for real-time transport was researched in depth
(BattlEye implications, plugin templates, script bindings) and **removed from
the product in Revision B**. REST over the engine's built-in `RestApi` is the
sole transport; the full investigation is preserved in the session transcripts.

## 2. AI System — What AR Exposes

### Core AI Classes (from Script API)

**AIAgent** — Base AI entity (individual soldier)
- Has: controlled entity, pathfinding, behavior tree, combat properties
- Can send/receive `AIMessage` and `AIOrder`

**AIGroup / ChimeraAIGroup / SCR_AIGroup** — Group of AI agents
- The primary unit of control (squad level)
- Has: leader, agents list, current waypoint, formation
- Events: `OnLeaderChanged`, `OnWaypointAdded`, `OnWaypointCompleted`, `OnWaypointRemoved`
- Can get player count, agent count, slave/master groups
- Server-side only for events

**AIWaypoint / SCR_AIWaypoint** — Waypoint system
- Types implemented: `SCR_DefendWaypoint`, `SCR_AIWaypointArtillerySupport`,
  `SCR_SuppressWaypoint`, `SCR_SmartActionWaypoint`, `SCR_DeploySmokeCoverWaypoint`,
  `SCR_LoadSuppliesWaypoint`, `SCR_UnloadSuppliesWaypoint`
- Waypoint Cycle: `AIWaypointCycle` for repeated patrol routes
- Completion types: `All` (all members reach), `Leader` (leader reaches), `Any`

**AIOrder** — Order system
- `EAIOrderType`: None, Hold, Move, Follow, Rearm, Defend, GetIn, Attack, Custom
- Can send orders between agents and groups
- This is the key mechanism for commanding AI groups!

**AIFormationComponent** — Formations
- Groups can have formations set via component

**AIDangerEvent** — Threat detection system
- Types: NewEnemy, DamageTaken, ProjectileHit, LostTarget, GrenadeLanding,
  WeaponFire, Vehicle, Explosion, etc.
- This is what drives AI reactions — we can hook into these for sergeant reports!

**AIPathfindingComponent / ChimeraAIPathfindingComponent** — Pathfinding
- Per-agent/vehicle pathfinding
- Vehicle-specific filters can be set

**AIWorld / SCR_AIWorld / ChimeraAIWorld** — World-level AI management
- Contains NavmeshWorldComponent
- Can regenerate navmesh in areas
- Has event for group control mode changes
- TagSystem for spatial queries

**AICommunicationComponent** — AI communication
- Can be used for inter-agent messaging

**EAIUnitType** — Unit classification
- Infantry, VehicleUnarmored, VehicleMedium, VehicleHeavy, Aircraft, Fortification

### Key Waypoint Types for Our Commander

| Waypoint | Purpose |
|---|---|
| Move (AITaskGroupMove) | Move group to position |
| Defend (SCR_DefendWaypoint) | Defend position |
| Attack (implied via AIOrder_Attack) | Attack position/enemy |
| Cycle (AIWaypointCycle) | Repeated patrol routes |
| Smart Action | Context-dependent action at position |
| Suppress | Suppress target area |

### Spawning AI Groups

From SCR_ScenarioFrameworkSlotAI, the spawning process:
1. Create AI group entity with faction
2. Add agents (soldiers) from prefabs to group
3. Set formation, combat parameters
4. Add waypoints to group
5. Group AI takes over using behavior tree

The `SCR_CatalogEntitySpawnerComponent` handles spawning from catalogs:
- Uses supply/resource system
- Returns waypoint for rally point
- Supports preview/visualization

---

## 3. Game Mode — Conflict (Campaign) System

### SCR_GameModeCampaign (Conflict)

The Conflict game mode (internally "Campaign") has:

- **SCR_CampaignMilitaryBaseComponent** — Base/objective system with radio ranges
- **Faction system** — BLUFOR/OPFOR/INDFOR with campaign-specific configs
- **Remnant groups** — AI patrol/defense forces spawned around bases
- **Radio antenna range** — Determines which objectives can be captured (must be in radio range)
- **Supply/resource system** — Building, construction, logistics
- **Vehicle request system** — Request vehicles from depots

### Key Finding: AI Already Defends But Cannot Attack
From official docs:
> "Currently BLUFOR & OPFOR AI forces are only assigned to base defence and cannot
> capture bases on their own."

**This is exactly the gap we're filling!** AR's existing AI can defend but lacks
strategic offensive capability. Our AI Commander adds the attacking brain.

### What We Can Reuse from Conflict
- Base/objective system (positions, capture state, radio range)
- Faction management
- AI defense group spawning (already works)
- Supply/resource system
- Vehicle depot system
- Respawn system

---

## 4. NavMesh & Terrain

### NavMesh System
- Managed by `NavmeshWorldComponent` on `SCR_AIWorld` entity
- Separate navmeshes: **Soldiers** (infantry), **BTRLike** (vehicles), **LowRes** (overview)
- Vehicle navmesh is functional as of 1.2 (AI driving works)
- NavMesh streaming available for memory optimization
- **Can regenerate navmesh at runtime** via `SCR_AIWorld`

### Terrain Data
- `World.GetSurfaceY(x, z)` — Get terrain height at position
- Raycasting available via physics system
- TagSystem provides spatial indexing
- Cover system: `ChimeraCoverManagerComponent` / `CoverManagerComponent`
  - Can query cover points at runtime!
  - AI uses this for tactical positioning

### What We Can Extract for Commander
- Terrain height grid (via sampling `GetSurfaceY`)
- Cover density (via CoverManager queries)
- NavMesh accessibility (via pathfinding queries)
- Road network (used for vehicle AI)

---

## 5. Multiplayer & Networking

### Architecture
- Classical server-client (no peer-to-peer, no headless client)
- Server is authoritative
- RPC (Remote Procedure Call) for network messages
- Replication system for entity sync
- Player-hosted (listen server) or dedicated server
- **No distributed server support**

### Implications for Our Mod
- Our mod must run **server-side only** (authority)
- State reporting, command execution, AI spawning — all server authority
- REST API calls from mod → commander server must happen on server
- Players don't need the mod installed (server-side only) — BUT they do need it
  for any client-side UI (task markers, commander orders display)

---

## 6. Scenario Framework

### SCR_GameModeSFManager
- Built-in framework for creating dynamic scenarios
- Supports: task creation, objective management, AI spawning, triggers
- Task types: Move, Kill, Destroy, Interact, custom
- Layers system for organizing content
- Actions system for trigger → response logic
- Debug suite for testing

### Relevance
This is the existing "mission building" framework. We can potentially:
- Use its task system to assign objectives to players
- Leverage its AI spawning slots
- Hook into its event system for triggers

---

## 7. Existing Mods of Interest

### Game Master Enhanced (GME)
- Expands GM capabilities
- Adds: save/load, AI formation/stance/skill attributes, cycle waypoints
- Shows what's possible with modding the editor systems

### Conflict: Escalation
- Major Conflict overhaul with dynamic systems
- Squad XP, suppression, MHQ deployment
- Shows how to deeply modify the Conflict game mode
- Configurable scenarios, auto-faction patrols

### Enforce Script Extensions (ESE)
- Utility library with entity management, file I/O, math helpers
- Potential dependency for convenience functions

---

## 8. Critical Findings & Architecture Impact

### Communication: REST, Full Stop

The mod dials out over the engine's first-party `RestApi` (HTTP only — no raw
sockets exist in Enforce Script). A single `POST /api/tick` carries state up
and commands back in one round trip — validated end-to-end in Workbench,
BattlEye-safe by construction. There is no second transport phase.

### Game Master Is the Right Abstraction Layer
The Game Master (Editor) system is the "god mode" interface for Arma Reforger.
It already supports:
- Spawning any entity
- Setting waypoints
- Modifying entity properties
- Managing objectives

Our AI Commander essentially automates Game Master actions. The mod should
interface with the editor/GM systems rather than lower-level entity APIs.

### SCR_GameModeCampaign Is the Base
The Conflict game mode is our starting point. We:
1. Keep the Conflict game mode (bases, objectives, factions, supplies)
2. Add our orchestration component as a server-side mod
3. The AI Commander drives the OPFOR faction using existing campaign systems
4. Players experience a "smarter" enemy that actually attacks and maneuvers

### Fog of War Is Natural
AR's AI perception system (DangerEvents, target tracking) already limits
what individual AI units "know". Sergeant reports can be built from:
- Group's known contacts (from perception system)
- DangerEvent history
- Waypoint completion status
- Casualty tracking

This is not simulated fog of war — it's built on actual game-state perception.

---

## 9. Updated Tech Stack for Mod Side

| Component | AR System | Notes |
|---|---|---|
| Communication | RestApi + JsonApiStruct | HTTP GET/POST to commander (CF Workers) |
| AI Groups | SCR_AIGroup + AIWaypoint | Standard group/waypoint system |
| Spawning | SCR_CatalogEntitySpawnerComponent | Or direct prefab spawning |
| Orders | AIOrder (Attack, Defend, Move, etc.) | Sent to groups |
| Game Mode | SCR_GameModeCampaign (Conflict) | Base game mode |
| Objectives | SCR_CampaignMilitaryBaseComponent | Existing objective system |
| Terrain | World surface queries + CoverManager | Height, cover, navmesh |
| Perception | AIDangerEvent + perception system | For sergeant reports |
| Tasks (Players) | SCR_GameModeSFManager tasks | Show objectives to players |

---

## 10. BattlEye + Outbound HTTP from Server Mods

### Question

Will BattlEye block or flag the mod's outbound HTTP calls from the AR dedicated
server to a remote Cloudflare Workers endpoint?

### Finding: LOW RISK — Almost certainly safe

**Evidence strongly suggests BattlEye does NOT interfere with server-side outbound HTTP
using the engine's built-in RestApi.**

#### 1. RestApi is a first-party Enfusion engine feature

The `RestContext` class is part of the Enfusion engine's `GameLib` (implemented in C++,
exposed to Enforce Script). It supports GET, POST, PUT, DELETE, custom headers via
`SetHeaders()`, async callbacks, and file downloads. The official BI wiki example uses
`https://httpbin.org/` as the target URL — confirming arbitrary remote endpoints are
supported by design.

Source: BI Community Wiki "Arma_Reforger:REST_API_Usage", Enfusion Script API reference
for `RestContext` interface (GameLib/generated/online/RestContext.c).

#### 2. Existing AR mods already make outbound HTTP calls on BE-enabled servers

- **PG - RestApi** (Workshop ID: 626F012CCC661DFA) — Sends HTTP requests to Discord
  channels for logging player joins, spawns, chat. Requires a companion JS server.
  Published Sep 2024, listed for game version 1.2.0.
- **ReforgerWhitelist** — Server-side mod that makes HTTP calls to an external API
  for player whitelist verification. Multiple implementations on GitHub.
- These mods would not exist or function if BattlEye blocked outbound HTTP.

#### 3. DayZ (same engine, same BattlEye) uses RestApi extensively

DayZ uses the same Enfusion engine and BattlEye integration. The DayZ modding ecosystem
has widespread RestApi usage for external server communication:

- **CRDTN Core** — Framework mod with full RestApi wrapper for external databases,
  authentication servers, and shop systems. Used across many DayZ servers.
- **DayZ Universal API** (Steam Workshop) — Complete backend API framework allowing
  mods to communicate with external web services for cross-server data, player
  statistics, and authentication. 600+ favorites on Steam Workshop.
- **Multiple commercial DayZ mods** use RestApi to phone-home for license verification,
  connecting to developer-operated backend servers.

All of these work on BattlEye-enabled servers (BattlEye is mandatory on DayZ and
cannot be disabled on public servers).

#### 4. BattlEye's architecture targets client-side cheating, not server HTTP

BattlEye's documented architecture focuses on:
- **Client-side**: DLL injection blocking, memory scanning, process monitoring,
  kernel-mode driver for anti-tamper. This is where all the protective scanning happens.
- **Server-side**: RCon administration, player monitoring, ban enforcement,
  client response verification. The server component does NOT scan or restrict
  the game server process's own network activity.

BattlEye blocks things like unauthorized DLLs loading into the game process (see:
opentrack/NPClient64.dll being blocked on client-side). But server-side scripts using
the engine's own built-in HTTP client are fundamentally different — they're using a
sanctioned engine API, not injecting foreign code.

#### 5. The HTTP calls originate from the engine itself

When our mod calls `GetGame().GetRestApi().GetContext(url).POST(...)`, the actual HTTP
request is made by the C++ Enfusion engine code, not by injected or external code.
From BattlEye's perspective, this is indistinguishable from the game's own network
activity (which already makes HTTP calls for Workshop downloads, server browser
registration, and other built-in features).

### Remaining Minor Risks

| Risk | Likelihood | Mitigation |
|---|---|---|
| Server firewall blocks outbound HTTPS | Low | Standard Hetzner config allows outbound; verify port 443 |
| AR RestApi has undocumented URL restrictions | Very Low | Official example uses httpbin.org; PG-RestApi uses Discord URLs |
| BattlEye update adds server-side HTTP monitoring | Very Low | Would break existing ecosystem of mods; extremely unlikely |
| RestApi reliability under high-frequency polling | Unknown | Needs stress testing — separate concern from BE |

### Risk Downgrade

**Previous assessment**: BattlEye blocking REST calls — **High risk**
**Revised assessment**: **No risk** — Hands-on testing confirms all RestApi features work
from Workbench. GET, POST, custom headers, Authorization Bearer, JSON content-type all
verified against both httpbin.org (HTTPS) and localhost (HTTP). Multiple existing mods
confirm this works on BE-enabled dedicated servers.

### Also Fixed: Custom Headers

Previous research noted "no custom headers" as a limitation. This was incorrect.
`RestContext.SetHeaders()` exists in the API. This means we CAN send an
`Authorization: Bearer <key>` header directly — no need for URL params or body-based auth.

### Hands-On RestApi Testing (Workbench 1.6.0.119)

Conducted live testing from Enfusion Workbench against both httpbin.org and localhost
Node.js server to confirm exact behavior. Results:

**SetHeaders format**: Comma-delimited key,value pairs as a single string.
```csharp
ctx.SetHeaders("Content-Type,application/json,Authorization,Bearer sk-stavka-test123");
```
The wiki says "no support for custom headers" — **this is wrong**. SetHeaders works.
Error message `"Number of strings must be even!"` confirms internal parsing splits on commas
and expects paired entries.

**Confirmed on the wire** (Node.js server logs):
```
authorization: Bearer sk-stavka-test123
content-type: application/json
```
Both headers arrive correctly. JSON POST body arrives intact.

**Blocking `_now` methods are unreliable for responses:**
- `GET_now()` returns empty string after `reset()` or context reuse
- `POST_now()` returns the sent body, not the server response
- These may work for fire-and-forget but cannot be used to read responses

**Async callbacks work correctly:**
```csharp
class StavkaRestCallback : RestCallback
{
    void StavkaRestCallback()
    {
        SetOnSuccess(OnSuccess);
        SetOnError(OnError);
    }
    void OnSuccess() { string data = GetData(); }  // Contains server response
    void OnError()   { /* handle error */ }
}

ctx.GET(callback, "/endpoint");           // Async GET
ctx.POST(callback, "/endpoint", body);    // Async POST
```
`GetData()` returns the full server response body. Callbacks fire on subsequent frames.

**Summary of RestApi capabilities (confirmed by testing):**

| Feature | Status | Notes |
|---------|--------|-------|
| GET | ✅ | Works with async callback |
| POST + JSON body | ✅ | Body arrives intact |
| PUT / DELETE | ✅ | In API, not yet tested |
| Custom headers | ✅ | `SetHeaders("K,V,K,V")` comma format |
| Authorization header | ✅ | Bearer token arrives correctly |
| Content-Type header | ✅ | application/json works |
| Async callbacks | ✅ | `RestCallback` + `GetData()` |
| Blocking `_now` response | ⚠️ | Unreliable — don't use for reading responses |
| HTTPS (remote) | ✅ | httpbin.org works |
| HTTP (localhost) | ✅ | localhost:3000 works |
| File download | Untested | `FILE` / `FILE_now` methods exist |

**For stavka**: Use async `POST(callback, ...)` for all mod→commander communication.
Set headers once on context creation. Read responses via `GetData()` in success callback.

---

## 11. Risk Assessment

| Risk | Impact | Mitigation |
|---|---|---|
| REST API 1MB limit | Medium | Compress/paginate state snapshots |
| REST API latency (polling) | Low | Strategic decisions don't need <1s latency |
| REST API reliability under load | Medium | Stress test early; adaptive tick rate + retry logic |
| Navmesh/terrain data volume | Medium | One-time extraction, cache in CF KV/DO |
| BattlEye blocking REST calls | ~~High~~ **None** | Hands-on tested: GET, POST, headers, auth all confirmed working (see §10) |
| Conflict mode complexity | Medium | Start with minimal hooks, expand gradually |
| AI group limits | Medium | Hard cap + performance testing |
| Enforce Script debugging | Medium | Use Diag executables + Workbench debugger |

---

## 12. AI Group Spawning & Waypoint Testing (Hands-On)

Tested in Workbench 1.6.0.119, Game Master scenario on Arland.

### Group Spawning

- **Prefab**: `{E552DABF3636C2AD}Prefabs/Groups/OPFOR/Group_USSR_RifleSquad.et`
- `GetGame().SpawnEntityPrefab()` returns `SCR_AIGroup` entity
- **Agents spawn asynchronously** — ~1 second (60 frames) after group entity creation
- Must poll `GetAgentsCount() > 0 && !IsInitializing()` before assigning orders
- Group spawns with 6 agents (rifle squad)
- `GetLeaderAgent()` → `GetControlledEntity()` → `GetOrigin()` works for position tracking
- `SCR_AIGroupUtilityComponent` present and accessible via `GetGroupUtilityComponent()`
- Cannot use `ref` keyword with `SCR_AIGroup` (managed class)

### Waypoint Assignment — Critical Finding

**`AIWaypoint_Move` DOES NOT WORK.** The AI group stays in `SCR_AIIdleActivity` and
does not execute normal move waypoints assigned via `AddWaypoint()`. This appears to be
an engine/behavior tree issue — the utility component never transitions from idle to move.

**`AIWaypoint_ForcedMove` WORKS.** Using `{06E1B6EBD480C6E0}Prefabs/AI/Waypoints/AIWaypoint_ForcedMove.et`
makes groups move to the waypoint position reliably.

This matches Game Master behavior — GM uses ForcedMove for its waypoint commands.

### Waypoint API Details

```csharp
// Spawn waypoint
Resource wpRes = Resource.Load("{06E1B6EBD480C6E0}Prefabs/AI/Waypoints/AIWaypoint_ForcedMove.et");
IEntity wpEnt = GetGame().SpawnEntityPrefab(wpRes, world, params);
AIWaypoint wp = AIWaypoint.Cast(wpEnt);

// Configure before adding to group
wp.SetCompletionRadius(30);

// Assign to group (group must be fully initialized)
group.AddWaypoint(wp);

// Verify
AIWaypoint curWP = group.GetCurrentWaypoint();  // Returns the active waypoint
```

### Confirmed Prefab GUIDs

| Prefab | GUID | Status |
|--------|------|--------|
| USSR Rifle Squad | `{E552DABF3636C2AD}Prefabs/Groups/OPFOR/Group_USSR_RifleSquad.et` | ✅ |
| US Fire Team | `{84E5BBAB25EA23E5}Prefabs/Groups/BLUFOR/Group_US_FireTeam.et` | Untested |
| ForcedMove | `{06E1B6EBD480C6E0}Prefabs/AI/Waypoints/AIWaypoint_ForcedMove.et` | ✅ Works |
| Attack | `{1B0E3436C30FA211}Prefabs/AI/Waypoints/AIWaypoint_Attack.et` | ✅ Works |
| Defend | `{93291E72AC23930F}Prefabs/AI/Waypoints/AIWaypoint_Defend.et` | ✅ Works |
| SearchAndDestroy | `{B3E7B8DC2BAB8ACC}Prefabs/AI/Waypoints/AIWaypoint_SearchAndDestroy.et` | ✅ Works |
| Patrol | `{22A875E30470BD4F}Prefabs/AI/Waypoints/AIWaypoint_Patrol.et` | ✅ Works |
| Move | `{750A8D1695BD6998}Prefabs/AI/Waypoints/AIWaypoint_Move.et` | ❌ Broken (idle) |
| Cycle | `{35BD6541CBB8AC08}Prefabs/AI/Waypoints/AIWaypoint_Cycle.et` | Untested |
| Follow | `{A0509D3C4DD4475E}Prefabs/AI/Waypoints/AIWaypoint_Follow.et` | Untested |
| GetIn | `{712F4795CF8B91C7}Prefabs/AI/Waypoints/AIWaypoint_GetIn.et` | Loads (untested behavior) |
| GetOut | `{C40316EE26846CAB}Prefabs/AI/Waypoints/AIWaypoint_GetOut.et` | ✅ Works (→ SCR_BoardingWaypoint) |
| Wait | `{531EC45063C1F57B}Prefabs/AI/Waypoints/AIWaypoint_Wait.et` | Untested |
| Scout | `{A88F0B6CF25BD1DE}Prefabs/AI/Waypoints/AIWaypoint_Scout.et` | Untested |
| Suppress | `{ED8277F35B46B4AA}Prefabs/AI/Waypoints/AIWaypoint_Suppress.et` | Untested |
| GetInNearest | `{B049D4C74FBC0C4D}Prefabs/AI/Waypoints/AIWaypoint_GetInNearest.et` | ✅ Works (→ SCR_BoardingTimedWaypoint) |
| GetInSelected | `{8AD8C82346156494}Prefabs/AI/Waypoints/AIWaypoint_GetInSelected.et` | Loads (untested behavior) |
| UAZ469 | `{259EE7B78C51B624}Prefabs/Vehicles/Wheeled/UAZ469/UAZ469.et` | ✅ Works (5 slots, 2000 HP) |
| USSR Fire Group (Guard) | `{6F72F05752ED62A8}Prefabs/Groups/OPFOR/Group_USSR_FireGroup_Guard.et` | ✅ Works (4 agents) |

### Waypoint Behavior Observations

Tested 4 waypoint types simultaneously on Arland, 4 USSR Rifle Squads:

- **Attack**: Moves steadily toward waypoint (~6m/3s). Aggressive movement.
- **Defend**: Holds position with minor drift (~8m over 20s). Patrols small area around waypoint.
- **SearchAndDestroy**: Moves toward waypoint (~6m/3s) while scanning. Similar speed to Attack.
- **Patrol**: Wanders around waypoint area, not beelining. Explores the vicinity.

No `ForcedAttack` or `ForcedDefend` variants exist — only `ForcedMove`.
Normal `Move` is the only broken waypoint type; all tactical waypoints work via `AddWaypoint()`.

### For Stavka

- All `move_group` commands must use `ForcedMove` waypoint
- Always wait for `IsInitializing() == false` before assigning waypoints
- Track group positions via leader agent polling
- Waypoint GUIDs should be configurable (in case they change across versions)

### Group Despawn & Order Reassignment

Tested multi-group lifecycle: spawn 3 groups, despawn one, reassign another.

**Despawn procedure** (confirmed working):
```csharp
// 1. Delete all agent entities
array<AIAgent> agents = {};
group.GetAgents(agents);
foreach (AIAgent agent : agents)
{
    IEntity ent = agent.GetControlledEntity();
    if (ent)
        SCR_EntityHelper.DeleteEntityAndChildren(ent);
}
// 2. Delete the group entity
SCR_EntityHelper.DeleteEntityAndChildren(group);
group = null;
```

- Delete agents first, then group entity
- No crashes or side effects — other groups continue unaffected
- Null check on group reference works after deletion

**Order reassignment** (confirmed working):
```csharp
// Remove old waypoint
AIWaypoint curWP = group.GetCurrentWaypoint();
group.RemoveWaypoint(curWP);
SCR_EntityHelper.DeleteEntityAndChildren(curWP);

// Assign new waypoint
AIWaypoint newWP = SpawnWaypoint(prefab, pos, radius);
group.AddWaypoint(newWP);
```

- `RemoveWaypoint()` + `AddWaypoint()` works for changing orders
- Group immediately transitions to new behavior (e.g. ForcedMove → Defend)
- Clean up old waypoint entity to avoid leaks

**`CallLater()` confirmed**: `GetGame().GetCallqueue().CallLater(method, ms, false)` works
for delayed execution — cleaner than frame-counting for timed sequences.

### State Extraction (World → JSON)

Full state extraction tested: enumerate all AI groups, build JSON payload.

**Working APIs**:
- `GetGame().GetAIWorld()` → `AIWorld` (not null)
- `AIWorld.GetAIGroupCount()` → int (indexed enumeration)
- `AIWorld.GetAIGroup(i)` → `AIGroup` (cast to `SCR_AIGroup`)
- `group.GetFaction().GetFactionKey()` → `"USSR"`, `"US"` etc.
- `group.GetLeaderAgent().GetControlledEntity().GetOrigin()` → leader position
- `group.GetCurrentWaypoint()` → `AIWaypoint` with `.Type()` and `.GetOrigin()`
- `group.GetAgents(array<AIAgent>)` → per-agent enumeration
- `agent.GetControlledEntity().GetOrigin()` → individual soldier position
- `ent.GetPrefabData().GetPrefabName()` → full prefab path (e.g. `Character_USSR_SL.et`)
- `System.GetTickCount()` → engine tick as integer

**JSON payload size**: ~890 bytes per group (6 agents with positions + prefabs).
20-group battle ≈ 18KB per tick — trivially small.

**Squad roles visible from prefabs**: SL (Squad Leader), AR (Automatic Rifleman),
AT (Anti-Tank), AAT (Assistant AT), SR (Sharpshooter), LAT (Light AT).

**Production optimization**: Per-member positions likely unnecessary for commander decisions.
Group-level payload (leader pos, agent count, waypoint, faction) ≈ 200 bytes/group.
Send member details only on demand or at lower frequency.

### Group Enumeration — What Works and What Doesn't

**APIs that DO NOT EXIST in Enforce Script** (compile errors):
- `AIWorld.GetAIGroupCount()` / `AIWorld.GetAIGroup(i)` — no indexed group access
- `QueryEntitiesByClassName("SCR_AIGroup")` — method doesn't exist
- Groups are NOT spatial entities — `QueryEntitiesBySphere` doesn't find them

**Working discovery method** — Character → Group trace:
```
QueryEntitiesBySphere → find SCR_ChimeraCharacter
  → FindComponent(AIControlComponent) → GetAIAgent()
    → GetParentGroup() → SCR_AIGroup (deduplicate in set)
```
Works but scans 21,540 entities to find 16 characters → 3 groups. Too expensive per tick.

**`SCR_AIWorld`** is accessible: `SCR_AIWorld.Cast(GetGame().GetAIWorld())` succeeds.

[DECISION] **Mod must maintain its own group registry.** When the commander issues
`spawn_group`, the mod tracks the `SCR_AIGroup` reference in an internal array.
State extraction iterates this array — never scans the world. Character→Group trace
is a fallback/debug tool only.

### Confirmed Faction Keys & Squad Compositions

**OPFOR — USSR Rifle Squad** (`Group_USSR_RifleSquad.et`): 6 agents
- SL (Squad Leader), AR (Auto Rifleman), AT (Anti-Tank)
- AAT (Assistant AT), SR (Sharpshooter), LAT (Light AT)

**BLUFOR — US Fire Team** (`Group_US_FireTeam.et`): 4 agents
- TL (Team Leader), AR (Auto Rifleman), GL (Grenadier), LAT (Light AT)

### Health & Alive Status

**Working health APIs** (all on `SCR_CharacterDamageManagerComponent`):
- `GetHealth()` → float (100 = full)
- `GetMaxHealth()` → float (100)
- `GetState()` → EDamageState enum: 0=healthy, 2=destroyed
- `IsDestroyed()` → bool
- `Kill(Instigator.CreateInstigator(null))` → instant kill

**Alternative**: `CharacterControllerComponent.IsDead()` → bool (also works)

**Component hierarchy**: `DamageManagerComponent` (base) → `SCR_DamageManagerComponent` → `SCR_CharacterDamageManagerComponent`. Characters have the most specific subclass. All three are findable via `FindComponent()`.

**Dead agent behavior**:
- Dead agents are **automatically removed** from `GetAgents()` — agent count drops immediately
- `Kill()` warning about instigator context is harmless (cosmetic log)
- No need to manually clean up dead agent references

[CRITICAL] **Group auto-deletes when all agents die.** After killing all members,
the `SCR_AIGroup` reference becomes null. The mod's group registry must null-check
before accessing any group. Pattern:
```csharp
if (!m_aGroups[i]) { m_aGroups.Remove(i); i--; continue; }
```

**For state extraction**: `group.GetAgentsCount()` is sufficient — already excludes
dead agents. No need to probe individual health unless the commander needs
wounded/healthy breakdown.

### Vehicle Spawning & Boarding

**Confirmed vehicle prefab**:
- UAZ469: `{259EE7B78C51B624}Prefabs/Vehicles/Wheeled/UAZ469/UAZ469.et`
- 5 compartments: 1 `PilotCompartmentSlot` + 4 `CargoCompartmentSlot`
- Health: 2000/2000

**Confirmed group prefab for vehicles**:
- USSR Fire Group (Guard, 4 agents): `{6F72F05752ED62A8}Prefabs/Groups/OPFOR/Group_USSR_FireGroup_Guard.et`
- Fits UAZ exactly (4 agents → 4 cargo slots, pilot empty)

**GetIn waypoints** — all 3 prefabs exist and load:
- `{712F4795CF8B91C7}` AIWaypoint_GetIn
- `{B049D4C74FBC0C4D}` AIWaypoint_GetInNearest → resolves to `SCR_BoardingTimedWaypoint`
- `{8AD8C82346156494}` AIWaypoint_GetInSelected

**GetInNearest confirmed working**:
- Place waypoint at vehicle position, assign to group via `AddWaypoint()`
- AI walks to vehicle (~50m in test), boards over ~25-30s
- `REPORT_MOUNT_AS` callsign error is cosmetic, doesn't affect behavior
- "Stuck trying to get into vehicle" warning self-resolves

**Boarding detection APIs**:
- `BaseCompartmentManagerComponent.GetCompartments(array)` → enumerate all slots
- `BaseCompartmentSlot.GetOccupant()` → null if empty, entity if occupied
- `BaseCompartmentSlot.Type()` → `PilotCompartmentSlot` or `CargoCompartmentSlot`
- `CompartmentAccessComponent.IsInCompartment()` → bool per agent
- `VehicleControllerComponent` present on vehicles

**Vehicle health**: `SCR_DamageManagerComponent.GetHealth()/GetMaxHealth()` works (same as characters).

[DECISION] For stavka vehicle commands: spawn vehicle → spawn group → assign GetInNearest
at vehicle pos → ForcedMove after boarding complete → GetOut at destination → infantry orders.
Full lifecycle confirmed working. See "Vehicle Drive + Dismount" section below.

### Vehicle Drive + Dismount (Full Lifecycle)

Tested complete mechanized cycle: board → drive 500m → dismount.

**Full sequence works**:
1. Spawn vehicle + group → `GetInNearest` waypoint → ~25s boarding
2. `RemoveWaypoint` boarding WP → `ForcedMove` 500m east → AI drives vehicle
3. Poll `vector.DistanceXZ()` until within completion radius → `GetOut` waypoint → ~9s dismount

**ForcedMove works for mounted movement** — no special "drive" waypoint needed.
AI driver navigates terrain/roads autonomously with squad aboard.

**GetOut waypoint**: `{C40316EE26846CAB}` → resolves to `SCR_BoardingWaypoint`.
All agents dismount within ~9 seconds.

**Observed behaviors**:
- Vehicle occasionally stalls briefly (~15-30s), agents may dismount/re-board (occupied 3/4 → 4/4). Self-recovers.
- AI doesn't drive in a straight line — follows terrain, weaves around obstacles
- Overshoots waypoint slightly (~45m) but stays within completion radius
- Drive speed: ~500m in ~3 minutes (~10 km/h average including stalls)

**Stavka mechanized command sequence**:
```
spawn_vehicle → spawn_group → GetInNearest (at vehicle pos)
  → poll occupied == agentCount
  → RemoveWaypoint + ForcedMove (to destination)
  → poll DistanceXZ < radius
  → RemoveWaypoint + GetOut
  → poll occupied == 0
  → assign infantry waypoint (Attack/Defend/etc.)
```

**`CallLater` with repeat=true confirmed**: Use for polling loops.
`GetGame().GetCallqueue().Remove(method)` stops the repeating call.

### Event Hooks

Tested group-level and per-agent event subscriptions.

**Group events (confirmed working)**:
```csharp
// Subscribe to agent removal (death/removal)
group.GetOnAgentRemoved().Insert(OnAgentRemoved);
// Callback signature:
void OnAgentRemoved(AIGroup group, AIAgent agent)
{
    int remaining = group.GetAgentsCount();
    IEntity ent = agent.GetControlledEntity(); // still valid at callback time
}

// Subscribe to agent addition
group.GetOnAgentAdded().Insert(OnAgentAdded);
// Same signature: void OnAgentAdded(AIGroup group, AIAgent agent)
```

- `GetOnAgentRemoved()` fires immediately on death — provides group, agent, and remaining count
- `GetOnAgentAdded()` hooks successfully (untriggered in test — no dynamic additions)
- Agent's controlled entity is still accessible at callback time (prefab name readable)
- Fires once per death: killing 4 agents → 4 sequential callbacks with decreasing count (3→2→1→0)

**Per-agent damage events**:
- `SCR_CharacterDamageManagerComponent.GetOnDamage().Insert()` — hooks successfully
- **Callback signature is NOT the 8-param version** — engine passes `BaseDamageContext` as first param
- Error: `expected 'int', got 'BaseDamageContext'` — correct signature likely:
  `void OnDamaged(BaseDamageContext ctx)` or similar
- Not critical for Phase 1 — agent removal events are sufficient

**Other findings**:
- `EventHandlerManagerComponent` present on all characters
- `SCR_BaseGameMode.OnControllableDestroyed` available as override
- ScriptInvokerBase is a template — call `.Insert()` directly on the return value,
  don't store as a typed variable

[DECISION] **Use `GetOnAgentRemoved()` as the primary event hook.** The mod registers
this callback on every spawned group. When it fires, update the group registry
(decrement count, flag for state report). No polling needed for casualty tracking.
`GetOnDamage` can be explored later for detailed combat reports.

### Combat Engagement Test

Tested two-faction engagement: USSR Rifle Squad (6) vs US Fire Team (4) at 150m.

**AI does NOT auto-engage** — groups spawned 150m apart with no waypoints sat idle
for 10+ seconds. Waypoints are required to initiate movement and combat.

**Attack waypoint triggers engagement**:
- Both sides given `AIWaypoint_Attack` toward each other at t=15s
- Groups advanced, closed from 150m to ~75m over ~30s
- First casualty (BLUFOR GL) at ~76m range, ~90s after attack order
- After first kill, both sides stalled at ~75-85m in cover positions
- Only 1 kill in 2 minutes total — AI is cautious, uses cover

**Combat behavior observations**:
- AI spreads out significantly during advance (50m+ between squad members)
- Groups don't charge — they find cover and engage from positions
- Numerical advantage (6v4) preserved: OPFOR took 0 casualties
- Distance matters: 150m spawn with attack waypoints produces slow, attritional combat
- For faster engagements, use closer spawn distances or `SearchAndDestroy` waypoints

**Event hooks worked during combat**: `OnAgentRemoved` fired correctly with
prefab identification and remaining count. Suitable for real-time casualty reporting.

[DECISION] For stavka: Attack waypoints at moderate range (~100-200m) produce
realistic attritional combat. For decisive engagements, the commander should
maneuver groups closer or use SearchAndDestroy. Auto-engagement without waypoints
does not occur — the commander must always issue explicit orders.

### Full Round-Trip: Mod → REST → Commander → Execute

Tested complete tick cycle: build state JSON → POST to localhost → parse response → execute commands.

**Pipeline confirmed working**:
1. Mod builds state JSON from group registry (faction, agentCount, leaderPos, waypoint)
2. `RestContext.POST(callback, "/api/tick", stateJson)` sends to commander
3. `StavkaTickCallback.OnSuccess(data, dataSize)` receives response
4. Mod parses JSON commands and executes them (move_group, spawn_group)

**REST details**:
- `RestContext` from `GetGame().GetRestApi().GetContext("http://localhost:3000")`
- Headers: `ctx.SetHeaders("Content-Type,application/json,Authorization,Bearer sk-stavka-test123")`
- Callback class must be stored as `ref` member to prevent garbage collection
- `OnSuccess` warning (`Function was not set for event: 'OnSuccess'`) is cosmetic — callback fires correctly
- Response body available as `string data` param in `OnSuccess`

**JSON parsing in Enforce** (all confirmed working):
- `string.IndexOf()` / `string.IndexOfFrom()` — find keys in JSON
- `string.Substring(start, length)` — extract values
- `string.Split(",", array, false)` — split comma-separated values
- `string.ToInt()` / `string.ToFloat()` / `string.Trim()` — type conversion
- `string.Format()` has **9-parameter limit** — split large formats into multiple calls

**Command execution tested**:
- `move_group`: parse groupId + position → RemoveWaypoint + ForcedMove → ✅
- `spawn_group`: parse prefab + position → SpawnEntityPrefab + registry insert → ✅
- Empty commands array: no action → ✅

**State payload sizes**: 135 bytes (1 group), 274 bytes (2 groups). Scales linearly ~135 bytes/group.

[CRITICAL] Callback must be stored as `ref` class member, not local variable.
Local refs get garbage-collected before the async response arrives.

### State Extraction (Groups → JSON)

Tested building a complete world-state JSON string from spawned groups.

**Working APIs**:
- `System.GetTickCount()` — integer tick counter for state versioning
- `group.GetFaction().GetFactionKey()` — returns faction string (e.g. `"USSR"`)
- `ent.GetPrefabData().GetPrefabName()` — full prefab GUID path per agent
- `group.GetLeaderAgent().GetControlledEntity().GetOrigin()` — leader position
- `group.GetAgents(agents)` — iterate all members with position + prefab
- `group.GetCurrentWaypoint()` — type string + world position

**JSON size**: 3 groups × 6 agents = ~2.7 KB. Estimated ~18 KB for 20 groups (full battlefield).
Dropping individual member positions → ~2 KB for 20 groups (leader pos + count only).

**Production optimization**: The mod should track its own spawned groups in an array rather than
querying `AIWorld` each tick, since we only care about stavka-managed groups. JSON is built
via string concatenation — no JSON library needed in Enforce Script.

**Sample output per group**:
```json
{
  "id": 0,
  "faction": "USSR",
  "agentCount": 6,
  "leaderPos": [2059, 40.81, 2047],
  "waypoint": {"type": "SCR_AIWaypoint", "pos": [2359, 78.98, 2047]},
  "members": [{"pos": [2059, 40.81, 2047], "prefab": "...Character_USSR_SL.et"}, ...]
}
```


---

# Part III — Workbench Validation Log

Chronological record of every hands-on test run in Enfusion Workbench (1.6.0.119),
on the Arland map in Game Master, between 2026-02-22 and 2026-02-24. Each test was a
`modded class SCR_BaseGameMode` script (later refactored into a `StavkaTestBase`
harness with named test runners) with a 5-second auto-trigger after world load.

## Test 1 — Terrain Extraction Benchmark

**Question:** Is `World.GetSurfaceY()` fast enough to extract a full heightmap at load time?

**Method:** Sample the Arland playable area (~4 × 4 km) on progressively finer grids,
timing with `System.GetTickCount()`.

**Results:**

| Grid | Samples | Time | Rate |
|------|---------|------|------|
| 100 m | 1,640 | 1 ms | 1,640/ms |
| 50 m | 6,480 | 2 ms | 3,240/ms |
| 25 m | 25,758 | 3 ms | 8,586/ms |
| **10 m** | **160,785** | **20 ms** | **8,039/ms** |

**Extrapolation:** Everon (~10 × 10 km) ≈ 1M samples in ~120 ms at a 10 m grid.

**Conclusions:** Extract terrain at load time; no cache files needed. `min = -256`
is the out-of-bounds/ocean sentinel — filter during extraction. Full tutorial
preserved as `TUTORIAL_TerrainBenchmark.md`.

## Test 2 — REST API Outbound + Auth

**Question:** Can the mod POST JSON with auth headers to an external server and read the response?

**Method:** Node.js HTTP server on `localhost:3000` logging everything; Workbench
script driving `GetGame().GetRestApi().GetContext(...)`.

**Results:**
- `ctx.SetHeaders("Content-Type,application/json,Authorization,Bearer sk-stavka-test123")`
  — headers are **comma-delimited key,value pairs** in one string. Both headers arrived intact.
- POST body arrives as valid JSON.
- **Blocking `_now` methods are broken**: `GET_now()` returns empty, `POST_now()` echoes
  the *sent* body instead of the server response.
- **Async callbacks work**: subclass `RestCallback`, override `OnSuccess(string data, int dataSize)`
  / `OnError(int errorCode)` / `OnTimeout()`. Response body arrives in `data`.
  (A cosmetic warning `Function was not set for event: 'OnSuccess'` prints but the
  callback fires correctly.)
- BattlEye risk downgraded to **None** — first-party engine API, tested end to end.

## Test 3 — Waypoint Type Validation

**Question:** Which waypoint prefabs actually make AI groups act? (Earlier finding:
`AIWaypoint_Move` leaves AI in `SCR_AIIdleActivity`.)

**Method:** Spawn four USSR rifle squads in a line, assign Attack / Defend /
SearchAndDestroy / Patrol simultaneously, track leader positions every 3 s for 20 s.
The full 43-waypoint prefab catalog was dumped from the Resource Browser first
(see Appendix A) — notably **no ForcedAttack or ForcedDefend variants exist**.

**Results:** all four tactical waypoints work via plain `AddWaypoint()`:

| Waypoint | Runtime class | Observed behavior |
|----------|--------------|-------------------|
| Attack | `SCR_EntityWaypoint` | Steady aggressive advance (~6 m / 3 s) |
| Defend | `SCR_DefendWaypoint` | Holds position, small-radius patrol drift |
| SearchAndDestroy | `SCR_SearchAndDestroyWaypoint` | Advances while scanning, Attack-like speed |
| Patrol | `SCR_AIWaypoint` | Wanders the vicinity, no beeline |
| ForcedMove | `SCR_AIWaypoint` | Beeline to position (validated earlier) |
| Move | — | ❌ **Broken — AI stays idle. Never use.** |

**Conclusion:** the commander gets a native 5-order vocabulary (move / attack /
defend / sweep / patrol) with zero custom AI work.

## Test 4 — Multi-Group Spawn + Despawn + Order Reassignment

**Method:** Spawn 3 groups with different orders; at t+8 s delete Group 2 entirely;
at t+14 s swap Group 1's ForcedMove for a Defend.

**Results:**
- **Despawn**: delete each agent's controlled entity via
  `SCR_EntityHelper.DeleteEntityAndChildren(ent)`, then the group entity itself.
  All 6 agents + group deleted cleanly; the other two groups continued their orders
  untouched; the nulled reference reads as null afterward.
- **Reassignment**: `group.RemoveWaypoint(curWP)` → delete the old waypoint entity →
  `AddWaypoint(newWP)`. The group transitions immediately (ForcedMove → Defend, holds).
- `GetGame().GetCallqueue().CallLater(method, ms, repeat)` confirmed for timed
  sequencing; far cleaner than frame counting.

## Test 5 — State Extraction (World → JSON)

**Method:** Spawn 3 squads with distinct waypoints, then serialize everything into a
JSON string by hand (string concatenation — no JSON library exists in Enforce).

**Results:** 2,675-byte payload for 3 groups × 6 agents. Confirmed APIs:
`GetFaction().GetFactionKey()` (`"USSR"`/`"US"`), `GetLeaderAgent()`,
`GetCurrentWaypoint()` (+ `.Type()`, `.GetOrigin()`), `GetAgents(array)`,
`GetControlledEntity().GetOrigin()`, `GetPrefabData().GetPrefabName()`,
`System.GetTickCount()`. Squad roles are readable straight from member prefab names
(SL, AR, AT, AAT, SR, LAT…). ~890 B/group with member detail, ~135 B/group without —
a 20-group battle is ≈ 18 KB or ≈ 3 KB respectively.

## Test 6 — Group Enumeration

**Question:** Can the mod discover all AI groups in the world from scratch?

**Results:**
- `AIWorld.GetAIGroupCount()` / `GetAIGroup(i)` — **do not exist** (compile error).
- `QueryEntitiesByClassName()` — **does not exist**.
- Groups are **not spatial entities**; sphere queries never return them.
- Working fallback: sphere-query characters → `AIControlComponent` → `GetAIAgent()`
  → `GetParentGroup()` → dedupe. Correct, but scanned **21,540 entities** to find 16
  characters → 3 groups. Too expensive per tick.
- `SCR_AIWorld.Cast(GetGame().GetAIWorld())` succeeds (object exists, just no group list).

**Decision:** the mod maintains its **own group registry** (`ref array<SCR_AIGroup>`),
populated on `spawn_group`, null-swept every tick. The character→group trace is a
debug tool only. Bonus: BLUFOR US Fire Team roster confirmed (TL/AR/GL/LAT, 4 agents).

## Test 7 — Health / Alive Status

**Method:** Probe every damage API on a healthy squad, kill one agent, then wipe the squad.

**Results:**
- Component chain on characters: `DamageManagerComponent` →
  `SCR_DamageManagerComponent` → `SCR_CharacterDamageManagerComponent` (all findable).
- Healthy: `GetHealth()=100/100`, `GetState()=0`, `IsDestroyed()=false`,
  `CharacterControllerComponent.IsDead()=false`.
- `dmgMgr.Kill(Instigator.CreateInstigator(null))` → instant: hp 0, state 2, destroyed.
  (The "No instigator type" warning is cosmetic.)
- **Dead agents auto-remove from `GetAgents()`** — count drops immediately; no cleanup needed.
- **A fully wiped group auto-deletes** — the `SCR_AIGroup` reference becomes null.
  Registry code must null-check every access.
- `EDamageState`: 0 = healthy, 2 = destroyed.
- Consequence: `GetAgentsCount()` alone is a sufficient per-group health metric.

## Test 8 — Vehicle Spawn + Boarding

**Method:** Spawn a UAZ469, spawn a 4-man USSR Guard fire group 30 m away, assign
`GetInNearest` at the vehicle.

**Results:**
- UAZ469 `{259EE7B78C51B624}`: 5 compartments (1 `PilotCompartmentSlot` +
  4 `CargoCompartmentSlot`), 2000/2000 HP, has `VehicleControllerComponent`.
- All three GetIn prefabs load (GetIn, GetInNearest, GetInSelected).
  `GetInNearest` resolves to `SCR_BoardingTimedWaypoint`.
- Squad walked ~50 m and fully boarded in ~25–30 s. One
  `Stuck trying to get into vehicle. Reseting..` warning self-resolved.
- Boarding detection: `BaseCompartmentManagerComponent.GetCompartments()` +
  `BaseCompartmentSlot.GetOccupant()`, and per-agent
  `CompartmentAccessComponent.IsInCompartment()`.
- The 4-agent Guard group `{6F72F05752ED62A8}` pairs perfectly with the UAZ's capacity.

## Test 9 — Vehicle Drive + Dismount (Full Mechanized Lifecycle)

**Method:** Three-phase state machine — board (GetInNearest) → drive (`ForcedMove`
500 m east) → dismount (`GetOut`) — with `CallLater(..., repeat=true)` polling and
`GetCallqueue().Remove(method)` to stop each poller.

**Results:**
- **`ForcedMove` drives the vehicle** — the AI driver navigates terrain/roads with
  the squad mounted; no special drive waypoint exists or is needed.
- ~500 m covered in ~3 min (≈10 km/h average incl. stalls). The vehicle briefly
  stalled twice (an agent hopped out and re-boarded; occupied dipped 4→3→4) and
  self-recovered both times. It weaves with terrain, overshot the waypoint ~45 m
  but finished inside the 60 m completion radius.
- `GetOut` `{C40316EE26846CAB}` resolves to `SCR_BoardingWaypoint`; all 4 agents
  dismounted in ~9 s; final check `IsInCompartment()=false` for all.
- Production sequence: spawn vehicle → spawn group → GetInNearest → poll occupied ==
  agents → swap to ForcedMove → poll `vector.DistanceXZ()` < radius → swap to GetOut
  → poll occupied == 0 → issue infantry orders.

## Test 10 — Event Hooks

**Method:** Hook group and per-agent events, then kill one agent and later a whole group.

**Results:**
- `group.GetOnAgentRemoved().Insert(cb)` — ✅ fires immediately per death with
  signature `void cb(AIGroup group, AIAgent agent)`; the agent's controlled entity is
  still readable inside the callback; killing 4 agents produced 4 sequential
  callbacks with remaining 3→2→1→0.
- `group.GetOnAgentAdded().Insert(cb)` — hooks fine (no dynamic joins to trigger it).
- `SCR_CharacterDamageManagerComponent.GetOnDamage().Insert(cb)` — hook attaches, but
  the engine invokes it with a **`BaseDamageContext`** argument, not an unpacked
  parameter list (`ScriptInvoker::Invoke: expected 'int', got 'BaseDamageContext'`).
- `ScriptInvokerBase` is a template — call `.Insert()` on the returned invoker
  directly; don't store it in a bare-typed variable.
- `EventHandlerManagerComponent` exists on every character;
  `SCR_BaseGameMode.OnControllableDestroyed` is available as an override.

**Decision:** `GetOnAgentRemoved` is the primary casualty feed — event-driven, no polling.

## Test 11 — Combat Engagement (OPFOR vs BLUFOR)

**Method:** USSR Rifle Squad (6) vs US Fire Team (4) spawned 150 m apart. Phase 1: no
waypoints — observe. Phase 2 (t+15 s): mutual `Attack` waypoints on each other's positions.

**Results:**
- **AI does not auto-engage at 150 m** — 10+ s of total inactivity without orders.
- Attack orders → both sides advanced, closing 150 m → ~75 m in ~30 s.
- First casualty (the US grenadier) at ~76 m, ~90 s after the order; both sides then
  went to ground in cover, 75–85 m apart. Squad members dispersed 50 m+ during the advance.
- Final after 2 min: OPFOR 6/6 alive, BLUFOR 3/4 — slow, attritional, realistic combat.
- `OnAgentRemoved` fired correctly mid-combat with prefab ID + remaining count.

**Implication:** the commander has time to react, reinforce, and redirect —
engagements are decided over minutes, not seconds, and *nothing happens without
explicit orders*.

## Test 12 — Full Round-Trip (Mod ↔ Commander)

**Method:** A scripted Node.js "commander" on `localhost:3000` returning canned
commands per tick; the mod runs a real tick loop: build state JSON → POST with auth →
parse the JSON response → execute commands → repeat (3 ticks, 8 s apart).

**Results:**

| Tick | State sent | Command received | Executed |
|------|-----------|------------------|----------|
| 1 | 1 USSR group (135 B) | `move_group 0 → [2359,0,2047]` | ✅ old WP removed, ForcedMove assigned, group moved |
| 2 | group underway (163 B) | `spawn_group` US Fire Team @ [2059,0,2197] | ✅ spawned, registry → 2 |
| 3 | 2 groups (274 B) | `commands: []` | ✅ no-op |

- Enforce-side JSON parsing works with nothing but `IndexOf`/`IndexOfFrom`,
  `Substring`, `Split`, `Trim`, `ToInt`, `ToFloat`.
- **The `RestCallback` instance must be stored as a `ref` class member** — a local
  ref is garbage-collected before the async response lands. (Bug caught during port.)
- **`string.Format()` caps at 9 parameters** — large formats must be split.
- Final state: Group 0 (USSR, 6 agents) en route under `SCR_AIWaypoint`; Group 1
  (US, 4 agents) idle as ordered. **The complete commander loop is proven.**

## Test 13 — Conflict Bases & Objectives (pending)

A 6-method probe script is written and ready: game-mode cast to
`SCR_GameModeCampaign`, sphere query for `SCR_CampaignMilitaryBaseComponent`,
`SCR_CampaignMilitaryBaseManager` singleton, `FactionManager` enumeration
(+ `SCR_CampaignFaction` cast), task manager (`SCR_BaseTaskManager`/`GetTasks`),
and world info (`GetBoundBox`, `GetWorldFile`). **Must be run inside a Conflict
scenario** (e.g. Everon Conflict) — Game Master will null most casts. Results pending.

## Engine Quirks Cheat Sheet (discovered the hard way)

1. `AIWaypoint_Move` is broken — always use `AIWaypoint_ForcedMove`.
2. No engine API enumerates AI groups; groups aren't spatial entities — keep your own registry.
3. Agents spawn asynchronously (~1 s / ~60 frames): wait for
   `GetAgentsCount() > 0 && !IsInitializing()` before assigning waypoints.
4. Groups auto-delete when their last agent dies — null-check every registry access.
5. Dead agents silently vanish from `GetAgents()` — `GetAgentsCount()` is truth.
6. REST `_now` methods don't return server responses — async `RestCallback` only.
7. `SetHeaders` takes one comma-delimited string: `"K,V,K,V"`.
8. Store `RestCallback` instances as `ref` members or they're GC'd pre-response.
9. `string.Format` maxes out at 9 parameters.
10. `ScriptInvokerBase` is a template — chain `.Insert()` on the getter's return value.
11. `GetOnDamage` callbacks receive a single `BaseDamageContext`, not unpacked params.
12. `ref` cannot be applied to `SCR_AIGroup` variables (managed class) — plain refs
    in a `ref array<SCR_AIGroup>` container are the pattern.
13. `SCR_EntityHelper.DeleteEntityAndChildren()` is the deletion workhorse
    (agents first, then the group entity).
14. Cosmetic-noise log lines to ignore: `RestCallback: Function was not set…`,
    `REPORT_MOUNT_AS` callsign errors, instigator suicide warnings,
    `Stuck trying to get into vehicle` (self-recovers).
15. `min = -256` from `GetSurfaceY` marks ocean/out-of-bounds.

---
# Part IV — Appendices

## Appendix A — Master Prefab GUID Registry

All GUIDs verified in Workbench 1.6.0.119 (vanilla data). Keep these configurable in
the mod (`.conf`) in case game updates shift them.

### A.1 AI Groups

| Group | GUID + Path | Agents | Status |
|-------|-------------|--------|--------|
| USSR Rifle Squad | `{E552DABF3636C2AD}Prefabs/Groups/OPFOR/Group_USSR_RifleSquad.et` | 6 (SL, AR, AT, AAT, SR, LAT) | ✅ primary test group |
| USSR Fire Group (Guard) | `{6F72F05752ED62A8}Prefabs/Groups/OPFOR/Group_USSR_FireGroup_Guard.et` | 4 (SL, AR, AT, AAT — Guard variants) | ✅ pairs with UAZ469 |
| US Fire Team | `{84E5BBAB25EA23E5}Prefabs/Groups/BLUFOR/Group_US_FireTeam.et` | 4 (TL, AR, GL, LAT) | ✅ |

### A.2 Character Prefabs (observed as group members)

| Faction | Role | GUID + Path |
|---------|------|-------------|
| USSR | Squad Leader | `{5436629450D8387A}Prefabs/Characters/Factions/OPFOR/USSR_Army/Character_USSR_SL.et` |
| USSR | Automatic Rifleman | `{23ADBBC31B6A3DC6}Prefabs/Characters/Factions/OPFOR/USSR_Army/Character_USSR_AR.et` |
| USSR | Anti-Tank | `{1C78331E156A3D65}Prefabs/Characters/Factions/OPFOR/USSR_Army/Character_USSR_AT.et` |
| USSR | Assistant AT | `{631158F6898738A4}Prefabs/Characters/Factions/OPFOR/USSR_Army/Character_USSR_AAT.et` |
| USSR | Sharpshooter | `{333DA6244C7DA34C}Prefabs/Characters/Factions/OPFOR/USSR_Army/Character_USSR_SR.et` |
| USSR | Light AT | `{BF643BE4ADBDFDD3}Prefabs/Characters/Factions/OPFOR/USSR_Army/Character_USSR_LAT.et` |
| USSR (Guard) | Squad Leader | `{90D2F1A1CFCA7B5F}Prefabs/Characters/Factions/OPFOR/USSR_Army/Guard/Character_USSR_SL_Guard.et` |
| USSR (Guard) | Automatic Rifleman | `{7C5B742C683F53C6}Prefabs/Characters/Factions/OPFOR/USSR_Army/Guard/Character_USSR_AR_Guard.et` |
| USSR (Guard) | Anti-Tank | `{FDBB366704065748}Prefabs/Characters/Factions/OPFOR/USSR_Army/Guard/Character_USSR_AT_Guard.et` |
| USSR (Guard) | Assistant AT | `{F5CF70B790492C70}Prefabs/Characters/Factions/OPFOR/USSR_Army/Guard/Character_USSR_AAT_Guard.et` |
| US | Team Leader | `{E398E44759DA1A43}Prefabs/Characters/Factions/BLUFOR/US_Army/Character_US_TL.et` |
| US | Automatic Rifleman | `{5B1996C05B1E51A4}Prefabs/Characters/Factions/BLUFOR/US_Army/Character_US_AR.et` |
| US | Grenadier | `{84029128FA6F6BB9}Prefabs/Characters/Factions/BLUFOR/US_Army/Character_US_GL.et` |
| US | Light AT | `{27BF1FF235DD6036}Prefabs/Characters/Factions/BLUFOR/US_Army/Character_US_LAT.et` |

### A.3 Vehicles

| Vehicle | GUID + Path | Notes |
|---------|-------------|-------|
| UAZ469 | `{259EE7B78C51B624}Prefabs/Vehicles/Wheeled/UAZ469/UAZ469.et` | ✅ 5 slots (1 pilot + 4 cargo), 2000 HP |

### A.4 Complete AI Waypoint Catalog (43 prefabs)

Full vanilla catalog under `Prefabs/AI/Waypoints/`. Status legend:
✅ behavior validated · ☑️ prefab loads (behavior untested) · ❌ broken · — untested.

| Waypoint | GUID | Status / Notes |
|----------|------|----------------|
| Animation | `{4481F98AAFA79B1C}` | — |
| Animation_FastMove | `{F6487A024AB9FFD1}` | — |
| Animation_SlowMove | `{FF8730CC23015B41}` | — |
| ArtillerySupport | `{C524700A27CFECDD}` | — |
| AtEase | `{FFB2813D2571B6B8}` | — |
| **Attack** | `{1B0E3436C30FA211}` | ✅ aggressive advance (`SCR_EntityWaypoint`) |
| Base | `{49CED34BBCD060F0}` | — |
| CaptureRelay | `{EAAE93F98ED5D218}` | — |
| Cycle | `{35BD6541CBB8AC08}` | — (waypoint chaining candidate) |
| **Defend** | `{93291E72AC23930F}` | ✅ hold + small patrol (`SCR_DefendWaypoint`) |
| Defend_ConflictBaseTeamBackup | `{3AB6B883AF54D965}` | — |
| Defend_ConflictBaseTeamPatrol | `{06B1B14B6DE3C983}` | — |
| Defend_CP | `{2A81753527971941}` | — |
| Defend_Hierarchy | `{AAE8882E0DE0761A}` | — |
| Defend_Large | `{FAD1D789EE291964}` | — |
| Defend_Large_CO | `{A33AF7FC5004F294}` | — |
| Defend_Small | `{A70634B518C5C3B8}` | — |
| Defend_Small_CO_Interior | `{1E4818C263E3AB78}` | — |
| DefendSmall | `{2FCBE5C76E285A7B}` | — |
| DeploySmokeCover | `{CE97215CE55CF734}` | — |
| Follow | `{A0509D3C4DD4475E}` | — |
| **ForcedMove** | `{06E1B6EBD480C6E0}` | ✅ beeline; drives mounted vehicles too |
| GetIn | `{712F4795CF8B91C7}` | ☑️ loads |
| **GetInNearest** | `{B049D4C74FBC0C4D}` | ✅ boards nearest vehicle (`SCR_BoardingTimedWaypoint`) |
| GetInSelected | `{8AD8C82346156494}` | ☑️ loads |
| **GetOut** | `{C40316EE26846CAB}` | ✅ dismount ~9 s (`SCR_BoardingWaypoint`) |
| GetOutInstant | `{E5002E8CD9D1F4AF}` | — (scripted fallback path) |
| Heal | `{36ED7C150D5BB654}` | — |
| LoadSupplies | `{0F38A8CA489A1B3D}` | — |
| Loiter_CO | `{4ECD14650D82F5CA}` | — |
| Move | `{750A8D1695BD6998}` | ❌ **broken — AI stays idle** |
| ObservationPost | `{97FB527ECC7CA49E}` | — |
| OpenGate | `{1966BC58CE769D69}` | — |
| **Patrol** | `{22A875E30470BD4F}` | ✅ area wander (`SCR_AIWaypoint`) |
| Patrol_Hierarchy | `{FBA8DC8FDA0E770D}` | — |
| Scout | `{A88F0B6CF25BD1DE}` | — |
| **SearchAndDestroy** | `{B3E7B8DC2BAB8ACC}` | ✅ advance + scan (`SCR_SearchAndDestroyWaypoint`) |
| Suppress | `{ED8277F35B46B4AA}` | — |
| Suppress_Commanding | `{70AAB1ABF7469613}` | — |
| Suppress_Editor | `{70FE5AA8B4BCA67A}` | — |
| UnloadSupplies | `{409DE49C64865E30}` | — |
| UserAction | `{04A06A6742FB0AF8}` | — |
| Wait | `{531EC45063C1F57B}` | — |

There is **no ForcedAttack / ForcedDefend** — only ForcedMove has a forced variant.

## Appendix B — Reusable Enforce Script Patterns

Distilled from the working test scripts. These are the building blocks of the
production `CommanderLink` component.

### B.1 Spawn a group (and wait for agents)

```csharp
protected SCR_AIGroup SpawnGroupAtPos(string prefab, vector pos)
{
    EntitySpawnParams params = new EntitySpawnParams();
    params.TransformMode = ETransformMode.WORLD;
    params.Transform[3] = pos;
    Resource res = Resource.Load(prefab);
    if (!res || !res.IsValid()) return null;
    IEntity ent = GetGame().SpawnEntityPrefab(res, GetGame().GetWorld(), params);
    return SCR_AIGroup.Cast(ent);
}

// Agents populate asynchronously (~1 s). Before assigning waypoints:
//   group.GetAgentsCount() > 0 && !group.IsInitializing()
// or simply defer with:
GetGame().GetCallqueue().CallLater(AssignOrders, 2000, false);
```

### B.2 Spawn + assign a waypoint

```csharp
protected AIWaypoint SpawnWaypoint(string prefab, vector pos, float radius)
{
    pos[1] = GetGame().GetWorld().GetSurfaceY(pos[0], pos[2]);
    EntitySpawnParams params = new EntitySpawnParams();
    params.TransformMode = ETransformMode.WORLD;
    params.Transform[3] = pos;
    Resource res = Resource.Load(prefab);
    if (!res || !res.IsValid()) return null;
    IEntity ent = GetGame().SpawnEntityPrefab(res, GetGame().GetWorld(), params);
    AIWaypoint wp = AIWaypoint.Cast(ent);
    if (wp) wp.SetCompletionRadius(radius);
    return wp;
}

group.AddWaypoint(wp);
```

### B.3 Change orders mid-mission

```csharp
AIWaypoint curWP = group.GetCurrentWaypoint();
if (curWP)
{
    group.RemoveWaypoint(curWP);
    SCR_EntityHelper.DeleteEntityAndChildren(curWP); // avoid waypoint-entity leaks
}
group.AddWaypoint(newWP); // transition is immediate
```

### B.4 Despawn a group

```csharp
array<AIAgent> agents = {};
group.GetAgents(agents);
foreach (AIAgent agent : agents)
{
    IEntity ent = agent.GetControlledEntity();
    if (ent) SCR_EntityHelper.DeleteEntityAndChildren(ent);
}
SCR_EntityHelper.DeleteEntityAndChildren(group);
group = null;
```

### B.5 Registry null-sweep (groups auto-delete on wipe)

```csharp
protected ref array<SCR_AIGroup> m_aGroups = {};

for (int i = m_aGroups.Count() - 1; i >= 0; i--)
{
    if (!m_aGroups[i]) m_aGroups.Remove(i);
}
```

### B.6 Event-driven casualty tracking

```csharp
group.GetOnAgentRemoved().Insert(OnAgentRemoved);
group.GetOnAgentAdded().Insert(OnAgentAdded);

void OnAgentRemoved(AIGroup group, AIAgent agent)
{
    int remaining = group.GetAgentsCount();
    IEntity ent = agent.GetControlledEntity(); // still valid here
    // flag registry entry dirty → include in next state report
}
```

### B.7 REST tick (async, GC-safe)

```csharp
// Callback MUST live in a ref member — locals are GC'd before the response arrives.
protected ref StavkaTickCallback m_pCallback;

RestContext ctx = GetGame().GetRestApi().GetContext("http://localhost:3000");
ctx.SetHeaders("Content-Type,application/json,Authorization,Bearer sk-stavka-test123");
m_pCallback = new StavkaTickCallback(this, m_iTick);
ctx.POST(m_pCallback, "/api/tick", stateJson);

class StavkaTickCallback : RestCallback
{
    protected SCR_BaseGameMode m_Owner;   // production: the CommanderLink component
    protected int m_iTick;

    void StavkaTickCallback(SCR_BaseGameMode owner, int tick)
    {
        m_Owner = owner;
        m_iTick = tick;
    }

    override void OnSuccess(string data, int dataSize) { m_Owner.OnCommandResponse(m_iTick, data); }
    override void OnError(int errorCode)  { /* log + retry policy */ }
    override void OnTimeout()             { /* log + retry policy */ }
}
```

### B.8 JSON in Enforce (no library — string ops only)

```csharp
// Build: string concatenation. Mind the 9-parameter string.Format() limit —
// split large formats into multiple calls.

// Parse: locate keys, slice values.
int typeIdx  = json.IndexOfFrom(searchFrom, "\"type\":\"");
int valStart = typeIdx + 8;
int valEnd   = json.IndexOfFrom(valStart, "\"");
string cmdType = json.Substring(valStart, valEnd - valStart);

// Number arrays:  "position":[x,y,z]
array<string> parts = {};
arrStr.Split(",", parts, false);
float x = parts[0].Trim().ToFloat();
int   id = gidStr.ToInt();
```

### B.9 Timed sequencing & polling

```csharp
GetGame().GetCallqueue().CallLater(Method, 2000, false);       // one-shot
GetGame().GetCallqueue().CallLater(PollMethod, 5000, true);    // repeating poll
GetGame().GetCallqueue().Remove(PollMethod);                   // stop the poll
```

## Appendix C — Node.js Test Commander (round-trip harness)

The scripted commander used to prove the full loop (Test 12). Useful as the seed of
the real Worker's `/api/tick` contract and for offline mod testing.

```js
const http = require('http');

let requestCount = 0;

const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
        requestCount++;
        console.log(`\n=== REQUEST #${requestCount} ===`);
        console.log(`${req.method} ${req.url}`);
        console.log(`Auth: ${req.headers.authorization}`);

        let state = {};
        try { state = JSON.parse(body); } catch (e) {}
        console.log(`Groups received: ${state.groups ? state.groups.length : 0}`);

        let commands;
        if (requestCount === 1) {
            commands = { tick: state.tick || 0, commands: [
                { type: "move_group", groupId: 0,
                  position: [2359, 0, 2047], waypointType: "ForcedMove" }
            ]};
        } else if (requestCount === 2) {
            commands = { tick: state.tick || 0, commands: [
                { type: "spawn_group",
                  prefab: "{84E5BBAB25EA23E5}Prefabs/Groups/BLUFOR/Group_US_FireTeam.et",
                  position: [2059, 0, 2197], faction: "US" }
            ]};
        } else {
            commands = { tick: state.tick || 0, commands: [] };
        }

        const responseBody = JSON.stringify(commands);
        console.log(`Response: ${responseBody}`);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(responseBody);
    });
});

server.listen(3000, () => console.log('Stavka test commander on :3000'));
```

Wire format proven on the wire:

```jsonc
// Mod → Commander (state)
{ "tick": 3, "groups": [
  { "id": 0, "faction": "USSR", "agentCount": 6,
    "leaderPos": [2133.77, 47.61, 2055.75],
    "waypoint": { "type": "SCR_AIWaypoint", "pos": [2359, 78.98, 2047] } }
]}

// Commander → Mod (commands)
{ "tick": 3, "commands": [
  { "type": "move_group", "groupId": 0, "position": [2359, 0, 2047], "waypointType": "ForcedMove" },
  { "type": "spawn_group", "prefab": "{...}.et", "position": [2059, 0, 2197], "faction": "US" }
]}
```

## Appendix D — Terrain Benchmark Summary

Method: modded `SCR_BaseGameMode`, 5 s auto-trigger, nested loop over the map calling
`GetGame().GetWorld().GetSurfaceY(x, z)`, timed with `System.GetTickCount()`.
Full step-by-step Workbench walkthrough preserved in `TUTORIAL_TerrainBenchmark.md`.

- Arland (~4 × 4 km), 10 m grid: **160,785 samples in 20 ms** (≈ 8,000 samples/ms).
- Everon (~10 × 10 km) extrapolates to ~1M samples ≈ **120 ms** — extract at load
  time, ship to the commander once, never cache to disk.
- Filter `-256` (ocean / out-of-bounds sentinel) during extraction.

## Appendix E — Artifacts & Provenance

| Artifact | Role |
|----------|------|
| `PRODUCT.md` | **This document** — unified spec + research + validation log |
| `SPEC.md` | Product specification (superseded by Part I herein; kept as working doc) |
| `RESEARCH.md` | Engine research notes (superseded by Part II herein; kept as working doc) |
| `TUTORIAL_TerrainBenchmark.md` | Step-by-step Workbench benchmark tutorial |
| Test scripts (13) | Enforce Script test suite, evolved into a `StavkaTestBase` harness with named runners (`terrainbench`, `roundtrip`, `multidespawn`, `stateextract`, …); full sources in the session transcripts |
| Node.js test commander | Appendix C — localhost round-trip harness |

Validation environment: Enfusion Workbench 1.6.0.119, Arland, Game Master mode,
local Node 22 on the same machine. The Conflict-mode probe (Test 13) is the only
scripted test not yet executed.

*End of PRODUCT.md.*
