# Whole-app review implementation

Implemented on `codex/whole-app-review` after release `89a4090` was pushed and deployed.
Publication and deployment are tracked by the release commit and deployment receipts.

## Delivered

- Kumo sidebar with Home, Simulations, Sessions, Models, Providers, Access, and Health; a 240px desktop sidebar, 56px laptop rail, and mobile drawer. The title bar owns the page H1 and action area. Local environment and profile details each have one shell location.
- Sessions combines identity-based Commander loading and local export import with Timeline, State, and Usage tabs. Existing Decisions, Usage, Replays, and session-detail URLs remain usable. Local files retain canonical validation and the 5 MiB limit; superseded file reads cannot replace the selected source.
- Home shows scenario entry points, browser history scoped by organization and user, and readiness. History records opened configurations rather than claiming a server archive exists. Offline visits are labeled explicitly.
- Models separates resolution metadata from explicit probe results, preserves probe history during client navigation, labels cached results, and scopes each result to the profile, alias, model, and provider credential revision.
- Providers shows account metadata and connection dates, with immediate CLI instructions for an empty account list. Access includes email, role, joined date, and the current user, with mobile email disclosure.
- Health uses independent loading, failure, and content states, checked timestamps, and Off/On kill-switch labels. The alias table lives only in Models.
- Simulation status requires a recorded non-rule/non-mock decision before saying Model decisions. Configuration alone shows Awaiting decision. Session navigation uses links; faction and usage data are plain text. Shared styles and replay typography have been simplified.

## Verification

- `pnpm verify`: 497 tests across 91 files, workspace typechecks and builds, Tailwind checks, replay evaluation, offline smoke, and five browser acceptance tests passed.
- Browser acceptance covers live local service bindings, simulation persistence, offline isolation, legacy routes, identity loading, file limits and errors, source-switch races, explicit probe history, and mobile navigation.
- Inspected all seven pages at 1440, 935, and 390px in the running local application. Each has one H1, no document overflow, and no computed text smaller than 12px; the sidebar leaves 1200px and 879px for the workspace at the two larger widths.
- Generated screenshots and release receipts remain in ignored `output/design-review/`.

## Boundaries

Recent sessions are browser-local configuration history; there is still no server session index or UI for listing persisted exports. Model probe history lasts for the current application tab. Commander alias readiness was not added to the protocol. The existing simulation setup pane and focused mobile views are preserved from the preceding simulation redesign.

The preceding production release completed through local Wrangler after GitHub deployment uploaded the private services and app but failed during custom-domain route synchronization. The production GitHub token still needs zone access described in the deployment runbook; no token permissions were changed by this branch.
