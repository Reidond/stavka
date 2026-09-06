# Production and dedicated-server acceptance — 2026-09-06

This report extends the [initial Workbench evidence](acceptance.md). It separates
the deployed browser/provider path from the native server's disabled REST bridge.

## Release verification

The release code is `85854c127e3d1302f4e4456edc395a5ef8910709`.
[Linux CI](https://github.com/Reidond/stavka/actions/runs/34000877499) passed all
532 tests, formatting, lint, Tailwind, typechecks, builds, deterministic replay
and mock smoke. Docker is installed and both container builds now pass locally.
Local `pnpm verify` passes 528 tests; four retained tests assert POSIX permission
bits that differ on Windows. Replay passed with zero network calls.

The release adds bounded owner authorization for an exact session, epoch and
faction, with durable attempt accounting and revocation. Commander uses the
private inference entrypoint and the author's active provider accounts. Signed
JWT tests cover explicitly configured owners, operators, unlisted humans and
service tokens. Production Commander Access audience/team settings were aligned
with the existing application, and the existing owner's subject was configured.

## Cloudflare deployment and tactical receipts

The explicit local production task completed successfully in dependency order.
Cloudflare's deployment API confirmed each version at 100% traffic:

| Service     | Version                                | Deployed UTC        |
| ----------- | -------------------------------------- | ------------------- |
| Inference   | `f2b781fe-2214-48a9-b9e7-e572c51eba8f` | 2026-09-06 00:20:37 |
| Commander   | `d0109f7b-d4da-4236-8b22-955281ef53b5` | 2026-09-06 00:21:12 |
| Unified app | `0b9bac99-f14c-42c2-b52d-9845336a29c9` | 2026-09-06 00:21:38 |

At 03:21:54 Kyiv, the signed-in owner's Health page reported Commander and
inference **Live**. The on-demand container was stopped and the kill switch was
off. Anonymous requests to `/`, `/healthz`, and POST `/api/connect` all returned
Access redirects (302). No public workers.dev or preview endpoints were enabled.

The tactical test used the deployed owner grant implementation from `bd25c72`,
followed by the owner Access fix in the release above. Its session is
`poligon-movement-9060255-blufor-balanced-x1-versus`, BLUFOR, epoch 1. The movement
scenario ran at x1 with explicit stepping. Only BLUFOR received a 20-attempt,
one-hour owner authorization. At `2026-09-05T23:59:05.166Z`, Commander returned
a real provider decision to designate the central settlement and advance blue_1.
The deployed session timeline subsequently confirmed these archived outcomes:

| Command        | Type            | Outcome  |
| -------------- | --------------- | -------- |
| `cmd_00000001` | `set_objective` | accepted |
| `cmd_00000002` | `move_group`    | accepted |

The simulation displayed the settlement objective and processed both orders.
This proves command application, not arrival or mission completion. Two unsafe
proposals were rejected. A later model decision at `00:00:16.600Z` has no archived
outcome; no application is claimed for it. The subsequent `00:01:28.213Z` entry
explicitly records rule fallback and is excluded from model-success evidence.
The grant was disabled after the bounded test; the final owner session inspector
showed **Enable AI for 1 hour**, confirming no active grant.

Session Usage displayed three Commander decision entries, 3,422 tokens and
$0.1026 recorded cost. These aggregates include fallback entries and report the
logical alias `stavka/commander`; they do not identify the resolved provider model
or establish invoice totals. Direct JSON navigation was blocked by the browser;
receipt evidence was inspected through the application's authenticated timeline.
R2 export persistence and provider billing remain separate acceptance checks.

## Native dedicated host

Game, dedicated server and Tools: **1.8.0.13**. The package was produced by
`pnpm mod:pack`, run `71cf20fd-9b4d-40a2-b90f-f448749046ed`. All five script
targets validated and ResourceManager packaging succeeded.

- Source digest: `c0dceec0bf6ccdcafadd28edb12719517950200960365aad201f50ce8618087c`.
- PAK SHA-256: `7c7f7cead49c919cf57f50d433d21a96bdf613fa931b048279906fbafc095604`.
- Archive: `out/arma/71cf20fd-9b4d-40a2-b90f-f448749046ed/Stavka.zip`.
- Addon: `6A4B4D6187F605E0`, loaded as a packed addon on server and client.

The owner-only acceptance directory is
`%LOCALAPPDATA%/stavka/native-acceptance-20260906`. Server log
`logs/logs_2026-09-06_03-01-10/console.log` records the running world before the
client joined at **03:02:07 Kyiv**. The client selected US Army / Atlas Red 1,
spawned at Main Operating Base, and rendered the native world. The server
continued after client termination and recorded the disconnect at **03:13:32**.
A second client process rejoined the same server at **03:17:57**, reaching
deployment setup. This package check does not claim character/loadout restoration. An earlier
package check separately displayed the engine's successful character/loadout
reconnect message. Server snapshots reported 60 FPS with one client and roughly
39–40 native AI; this is a bounded smoke observation, not a load benchmark.

Screenshots `current-package-spawn.png`, `current-package-rejoin.png`, and the
earlier `rejoin.png` are retained in that private acceptance directory. Owned
server/client processes were stopped after evidence collection.

Launch from each executable's installation directory. For unpacked local mods,
this engine rejected `-config` together with `-addons`, so the accepted server
command used local dedicated mode:

```text
ArmaReforgerServer.exe -server worlds/MP/CTI_Campaign_HQC_Eden.ent -profile <private-root> -addonsDir <private-root>/addons -addons 6A4B4D6187F605E0 -maxFPS 60 -logStats 30000 -backendLocalStorage
ArmaReforgerSteam.exe -client 127.0.0.1 -profile <private-root>/client -addonsDir <private-root>/addons -addons 6A4B4D6187F605E0 -maxFPS 60
```

The plain world path is required for this local join setup; passing the full
resource GUID/name produced an invalid client world reference. Local mode did
not apply the prepared server JSON or its bind/BattlEye settings. It listened
on the default game port. This run proves local dedicated native replication,
late join and reconnect with one licensed client. It does not prove Workshop
installation, BattlEye, public hosting, simultaneous clients or campaign victory.

## Remaining operator inputs

The native server's `profile/stavka.json` stays disabled. A private configuration
containing the Commander machine bearer and an authorized Cloudflare Access
service token is required to test native connect/map/tick/disconnect against
Cloudflare. No existing private configuration was supplied. Provider credentials
are not substitutes for these game-server credentials.

The GitHub `production` environment has both required secret names and is now
restricted to `main`. Its existing API token cannot read the `sands.red` zone's
Worker routes: manual deployment run
[33999540368](https://github.com/Reidond/stavka/actions/runs/33999540368) uploaded
all three services but failed route synchronization with authentication error 10000. Local Wrangler OAuth completed deployment. The GitHub token still needs
the zone permissions documented in the [deployment runbook](../runbooks/deployment.md).
Token-management access was unavailable, so this credential was not replaced.
