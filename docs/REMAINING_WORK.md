# Remaining acceptance work — 2026-09-06

The [September audit](audits/2026-09-05.md) records local changes, measured
performance, and read-only Cloudflare evidence. The [agent workflow](AGENT_WORKFLOW.md)
provides the current Cloudflare acceptance workflow. Local app/gateway and browser acceptance harnesses have been retired; historical local receipts below are previous evidence, not the current workflow. Repository verification does not deploy the
working tree or invoke a live provider.

Addressed: operational pages and session navigation; real Chromium checks for
all four browser surfaces; configuration reload and header-filtering regressions;
measured simulation hot-loop improvements; isolated QA setup; verification-only
CI and separate manual three-service deployment.

The dashboard follow-up replaces the navigation and simulation workspace,
adds a fitted tactical map and explicit model tests, and resolves simulation
control permissions from verified owner/admin membership. The user authorized
deployment and the three-service production task completed. The signed-in
production dashboard and real Codex/Claude requests were verified after the
final release. Both providers also returned real responses locally. The legacy
Claude token was replaced and revoked. See the audit for exact versions and
verification limits.

The account-scoped Commander execution path is implemented in source. An
owner/admin explicitly grants a bounded session/epoch/faction authorization;
Commander uses a private inference entrypoint to consume that grant against
the owner's provider accounts. Human provider routes retain Access verification.
Production deployment and successful tactical application still require the
release checks below. Do not report rule fallback as a successful model decision.

Still outstanding:

- Deploy the account-scoped Commander execution path and verify
  successful tactical command application. A paused local simulation produced
  a model response, but all five proposed commands failed tactical validation;
  no successful application is claimed.
- Verify provider refresh, streaming, billing/budget behavior,
  container start/restart/sleep, deployed R2 exports, and rollback/lifecycle drills.
- Review GitHub `production` secrets, reviewers, and branch policy at release
  time. The Cloudflare audit does not inspect GitHub settings.
- The native addon and local Workbench workflow are now implemented; see
  [Arma setup and evidence](arma/README.md). Deploy the new game-server ingress
  explicitly, then verify the protected Cloudflare connection, dedicated-server
  Conflict/JIP, BattlEye, Workshop installation and in-game load behavior.

The old workers.dev repair item is obsolete: the intended public origin is
`stavka.sands.red`, protected by Access. workers.dev and preview URLs are
intentionally disabled. Provider accounts are provisioned through the CLI;
browser token pasting is not part of the current design.

Posture B / home-Mac dial-in remains unsupported. The historical Test-12 corpus
is derived evidence, not a raw Workbench capture.
