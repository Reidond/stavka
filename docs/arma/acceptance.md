# Native addon acceptance — 2026-09-06

This is local native-engine evidence for the uncommitted addon based on repository
commit `4d89d42a4508c67b81767cfff695f3a897496081`. It is not a deployed revision.
[source-manifest.json](source-manifest.json) records the exact addon file hashes.
Game and Workbench both ran **1.8.0.13** after the installed game was updated.

## Completed checks

- Workbench Script Editor validation passed for WORKBENCH, PC, XBOX, PS4 and PS5.
  The task requires `Script validation successful.`; exit zero alone is insufficient.
- The Arland child world ran in World Editor. At **00:52:22 Kyiv time**, the native
  smoke runner completed with `COMPLETE PASS`. The sanitized
  [native log](native-smoke.txt) retains the individual checks.
- Real native AI expanded into six squad members, moved over fifteen metres,
  and perceived an explicitly spawned opposing squad. The earlier empty enemy
  snapshot remained empty until perception observed an enemy. Both test groups
  were deleted by the runner.
- The smoke exercised native command-array decoding, duplicate spawn suppression,
  full/delta snapshots and acknowledged removal. Nine deterministic protocol tests
  validate the actual engine JSON captures, including terrain content hashing.
- ResourceManager reported `Packaging project successful` and produced the addon
  descriptor, resource database and `data.pak`. Local package output is
  `out/arma/338562a8-260e-48a6-8822-a0f4a145cf90/packed/`.
  The PAK SHA-256 is
  `b69cdce0947121b6f616ce1cd71f5bb6c838ea6386244182f073c1a190561ca4`.
- Eight in-process ingress tests cover unchanged forwarding for all four game
  endpoints, machine credentials, Access verification and unavailable Commander.
  These use mocks and make no provider calls.

`pnpm mod:pack` first validates scripts and then packages them. In this Tools
build, `-wbSilent` causes ResourceManager to exit before packaging, so the task
uses that option only for script validation. The native packer exits itself.

## Repository verification

`pnpm verify` passed formatting (442 files), lint (313 files) and Tailwind checks.
The test stage finished with **509 passed / 4 failed**, across 92 files. All four
failures are existing POSIX permission-bit expectations on this Windows host:

- `packages/provider-auth/tests/local-store.test.ts` — one test.
- `tools/warbench/tests/store.test.ts` — one test.
- `tools/warbench/tests/codex.test.ts` — two tests.

The tests were retained. No provider credential store or permission enforcement
was weakened. Windows path separators in two architecture tests were corrected.
An LF checkout policy and portable workspace filter quoting were also added so
the intended checks actually run on this host.

Separately, `pnpm typecheck` passed all nineteen workspaces, and
`pnpm eval -- --replay` passed with cached evidence and zero network calls.
`pnpm build` completed seventeen of nineteen workspaces; the inference and hosted
seat container dry runs require Docker, which is not installed on this PC.
Consequently, the repository-wide verification gate is **not green**.

## Acceptance still required

The Conflict mission header is packaged but its full campaign lifecycle has not
been played through. Dedicated multiplayer, JIP, player takeover, command timeout,
large battles, BattlEye and Workshop installation need native host acceptance.
The smoke is a bounded development check, not evidence for those scenarios.

No Cloudflare deployment, live provider execution or Workshop publication was
performed. The new Access-protected game ingress needs an explicit deployment
before testing the real REST transport. An owner-scoped Commander provider path
is still an upstream integration gap documented in [remaining work](../REMAINING_WORK.md).
The server bridge stays disabled until its private profile configuration is supplied.

See [setup and limitations](README.md) for terrain classification, Sergeant
reporting, planning-objective UI and native completion semantics.
