# Remaining work — completion snapshot (2026-08-05)

The feasible-on-macOS product work from the 2026-08-02 pause handoff is
complete on this revision. Production Arma Reforger addon / dedicated-server
work and real Cloudflare / live-provider acceptance remain external.

## Locally done

1. Pause-boundary edits reviewed and focused-green:
   - Commander DO / terrain indexes key by
     `(session_id, mission_epoch, faction)` via `JSON.stringify([...])`;
   - protocol duplicate IDs, destructive group conflicts, replay metadata
     identity, and excess-property rejection verified;
   - sim-core boarding reservation / reciprocal mounted / combat wipe skips
     verified.
2. Deterministic gates green on one frozen tree after the final source edits
   (see `docs/IMPLEMENTATION_STATUS.md` for exact counts).
3. Local Commander + Poligon browser acceptance evidenced:
   connect → map → full/delta ticks → bounded commands; versus isolation;
   Agent reload checkpoint restore; Commander wipe + reconnect/full resync;
   offline zero-network stepping; `/replay` import timeline + cost table;
   desktop/mobile viewport metrics for Poligon and both Maskirovka dashboards;
   ×100 Step uses cooperative resume quanta (Playwright locator stalls under
   WebGL load are automation bookkeeping when they occur; DOM/cooperative
   Step advances).
4. Temporary `apps/commander/.dev.vars` and `apps/poligon/.dev.vars` removed;
   Poligon rebuilt with no `.dev.vars` copy under `dist/server`.
5. Final PRODUCT gap audit found no remaining feasible-local P0/P1 product
   gaps (only external Arma / Cloudflare / live-provider gates).
6. Documentation refreshed with exact results and explicit external gates.

## Still external-only

Unchanged from the pause handoff:

- production Enforce Script addon, Workbench, dedicated server, Conflict/JIP,
  BattlEye, Workshop, and in-game 30/40/50-group profiling;
- real Cloudflare account deploy, Access, DO/KV/R2/Container lifecycle;
- live Claude / Codex / metered API entitlements and invoice reconciliation.

The Test-12 corpus remains intentionally derived and must not be presented as
a missing raw Workbench capture.
