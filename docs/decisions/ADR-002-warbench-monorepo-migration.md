# ADR-002 — Warbench monorepo migration

- Status: accepted
- Date: 2026-08-21
- Supersedes: the standalone `Reidond/warbench` repository as an active product

## Context

Warbench was created as a separate repository to test the independent hypothesis
("does a live LLM commander materially outperform a deterministic rule commander
on repeatable, held-out battlefield scenarios?") without depending on Stavka's
Commander, Poligon, Maskirovka, protocol packages, or Arma integration.

Maintaining it as a second long-lived repository reproduced the architectural
mistake already identified inside Stavka: multiple operator-facing products with
duplicated auth, provider integrations, deployment pipelines, and dashboards.

## Decision

1. **Stavka is the only product and the only active repository.** Warbench
   becomes a feature of the unified Stavka application at
   `/experiments/warbench`.
2. **History is preserved, not copied.** The standalone repository was imported
   with `git subtree add --prefix=archive/warbench-standalone warbench main`
   (no `--squash`), so every Warbench commit remains reachable from Stavka.
   Both pre-migration states are tagged:
   - `stavka-pre-unification` → `2be74c7098f750a0b1b946b77c80c89e2891c0b6`
   - `warbench-standalone-final` → `277a5bd51ffb32fcdcda95763ec411cdbb0197ea`
3. **Useful source moves into workspace packages**, per the migration map in the
   unification handoff: simulator/controllers/scoring into
   `@stavka/warbench-core`, PDF/JSON evidence into `@stavka/warbench-report`,
   and provider-neutral contracts plus the first-party Codex transport into
   `@stavka/model-provider` / `@stavka/model-provider-codex`. Files are relocated with `git mv` so history
   follows them; the temporary archive tree is deleted once all useful files
   have moved.
4. **Independence is enforced by package boundaries, not repositories.**
   `@stavka/warbench-core` must never import `@stavka/protocol`,
   `@stavka/doctrine`, `@stavka/sim-core`, `@stavka/sim-link`, Commander,
   Cloudflare bindings, or Maskirovka implementation. An architecture test
   fails CI on violation.
5. **Standalone credentials are not migrated.** The Warbench OAuth vault
   encryption key was exposed during development and must be treated as
   compromised. As amended by ADR-003 and the named-account implementation,
   replacement authorization lives in the owner-only local Stavka profile; an
   operator may explicitly push that account into the encrypted gateway vault.

## Consequences

- One lockfile, one toolchain, one CI pipeline, one Access login, one dashboard.
- The standalone Worker, its custom domain (`warbench.sands.red`), Access
  application, and deployment workflow are retired after cutover. The GitHub
  repository is deleted only after its final commit is verified as an ancestor
  of Stavka and durable `stavka-pre-unification` / `warbench-standalone-final`
  tags are pushed to `Reidond/stavka`; audit history remains in this repository.
- All existing standalone Warbench benchmark evidence is marked legacy and
  inconclusive. Final evidence comes exclusively from the immutable study store
  implemented for the unified feature.
- No production deployment happens from the imported archive tree; root CI
  verifies it as inert files until extraction completes.
