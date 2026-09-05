# Stavka development tooling

Development-only addon `FC679038AE413B23`, depending on the playable Stavka addon.
It is not a dependency of Stavka and is excluded from `pnpm mod:pack`.

`StavkaSmokePlugin` loads the fixed Arland child world and starts native play.
It excludes the unrelated arsenal component from the in-memory test world;
it never saves that change. `StavkaResourcesPlugin` queries Workbench's resource
database and emits bounded GUID/path results. Neither exposes arbitrary code
execution or networking.

Use the repository's `mod:smoke` and `mod:resources` commands. They provide unique
native profiles and logs, validate completion identity and own process cleanup.
See [CLI tooling](../../docs/arma/cli-tooling.md).
