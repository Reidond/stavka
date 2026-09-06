# Stavka Arma Reforger addon

`mods/Stavka` is the native protocol-v1 bridge. Workbench created its project
identity `6A4B4D6187F605E0`; it depends only on the base Arma Reforger addon.
Use matching game and Tools versions. Development and native checks currently
target **1.8.0.13**.

## Open, compile, and package

Open `mods/Stavka/addon.gproj` in Arma Reforger Workbench. Add the installed
game's `addons` directory to the dependency search path if prompted. The base
game GUID is `58D0FB3206B6F859`.

From the repository root on Windows:

```powershell
pnpm mod:doctor
pnpm mod:validate
pnpm mod:smoke
pnpm mod:pack
```

Native smoke, resource lookup, API documentation search and evidence inspection
now run through the [CLI tooling guide](cli-tooling.md). Prefer those commands
to editor navigation. The Workbench-only automation lives in `mods/StavkaTools`
and is excluded from the playable package.

These are explicit operator-local Tools actions, separate from `pnpm verify`
and CI. The Effect tasks use scoped child processes, retain compiler logs,
require the native success marker, and produce fresh output under `out/arma`.
Override `ARMA_WORKBENCH_EXE` and `ARMA_REFORGER_ADDONS` when Steam is installed
elsewhere. Packing is local; it does not publish to Workshop or deploy Cloudflare.

Each successful pack produces `out/arma/<run-id>/Stavka.zip`. Extract it and retain the
`Stavka` directory containing `addon.gproj`, `data.pak` and `resourceDatabase.rdb`.
Point the game's `-addonsDir` at that directory's parent and load
`-addons 6A4B4D6187F605E0`. For example, an extraction under `C:/ArmaMods` uses
`-addonsDir C:/ArmaMods/Stavka-1.8.0.13 -addons 6A4B4D6187F605E0`.
This is a local package, not a Workshop subscription. The bridge remains disabled
until configured below. A local dedicated host passed late join, spawn and rejoin;
see the [dated acceptance report](production-acceptance-2026-09-06.md) for its scope.

Close Workbench before updating the game: its open PAK files can block Steam's
final installation step. Restart Tools after a game update or failed hot reload.

## Server configuration

The bridge is disabled by default. Configure `$profile:stavka.json` on the
server, outside the addon and repository. Use the server account's restricted
profile directory. Never distribute that file to clients or pack it into a PAK.
The non-secret example is [stavka.example.json](stavka.example.json).

Supply an existing Commander machine API key and a Cloudflare Access service
token authorized for `https://stavka.sands.red`. The service token is presented
to Access; the application independently verifies the machine bearer. Provider
tokens do not belong in this configuration.

Enfusion 1.8 accepts three custom headers. The bridge uses them for the machine
bearer and Access client ID/secret, and includes `mission_epoch` in every JSON
envelope. Its native POST media type is `application/x-www-form-urlencoded`;
the game HTTP contracts explicitly decode its unchanged bytes as strict JSON.
Legacy JSON clients and mission-epoch headers remain supported. Conflicting
epochs are rejected before session routing.

Choose a unique session and mission identity. Increment `mission_epoch` before
starting a new authoritative game process for the same session. Reusing an epoch
after a process restart can collide with immutable tick receipts. Network retries
within the running process preserve the original tick id and exact body.

Select `USSR` / `OPFOR` or `US` / `BLUFOR`. `infantry_squad` resolves to the
allowlisted native faction prefab. The reserve is an abstract reinforcement
budget: each squad costs six manpower. The default cap is twelve managed groups.
Existing mission groups are adopted only when `adopt_existing_groups` is enabled;
they cannot be despawned through the bridge. Player membership always revokes
Commander control, including master/slave group membership.

The playable Conflict entry is
`{C535DC09ABDE4973}Missions/Stavka_Conflict.conf`, inheriting native Conflict
Everon. Set `map_name` to `Everon` for this scenario. The addon can also be loaded
alongside other `SCR_BaseGameMode` scenarios; its authority hook checks the same
profile configuration. The Arland Game Master child world is for development.

The new public `/api/connect`, `/api/map`, `/api/tick`, and `/api/disconnect`
contracts forward through `COMMANDER_SERVICE`. Deploy the source explicitly
before testing that path on Cloudflare. Once the server session appears in
Sessions, a signed-in owner/admin must explicitly enable AI for its exact mission
epoch and faction. This authorizes up to 20 provider request attempts for one hour
using that user's active provider accounts. Game-server credentials do not grant
provider execution. See [remaining work](../REMAINING_WORK.md) for acceptance status.

## Native behavior

- Protocol parsing uses `JsonLoadContext`, including nested command arrays and
  numeric coordinate arrays. Invalid commands return explicit failed receipts.
- Native squad spawning, movement, attack, defend, patrol, sweep and despawn use
  replicated game entities and native AI waypoints. `set_objective` maintains
  Commander planning objectives and assigns their positions as native orders.
- `spawn_group` supports native/default and defend behavior. Unsupported behavior
  strings fail explicitly. Spawn completion waits for native expansion and stable
  membership. An assigned waypoint is accepted; native completion is reported
  separately. Defend and patrol remain active until superseded or ended.
- Commander-owned native agents are pinned active while managed. Their previous
  LOD setting is restored when player control takes over. Native dormant mission
  groups are not misreported as casualties merely because characters disappear.
- Conflict bases are reported from the campaign base manager. Their faction and
  capture remain engine-owned. The bridge never changes a native base's owner.
  Capture progress currently reports ownership endpoints rather than a continuous
  fractional capture meter. Planning objectives do not create player task UI.
- Contacts come from friendly agents' perception targets and last-seen positions.
  Enemy entities are used only for stable identity; their live positions are not
  queried. Contacts expire, and casualty/group/contact events are buffered until
  acknowledgement. The current bridge emits events rather than synthetic ammo
  or morale estimates in Sergeant reports.
- Full/delta baselines advance only after an exact tick acknowledgement. Queued
  events and newer terminal receipts survive in-flight requests. Retries keep
  immutable bodies; authentication and semantic HTTP failures stop the bridge
  with a credential-free diagnostic. Native timeouts and callback generations
  handle transport failure; unsupported `RestContext.reset()` is not used.
- Terrain classifier v1 samples height, ocean and slope, skips invalid terrain,
  limits payload size, and produces the protocol's canonical content hash.
  It conservatively reports land as field/no-cover. Vegetation, roads, buildings,
  navmesh accessibility and key-feature extraction remain future classifiers.

No custom client RPC, chat command or browser token-entry surface is added.
Native entity replication supplies ordinary game synchronization. A single-client
dedicated join/rejoin check passed; simultaneous clients, BattlEye, Workshop and
load acceptance still require separate tests before a public release.

## Workbench acceptance mode

The usual entrypoint is now `pnpm mod:smoke`: it starts native play, collects
fresh evidence and stops its owned editor automatically. The manual workflow
below is retained for visual debugging.

Launch the project with `-stavkaSmoke 1 -forceUpdate`, open
`{EC9A501F17BF46E8}Worlds/StavkaGM_Arland.ent`, and choose **Game → Play game**.
The Workbench-only runner suppresses bridge networking, spawns native test AI,
checks decoding/deduplication/movement/perception/deletion, and writes
`$profile:stavka-smoke-*.json`. It cleans up its test groups. Look for
`[StavkaSmoke] COMPLETE PASS` in the console and `passed: true` in the result.

Actual engine captures are retained in
`packages/protocol/tests/fixtures/arma-1.8.0.13`; deterministic protocol tests
validate them without launching the game or invoking a provider. See
[acceptance evidence](acceptance.md) for the exact tested revision and limits.

## Saved reference material

The official wiki pages were opened through the user's signed-in Edge browser
and saved after its anti-bot check. The permanent local cache is
`~/.cache/stavka/arma-reforger/1.8.0.13/`.

| Saved file               | Official source                                                                            |
| ------------------------ | ------------------------------------------------------------------------------------------ |
| `mod-project-setup.txt`  | [Mod Project Setup](https://community.bistudio.com/wiki/Arma_Reforger:Mod_Project_Setup)   |
| `rest-api-usage.txt`     | [REST API Usage](https://community.bistudio.com/wiki/Arma_Reforger:REST_API_Usage)         |
| `startup-parameters.txt` | [Startup Parameters](https://community.bistudio.com/wiki/Arma_Reforger:Startup_Parameters) |

Twelve extracted native API pages are cached alongside them. The full matching
offline API ships in `Arma Reforger Tools/Workbench/docs/`. Prefer that installed
reference for 1.8 behavior: the older wiki REST page incorrectly says custom
headers are unavailable, while 1.8 exposes `SetHeaders`; `reset` is obsolete.
`SCR_AIGroup.IsInitializing()` always returns false in 1.8, so the bridge uses
native expansion and membership stability instead. Keep these copies for
future work; another browser challenge is unnecessary for the saved material.
