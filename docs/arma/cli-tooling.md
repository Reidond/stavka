# CLI-first Arma tooling

Implemented and tested on Windows with game and Tools **1.8.0.13**, 2026-09-06.
Native smoke runs now require no desktop clicks. All commands run from the
repository root; arguments after `--` are forwarded to the task.

The [Enfusion MCP server](mcp.md) exposes these operations as typed tools and
asynchronous jobs for MCP clients.

```powershell
pnpm mod:doctor
pnpm mod:validate -- --target PC
pnpm mod:smoke
pnpm mod:resources -- --query Group_USSR_RifleSquad
pnpm mod:docs SwitchToGameMode
pnpm mod:pack
pnpm mod:inspect <run-uuid>
```

Each native action writes `out/arma/<run-uuid>/result.json`, logs and native
source hashes. Status distinguishes passed, failed, blocked, timeout and cancelled.
`mod:inspect` validates the stored schema and artifact digests and prints JSON.
It reports the recorded outcome; inspecting a failed run does not turn it into
a pass. `mod:docs` prints matching signatures and original HTML locations as JSON.

`mod:doctor` discovers Steam libraries, checks matching executable versions,
project presence, writable output and existing Workbench processes. Override
`ARMA_WORKBENCH_EXE` and `ARMA_REFORGER_ADDONS` for other installations. A native
run leaves existing editors untouched and acquires `out/arma/native.lock` to
prevent overlapping tasks in this checkout. Normal completion and interruption
release it. After an abnormal parent-process crash, inspect the run named in a
remaining lock and confirm its process is gone before removing that single file.

`mod:validate` defaults to all targets. Only validation accepts `--target`;
packing always validates all supported targets before creating the PAK and
`Stavka.zip`. The ZIP contains `release/Stavka/`, `release/sources.json` and
`release/build.json`. Load the extracted addon with `-addonsDir` pointing at
`release` and `-addons 6A4B4D6187F605E0`. The development plugin is excluded.

`mod:smoke` uses a fresh native profile beneath the run directory, suppresses
bridge networking, and requires the receipt's run ID, native source hash and
engine version to match. The runner also rejects source changes during execution.
Its default deadline is 180 seconds; validation and packaging default to 600
seconds per native stage. `--timeout-seconds N` accepts 1–600 seconds. After the
native runner finishes entity cleanup and closes its captures, the CLI stops
its own editor through scoped process cleanup, without saving the temporary world.

The fixed smoke world inherits Arland Game Master. The plugin removes the
unrelated player arsenal component in memory before play, avoiding its FileIO
authorization prompt. No world is saved and `-scriptAuthorizeAll` is not used.
Engine windows may appear; the workflow needs no mouse or keyboard interaction.
This is Workbench simulation, not headless or multiplayer acceptance.

The [CLI acceptance record](cli-acceptance.json) identifies two successful native
smoke runs, deliberate assertion failure, timeout, resource lookup, packaging and
environment checks. Those runs used no computer-use actions. Focused tooling and
architecture tests passed; the full repository test run had 516 passes and the
same four Windows POSIX-permission failures noted in the original acceptance.
Replay, tooling typecheck, formatting, lint and Tailwind checks passed. This does
not make the repository-wide verification gate green.

Failure-path checks are explicit development options:

```powershell
pnpm mod:smoke -- --fail
pnpm mod:smoke -- --timeout-seconds 1
```

Both should return nonzero and save the corresponding failed/timeout result.
Resource lookup is read-only and returns at most 100 GUID/path matches with the
total match count. Resource registration, rebuild and inherited-configuration
validation remain future commands; a successful lookup does not establish those.

`mod:docs` indexes the two installed API trees into a versioned local cache.
Use `--reindex` to rebuild it. Saved wiki text remains alongside that cache for
manual searching; the current command indexes native API signatures only.

## Implementation and limits

The Effect-first runner lives in `tools/tasks/src/arma*.ts`. The development-only
`mods/StavkaTools` addon supplies the two bounded Workbench plugins. Root package
scripts remain single-command aliases. Native commands stay outside CI; runner
unit tests and saved protocol captures run deterministically without the engine.

Native source fingerprints include `.c`, `.gproj`, `.conf`, `.meta`, `.ent` and
`.layer` files. They exclude generated databases and documentation. Repeated
compiler diagnostics are deduplicated into file/line/message records. Full engine
logs are retained, including base-game warnings and resource messages.

The documented CLI was exercised on this PC without computer-use tools. It does
not establish dedicated server, JIP, Workshop installation, visual appearance or
live Cloudflare/provider acceptance. Future work can add resource registration
and rebuild, deeper project/dependency validation, saved-wiki search, and a
separately verified dedicated-server smoke backend.

The API cache is `~/.cache/stavka/arma-reforger/1.8.0.13/`. Original HTML ships in
`Arma Reforger Tools/Workbench/docs/`. Prefer these references to another browser
visit; refresh only when the installed engine changes or a reference is missing.
