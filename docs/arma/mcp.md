# Enfusion Workbench MCP

This repository includes a local stdio MCP server over the native Workbench
runner. It uses Effect services and scoped jobs, with the MCP SDK confined to
the protocol boundary. It currently targets the Stavka addon layout and its
development plugins; it is not a general live-editor remote control API.

Run `pnpm install` first. The server needs Node 22 or newer and matching Windows
Arma Reforger game/Tools installations. Steam library discovery and
`ARMA_WORKBENCH_EXE` / `ARMA_REFORGER_ADDONS` overrides match the
[CLI guide](cli-tooling.md).

## Connect a client

This checkout configures the server for Codex in
[`.codex/config.toml`](../../.codex/config.toml). Open the repository root as the
Codex project (or launch the CLI there). The relative `cwd = "tools/tasks"`
lets Node resolve `tsx` and `src/enfusion-mcp.ts` within that package, and the
server derives the repository root from its own location. No user-specific
paths are needed in the project config. Restart the MCP server
in the client after configuration changes. Codex loads project MCP configuration
for trusted projects, as described in the
[official MCP setup guide](https://learn.chatgpt.com/docs/extend/mcp?surface=cli).

The [client configuration example](mcp-config.example.json) uses this checkout's
absolute paths. Adjust the paths for another checkout. Launch Node directly:
package-manager banners would corrupt the MCP protocol on stdout. `pnpm mod:mcp`
is a terminal launch convenience, not the command to embed in a stdio client.
The loader file URL makes startup independent of the client's working directory.

```json
{
  "mcpServers": {
    "enfusion-workbench": {
      "command": "node",
      "args": [
        "--import",
        "file:///C:/Users/reido/src/stavka/tools/tasks/node_modules/tsx/dist/loader.mjs",
        "C:/Users/reido/src/stavka/tools/tasks/src/enfusion-mcp.ts"
      ],
      "env": {
        "ENFUSION_PROJECT_ROOT": "C:/Users/reido/src/stavka"
      }
    }
  }
}
```

No user-wide client settings are changed by building or testing this server.
Each client session owns its jobs. The native process's console output goes to
its log files; server diagnostics use stderr. This follows the
[MCP stdio transport contract](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports).

## Tools and evidence

| Tool               | Arguments                         | Result                                                                     |
| ------------------ | --------------------------------- | -------------------------------------------------------------------------- |
| `enfusion_doctor`  | `{}`                              | Installation versions, project presence, editor conflicts and readiness    |
| `enfusion_docs`    | `{ "query": "SwitchToGameMode" }` | Version-matched local API signatures and original HTML paths               |
| `enfusion_start`   | `{ "action": "smoke" }`           | Immediate run UUID and `enfusion://runs/<uuid>` URI                        |
| `enfusion_job`     | `{ "runId": "<uuid>" }`           | Running state or finished outcome, diagnostics and verified artifact paths |
| `enfusion_cancel`  | `{ "runId": "<uuid>" }`           | Cancels an owned job and waits for cleanup                                 |
| `enfusion_inspect` | `{ "runId": "<uuid>" }`           | Reads a saved CLI/MCP run and verifies artifact SHA-256 digests            |

`enfusion_start` accepts `validate`, `smoke`, `resources` or `pack`.
Validation alone accepts `target`: `ALL`, `WORKBENCH`, `PC`, `XBOX`, `PS4` or
`PS5`. Resource lookup requires a bounded `query`, for example
`Group_USSR_RifleSquad`. Every action accepts `timeoutSeconds` from 1 to 600;
the timeout applies per native stage. Packing validates all targets first.
Unknown fields, inappropriate action options and engine flag injection are
rejected before launch.

Start once, then poll `enfusion_job` every few seconds. `state: "finished"`
means the job ended; inspect `result.status` for `passed`, `failed`, `blocked`
or `timeout`. Cancellation has `state: "cancelled"`. `result.artifactIntegrity`
must be `verified` before trusting saved artifacts. A failure before evidence
creation is returned as `error` / `inspectionError`, never as a pass.
Reading a failed run is a successful inspection, not a successful native run.

The server advertises `enfusion://capabilities` and the
`enfusion://runs/{runId}` resource template. Run resources return the same state
and evidence summary as `enfusion_job`. Artifact files remain under
`out/arma/<runId>/`; resource lookup results and smoke captures are listed there.

One native job runs per session; a checkout lock also prevents overlap with CLI
jobs or other sessions. Existing Workbench processes block startup and remain
untouched. Cancellation and normal stdin disconnect release the owned process
and lock. Force-killing the server can leave a stale lock; follow the CLI
recovery procedure after inspecting its run. There is no arbitrary command,
script evaluation, editor attachment, world saving, deployment, provider call
or Workshop publication tool.

Protocol tests use the real SDK client and an in-memory backend, so CI never
launches Workbench. Native acceptance uses a real stdio SDK client and is an
explicit local development check. Workbench simulation does not establish
headless, multiplayer/JIP or deployed service acceptance.

## Recorded verification

The [acceptance record](mcp-acceptance.json) records the 2026-09-06 native
stdio smoke pass, explicit cancellation and stdin-disconnect cancellation on
Tools 1.8.0.13. Both cancellation paths released the native process and checkout
lock. API lookup returned three matching symbols, and the protocol stream had
no parse errors.

MCP protocol/lifecycle tests, architecture checks, typechecks, lint, formatting,
Tailwind and replay passed. Full verification recorded 519 passing tests and
five failures: four existing Windows POSIX-permission assertions and an
unrelated auth-state test that constructs time-dependent fixtures twice. That
auth-state test passed in a focused rerun. The repository build still has two
container dry-run failures because Docker is unavailable. The full verification
gate remains unsuccessful.
