# Remaining acceptance work — 2026-09-05

The [September audit](audits/2026-09-05.md) records local changes, measured
performance, and read-only Cloudflare evidence. The [agent workflow](AGENT_WORKFLOW.md)
provides repeatable acceptance. Repository verification does not deploy the
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

One functional integration gap was found during the signed-in browser audit:
Commander submits machine-authenticated model requests, while the deployed
inference boundary requires an owner-scoped human account. A direct model
test can verify the subscription independently, but the full simulation loop
still needs an explicit account-scoped execution path. Do not relax inference
authorization or report a rule decision as a successful model decision.

Still outstanding:

- Complete a production account-scoped Commander execution path and verify
  successful tactical command application. A paused local simulation produced
  a model response, but all five proposed commands failed tactical validation;
  no successful application is claimed.
- Verify provider refresh, streaming, billing/budget behavior,
  container start/restart/sleep, deployed R2 exports, and rollback/lifecycle drills.
- Review GitHub `production` secrets, reviewers, and branch policy at release
  time. The Cloudflare audit does not inspect GitHub settings.
- Real Arma addon, Workbench, dedicated-server, Conflict/JIP, BattlEye, Workshop,
  and in-game profiling remain outside the requested local tests.

The old workers.dev repair item is obsolete: the intended public origin is
`stavka.sands.red`, protected by Access. workers.dev and preview URLs are
intentionally disabled. Provider accounts are provisioned through the CLI;
browser token pasting is not part of the current design.

Posture B / home-Mac dial-in remains unsupported. The historical Test-12 corpus
is derived evidence, not a raw Workbench capture.
