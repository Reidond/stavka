# Local development and acceptance

Use Node 22, pnpm 11.18.0, and a running Docker engine. Install dependencies
with `pnpm install --frozen-lockfile`, then install Chromium once with
`pnpm exec playwright install chromium` (Linux: add `--with-deps`).

| Command                                             | Purpose                                                                                                                   |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `pnpm qa`                                           | Build the four browser surfaces and run Chromium acceptance                                                               |
| `pnpm qa:serve`                                     | Keep the built unified app and its private Workers running for interactive debugging                                      |
| `pnpm exec playwright test tools/qa/stavka.spec.ts` | Repeat the unified browser flow using the current builds                                                                  |
| `pnpm exec vp test --run <test-file>`               | Run focused behavior tests                                                                                                |
| `pnpm bench:sim`                                    | Measure seeded 10,000-step simulation workloads                                                                           |
| `pnpm verify`                                       | Run formatting/lint, Tailwind, tests, fresh typechecks/builds, replay eval, offline gateway smoke, and browser acceptance |

`qa:serve` requires existing builds; run `pnpm qa` first. It prints its URL and
temporary storage path. The profile form accepts synthetic local data. The QA
stack uses real workerd, SQLite, R2 emulation, service bindings, and Agent
WebSockets. Commander uses the mock provider, which correctly reports
`degraded`. No subscription credential is needed for these checks.

QA creates scoped temporary Wrangler configurations and storage outside the
checkout. It projects required fields from checked-in/build configuration,
supplies synthetic local authentication, and does not copy `.dev.vars`, real
provider credentials, routes, or production variable values. Ctrl-C stops child
processes and removes temporary storage. Production Access checks remain active
in the actual deployment configurations.

The auxiliary dashboard tests run their actual built assets with a simulated
503 API response. They verify error rendering, mobile/desktop layout, and pane
scrolling; they do not claim hosted-container lifecycle acceptance.

## Worktrees and debugging

Install dependencies in each worktree. Assign concurrent QA stacks a base port
with three additional free ports: `STAVKA_QA_PORT=18800 pnpm qa` uses 18800–18803.
State is fresh on every run. Do not copy development credential files between
worktrees. The existing `pnpm ai:up` gateway uses a separate default port, 4141.

Playwright stores failure screenshots and traces under `test-results/`. Open a
reported trace with `pnpm exec playwright show-trace <trace.zip>`. Dashboard
tests save both viewport screenshots. Check the first failed stage of
`pnpm verify`; execution stops on its nonzero exit code. Typecheck and build
bypass the task cache so acceptance covers the current files.

Use `/system` for private-binding configuration/readiness, then Step a hosted
simulation and use **Inspect OPFOR session** (or BLUFOR in versus mode) to inspect
its recorded decisions and replay. `/usage` accepts the same session ID and
faction. Missing sessions report an explicit error. `/replays` imports canonical
session export files without a backend round trip.

## Explicit operator actions

`pnpm verify` never deploys or calls a live model. CI uses this same command.
Production deployment is the manual `Deploy production` workflow on `main`,
under the GitHub `production` environment, and deploys inference, Commander,
then the unified app. The hosted seat is optional. Live provider calls,
calibration/studies, deployment, and destructive lifecycle drills require their
explicit operator instructions. Real Arma/Workbench tests are outside this suite.
