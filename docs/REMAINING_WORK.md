# Remaining work — paused snapshot (2026-08-02)

Implementation is paused at the user's request. This file is the restart
handoff for the feasible-on-macOS product work described in `PRODUCT.md`.
It deliberately excludes the production Arma Reforger addon and dedicated
server layer.

## Truth at the pause

- No final whole-repository acceptance claim has been made.
- No deployment, commit, or publication was performed.
- Commander, Poligon, and Maskirovka development servers are stopped.
- The worktree contains the implementation as uncommitted files and changes.
- The most recent `pnpm install --frozen-lockfile` completed successfully.
- The most recent `pnpm check` stopped on formatting only and reported 96 files
  requiring `vp check --fix`. It was not rerun because the work was paused.
- Focused suites were green at earlier checkpoints, but some source changes
  landed after those runs. Those numbers are evidence of subsystem progress,
  not proof that the current whole tree is green.
- `docs/IMPLEMENTATION_STATUS.md` describes the intended completed surface,
  but its verification table is intentionally still pending and must be
  refreshed only after the work below is complete.

## Already implemented in the repository

- Effect 4 (`4.0.0-beta.102`) is the application default. First-party HTTP is
  contract-first `HttpApi`/`HttpApiBuilder` with proper Effect routers; Hono and
  manual pathname dispatch are prohibited by architecture tests.
- SQL is isolated in repository modules rather than use cases or handlers.
- Frontends use the shared `@stavka/ui` layer, `tailwind-variants`, Tailwind v4,
  and Cursor/CI Tailwind lint configuration.
- The three human web surfaces use bounded desktop-style viewport shells with
  `100vh` fallback followed by `100dvh` and internal pane scrolling.
- Protocol, deterministic simulation/link, Commander/Sergeant orchestration,
  contributor routing/accounting, terrain, replay/export, Poligon, local
  Maskirovka, and hosted Maskirovka code are substantially implemented.
- Reusable Effect v4 guidance exists in `.agents/skills/effect-v4`, the personal
  Effect skill, and `docs/EFFECT_V4.md`.

## Resume in this order

### 1. Reconcile the edits that landed at the pause boundary

Do this before broad formatting so semantic mistakes remain easy to review.

1. **Commander mission/faction session identity — landed, unverified.**
   `apps/commander/src/api/router.ts` now keys Durable Objects and the terrain
   session index by the tuple `(session_id, mission_epoch, faction)`, serialized
   as JSON. The existing router fixture still seeds the old
   `session:map-session` key and therefore must be updated. Add a regression
   proving that OPFOR and BLUFOR can use the same session ID and epoch without
   sharing mission indexes, maps, or Durable Object state. Recheck the `409`
   behavior for uploads before connect and for mission/map identity mismatch.

2. **Protocol boundary refinements — landed during interruption, unverified as
   a group.** Inspect and finish the changes in:

   - `packages/protocol/src/messages.ts`: duplicate command-result IDs;
   - `packages/protocol/src/state.ts`: duplicate snapshot/delta entity IDs and
     same-delta destructive conflicts;
   - `packages/protocol/src/replay.ts`: export metadata versus archived
     session/faction/mission epoch/map identity.

   Focused tests appear to have landed too, but the responsible tasks were
   interrupted before reporting final verification. Review their error paths,
   run the focused protocol suite, and ensure strict decoders still reject
   excess properties.

3. **Simulation race fixes — landed and focused-verified before later tree
   changes.** Preserve and review the changes that reserve a boarding vehicle
   immediately, enforce reciprocal mounted state on restore, prevent
   cross-vehicle reassignment, and skip groups deleted earlier in a combat
   pass. The sim-core task reported 26/26 tests plus typecheck/build/Oxc and
   formatting green; repeat this after reconciliation.

4. **Run a fresh PRODUCT gap audit.** The previous audit is stale because many
   of its findings were fixed while it was running. Audit the actual frozen
   tree, excluding only the production Arma addon and dedicated-server layer.
   Classify every remaining finding as feasible locally or external-only.

### 2. Format, then run focused checks

After the pause-boundary review:

```bash
pnpm exec vp check --fix
pnpm check
pnpm exec vitest run \
  packages/protocol/tests/protocol.test.ts \
  packages/sim-core/tests/sim-core.test.ts \
  apps/commander/tests/router.test.ts
pnpm --filter @stavka/protocol typecheck
pnpm --filter @stavka/sim-core typecheck
pnpm --filter @stavka/commander typecheck
```

Review the formatter diff rather than assuming a 96-file mechanical rewrite is
semantically harmless.

### 3. Run the complete deterministic gates on one frozen tree

Run these after all implementation tasks have stopped changing files:

```bash
pnpm install --frozen-lockfile
pnpm check
pnpm lint:tailwind
pnpm test
pnpm typecheck
pnpm build
pnpm verify
pnpm eval -- --replay
pnpm ai:smoke
pnpm --filter @stavka/maskirovka-seat build:container
```

Requirements for interpreting the result:

- Record exact pass/fail counts from this final run only.
- Keep the replay evaluation network-free and report evidence for that.
- Report Docker unavailability separately if the container build cannot run;
  do not describe it as green without a successful image build.
- Revalidate both Effect skill directories with the skill validator through
  `uv`; never invoke Python outside `uv`.

Earlier focused checkpoints, to use only as troubleshooting baselines:

- viewport: 3 files / 6 tests;
- architecture: 1 file / 6 tests;
- Poligon: 15 files / 80 tests;
- Maskirovka surfaces: 23 files / 127 tests and a four-endpoint mock smoke;
- Commander: 22 files / 77 tests before the final identity-key patch;
- sim-core: 26 / 26 after the boarding/combat race fixes.

These are not current aggregate acceptance results.

### 4. Complete the local Commander + Poligon acceptance loop

The local two-service flow is the largest feasible acceptance item not yet
completed. Temporary ignored local configurations already exist at
`apps/commander/.dev.vars` and `apps/poligon/.dev.vars`; they contain local dummy
values and matching machine keys. Inspect them before use and do not replace
them with production secrets.

1. Start Commander and Poligon using their workspace `dev` scripts.
2. Confirm both `/healthz` endpoints.
3. Confirm an unauthenticated Commander machine request returns `401` before
   payload decoding or business logic.
4. Run an Agent-hosted deterministic scenario through connect, map upload,
   initial full tick, later delta tick, bounded command, and terminal command
   result.
5. Run `mode=versus` and prove independent OPFOR/BLUFOR state, decisions,
   commands, and cost totals for the same scenario identity.
6. Reload the same scenario and prove Poligon checkpoint restoration.
7. Restart Commander and prove the link requests and supplies a full resync.
8. Run `host=offline` and prove browser stepping produces no Agent, HTTP, or
   WebSocket traffic.
9. Import a local canonical session export at `/replay`; verify strict
   full-to-delta reconstruction, the cause-to-outcome timeline, and cost table.
10. Capture rendered desktop and mobile metrics for Poligon, local Maskirovka,
    and hosted Maskirovka: document viewport height, shell height, body scroll,
    internal scrolling, and header/grid behavior.

Also revisit the Poligon `x100` browser interaction anomaly. Direct DOM click
advanced the simulation quickly and the event loop stayed responsive, while a
Playwright locator click timed out after dispatch under the CPU-heavy run.
Determine whether this is only automation actionability bookkeeping or a real
input/paint problem, then preserve a stable browser regression.

### 5. Clean temporary local artifacts

Only after local acceptance evidence is captured:

- stop all development processes;
- remove the two ignored temporary `.dev.vars` files after confirming their
  exact paths;
- rebuild Poligon and verify no `.dev.vars` copy remains in `dist/server`;
- keep `.dev.vars.example` files as the documented templates;
- inspect generated `.wrangler` state separately and do not delete it as part
  of an unrelated cleanup.

### 6. Refresh documentation and the final status

- Replace every pending entry in `docs/IMPLEMENTATION_STATUS.md` with exact
  final-tree results or an explicit failure/external status.
- Reconcile `README.md` and `docs/OPERATOR_GUIDE.md` with the final mission/map
  identity, replay, local integration, viewport, and cleanup behavior.
- State clearly that repository tests do not prove live Cloudflare resources,
  provider accounts, or Arma behavior.
- Do not claim “everything working” until both deterministic gates and the
  local Commander/Poligon browser loop are green on the same frozen revision.

## External-only work

These items cannot be completed honestly in the present environment and must
remain separate from feasible local work.

### Arma Reforger and Windows

- production Enforce Script addon and Workbench compilation;
- production `CommanderLink`/REST bridge and native order execution;
- real terrain/state/event extraction and exact three-tick raw Test-12 capture;
- Conflict, multiplayer, two-faction, JIP, mission restart, BattlEye, Workshop,
  installation, upgrade, rollback, and dedicated-server acceptance;
- 30/40/50-group profiling in the actual game/server environment.

The current Test-12 v1 three-tick corpus is intentionally marked as derived;
it must not be presented as a missing raw Workbench capture.

### Real Cloudflare infrastructure

- account selection, deployments, routes/domains, DO/KV/R2 bindings, and
  Container lifecycle;
- Access applications/policies/audiences, service tokens, WebSocket behavior,
  and secret rotation;
- eviction/redeploy durability, R2 retention, scale-to-zero/restart,
  observability, failure drills, load tests, and rollback.

### Real model/provider accounts

- live Claude, Codex, and deliberately enabled API credentials/entitlements;
- current model availability, structured-output fidelity, cancellation,
  latency, quota exhaustion/recovery, and credential rotation;
- reconciliation of token/cost estimates with provider counters and invoices.

## Definition of locally done

The feasible-now scope is locally done only when:

1. the pause-boundary edits are reviewed and focused-green;
2. every deterministic gate is green on the same frozen tree;
3. the complete local Commander/Poligon/Poligon-replay/offline browser loop is
   evidenced;
4. temporary local secret files are removed from source and built output;
5. the final PRODUCT audit finds no remaining feasible-local P0/P1 gap; and
6. documentation reports exact results while keeping external gates explicit.
