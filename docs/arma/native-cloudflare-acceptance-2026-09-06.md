# Native Cloudflare follow-up — 2026-09-06

The operator authorized provisioning the missing native credentials, repairing
the GitHub production token, deploying, and running native Cloudflare acceptance.
Both credential blockers from the [earlier report](production-acceptance-2026-09-06.md)
are resolved. All times below are UTC unless explicitly marked Kyiv.

## Credentials and deployment

The native profile is stored outside the repository at
`%LOCALAPPDATA%/stavka/native-acceptance-20260906/profile/stavka.json`, with access
limited to the owner and SYSTEM. A new machine bearer was installed consistently
as Commander's `API_KEY` and the unified app's `COMMANDER_API_KEY`. A named
Cloudflare Access service token, `Stavka native dedicated server`, was added to
the existing machine policy. It expires **2026-12-05 06:08:39 UTC**. The human
Access policy and existing automation service token were retained. No credential
values are included in this report or repository.

The existing GitHub deployment token received Zone Read and Workers Routes Edit
for `sands.red`; its existing account permissions were preserved. The existing
GitHub secret remained usable without exposing or rotating its value. Manual
GitHub deployment [34015735448](https://github.com/Reidond/stavka/actions/runs/34015735448)
succeeded, closing the earlier route synchronization failure.

The final manual deployment
[34017993919](https://github.com/Reidond/stavka/actions/runs/34017993919)
succeeded for source `d9bca27fa15a4ff8d7c9f40b5141a1249328a4d6`. Cloudflare's
deployment API confirmed these versions serving 100% of traffic:

| Service           | Version                                | Deployed UTC |
| ----------------- | -------------------------------------- | ------------ |
| Private inference | `66011b7d-8514-49b4-828f-56e7d9d5838e` | 07:01:46     |
| Private Commander | `10906c78-940f-4875-8671-e2b6bd624dee` | 07:03:02     |
| Unified app       | `cf986d2e-d226-430e-9d54-38bfe226ab6a` | 07:03:09     |

After deployment, the signed-in Health page at **10:07:55 Kyiv** reported
Commander Live, inference Live and container Healthy. Anonymous `/` and
`/healthz` requests redirected to Access (302). A wrong machine bearer returned
401; valid machine and Access credentials with invalid connect JSON returned
400; the machine identity could not invoke `/v1/responses` (403).

## Runtime fixes exposed by native acceptance

- `2b21e67` accommodates the engine's three-header limit while retaining both
  authentication gates. Mission epoch travels in the validated JSON payload.
  The contract accepts the engine's default `application/x-www-form-urlencoded`
  media type for its raw JSON bytes, using the same strict schemas as JSON clients.
- `9dd5d9` converts `tick_rate_hint` milliseconds to native timer seconds. The
  earlier interpretation clamped normal polling to 60 seconds.
- `d9bca27` revalidates a completed model proposal against current game state.
  Ordinary incoming ticks no longer discard every slower provider response.
  Disconnect, mission, faction and decision-version guards remain enforced;
  overlapping callbacks execute the same decision only once. Audits preserve
  the snapshot actually presented to the model and recorded provider costs.

Exact-source [CI 34017832907](https://github.com/Reidond/stavka/actions/runs/34017832907)
passed for `d9bca27fa15a4ff8d7c9f40b5141a1249328a4d6`. Local typechecks and
builds passed, as did replay with zero provider calls. `pnpm verify` passed
formatting, lint and Tailwind checks; Windows ran 548 passing tests and four
known failures in POSIX process fixtures. Linux CI passed the complete suite.

## Native package

Game, dedicated server and Tools: **1.8.0.13**. Package run
`7f758d18-280a-4cbc-94b2-61cfef28f4a5` validated all five script targets and
completed ResourceManager packaging. Native smoke
`81802a36-09b3-4b5d-8abb-dae0aa346445` passed AI creation, command decoding,
deduplication, movement, perception, cleanup and timer conversion assertions.

- Source digest: `49d4a56376b41f62510d8fa06a6040c0536f0fa1d31c48112d6690a52375ea1c`.
- PAK SHA-256: `5d1c5d6d5fb07efe323c8bc321711f107830913fe6b2b4ccc5b568a7a811955f`.
- Archive: `out/arma/7f758d18-280a-4cbc-94b2-61cfef28f4a5/Stavka.zip`.
- Addon: `6A4B4D6187F605E0`, installed in the private acceptance profile.

The launch commands and local dedicated-mode limitations from the earlier
report apply. This is an actual native dedicated Conflict/Everon world connected
to the Access-protected Cloudflare origin, not a browser simulation.

## Earlier diagnostic receipts

Session `native-conflict-20260906-final`, epoch 1, OPFOR, connected at
**09:40:02.951 Kyiv**, uploaded terrain at **09:40:10.166**, and acknowledged its
first snapshot at **09:40:12.750**. Its authenticated archive at **06:42:09.697**
contained 35 ticks, one event and eight decision entries. Rule command
`cmd_00000001` (`spawn_group`) received accepted receipts and then COMPLETED for
`g-cmd_00000001`, proving native command round trip and deduplication.

Provider attempts in this diagnostic run were charged but discarded as stale
because snapshots advanced during inference. They are not successful model
command evidence. That finding prompted `d9bca27`. The owner grant was disabled
after the diagnostic run. The prior `native-conflict-20260906-live` grant was
also disabled. A licensed native client joined both runs; the earlier run
rendered a spawned USSR character at base SABLE, with the screenshot retained
privately as `cloudflare-bridge-spawn.png`.

## Final native model acceptance

Session `native-conflict-20260906-verified`, epoch 1, OPFOR, used the final
Cloudflare source and package above. Server log
`logs/logs_2026-09-06_10-04-00/console.log` records native authority at
**10:04:19.532 Kyiv**, Commander connected at **10:04:25.189**, terrain accepted
at **10:04:32.656**, and first snapshot acknowledged at **10:04:35.274**.

The owner enabled the bounded 20-request grant at **10:05:10 Kyiv** and disabled
it after the first model decision. The authenticated archive at
**07:06:47.144** contained 44 ticks, one event and four decision entries:

- Rule fallback `cmd_00000001` spawned `g-cmd_00000001` and completed. It is
  excluded from successful model evidence.
- Model decision **07:06:03.704** issued `cmd_00000003` (`attack_group`) to
  redirect that group to a nearby objective. Native accepted receipts were
  archived repeatedly as the command remained active. Its earlier rule attack
  was explicitly marked failed/superseded. This proves that the model command
  reached and was accepted by the native engine while snapshots continued.
- The same decision's `cmd_00000004` (`set_objective`) failed with
  `native_capture_is_engine_owned`. It did not forcibly change native objective
  ownership. The simulator's objective command is not a native capture override.
- A second model decision at **07:06:37.812**, already in flight when the grant
  was disabled, preserved the current attack and issued no further commands.

The attack was accepted; arrival, capture and tactical victory were not observed.
Usage showed four decision entries (including two rule fallbacks), 1,181 tokens
and $0.0353 recorded cost. This is application accounting under the logical
`stavka/commander` alias, not a provider invoice or concrete model identification.

The final package's licensed client late joined, selected USSR / Aktiv-11,
spawned at Main Operating Base MATROS and rendered the native world. Screenshot
`verified-package-spawn.png` is retained in the private acceptance directory.
The UI confirmed the grant disabled. Owned client/server processes were stopped
at **10:07:26 Kyiv**; no test game process was left running. Temporary key
provisioning files were removed, retaining the protected runtime profile.

Before another independent run, choose a fresh session identity or increment
`mission_epoch`; do not reuse this completed acceptance identity as a new run.

## Limits

One licensed client was available. Simultaneous clients, Workshop installation,
BattlEye, public game hosting, sustained load and campaign victory remain
unverified. Forced termination of owned test processes does not establish
graceful native `OnGameModeEnd`/disconnect behavior. Provider refresh, billing,
streaming, container lifecycle, persisted R2 exports and rollback drills remain
separate acceptance work. Successful deployment alone is not a health result.
