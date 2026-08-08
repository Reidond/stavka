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
7. A single CI workflow now gates automatic production deployment on successful
   `main` verification; its Effect task prebuilds all four services and deploys
   gateway → hosted seat → Commander → Poligon sequentially. No live deploy was
   run for this change.

## Still external-only

- production Enforce Script addon, Workbench, dedicated server, Conflict/JIP,
  BattlEye, Workshop, and in-game 30/40/50-group profiling;
- **repair account workers.dev** (`andrii-shafar` returns `error code: 1042` for
  all Workers; uploads succeeded; `wrangler dev --remote` works);
- harden the GitHub `production` environment (secrets
  `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` are present; add required
  reviewers / deployment branch policy if desired);
- Cloudflare Access apps + `ACCESS_TEAM_DOMAIN` / `ACCESS_AUD` (dashboard;
  Wrangler OAuth lacks Access scopes);
- live Claude / Codex tokens via gateway `/_/` after Access + HTTP routing work;
- full deployed lifecycle drills (sleep/restart, R2 export, Access WS).

An automatic deploy success proves upload and Wrangler configuration only while
workers.dev returns 1042; it does not prove HTTP availability. Worker secrets
and provider credentials remain out of band. Rollback is `wrangler rollback`
per service in reverse dependency order (Poligon, Commander, hosted seat,
gateway), or an equivalent documented version rollback.

Posture B / home-Mac dial-in remains permanently unsupported.

The Test-12 corpus remains intentionally derived and must not be presented as
a missing raw Workbench capture.
