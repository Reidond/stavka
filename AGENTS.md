# Stavka — Agent guidance

This file orients AI agents working on the Stavka codebase.

## Project overview

**Stavka** is an Arma Reforger modding and testing setup:

- **Rust**: `arma-test-server` — CLI to setup, start, and manage a dedicated Arma Reforger server (SteamCMD, config, saves).
- **Enforce Script**: `mods/StavkaTest/` — in-game test mod: chat-triggered tests (`!test <name>`), `StavkaTestBase` / `StavkaTestRunner`, mission config.

Data (server binary, profile, addons, saves, `config.json`, `settings.json`) lives in the OS cache dir (e.g. Windows: `%LOCALAPPDATA%\stavka\`).

## Repo layout

```
stavka/
├── AGENTS.md              # This file
├── Cargo.toml             # Workspace (crates/arma-test-server)
├── package.json           # Dev deps (TypeScript, @types/node)
├── crates/
│   └── arma-test-server/  # Rust CLI: setup, start, saves
├── mods/
│   └── StavkaTest/        # Enforce Script test mod
│       ├── Scripts/Game/  # StavkaTestRunner, StavkaTestBase, Tests/*.c
│       ├── Missions/      # StavkaTest_Conflict.conf
│       └── Worlds/        # TestGM_Arland.ent
└── .claude/skills/        # add-test, arma-reforger
```

## Skills to use

- **Enforce Script / Arma Reforger**: `.claude/skills/arma-reforger/` — use when editing `.c` files, game modes, replication, UI, or mod structure. Contains API and compile-time rules (e.g. no `ref` on entities, `string.Format` limits).
- **Add test**: `.claude/skills/add-test/SKILL.md` — use when adding a new test: create `StavkaTest_{Name}.c` in `mods/StavkaTest/Scripts/Game/Tests/`, register in `StavkaTestRunner.c`, use `SPAWN_POS` from `StavkaTestBase` (never hardcode `Vector(2059, 0, 2047)`).

## Conventions

### Enforce Script tests

- Test class: `StavkaTest_{PascalCase}`; chat command: lowercase short name (e.g. `pathfind`).
- One-shot: override `Run()` only. Frame-update: override `NeedsUpdate()`, `Run()`, `Update(timeSlice)` and use a `m_bDone`-style flag.
- Spawn position: always use `SPAWN_POS` from `StavkaTestBase`; resolve Y from terrain.

### Rust (arma-test-server)

- Edition 2024, Rust 1.85. Commands: `setup`, `start` (--fresh, --save, --fps, --config), `saves` (list, import, info).
- Server config: `config.json` in the stavka cache dir; scenario points at `StavkaTest_Conflict.conf`.

## Quick reference

| Task                   | Where / How                                                                                                    |
| ---------------------- | -------------------------------------------------------------------------------------------------------------- |
| Add an Enforce test    | Follow add-test skill; new file under `mods/StavkaTest/Scripts/Game/Tests/`, register in `StavkaTestRunner.c`. |
| Change server defaults | `config.json` in OS stavka cache (or document in `crates/arma-test-server`).                                   |
| Run server from CLI    | `cargo run -p arma-test-server -- start` (after `setup`).                                                      |
| Enforce API / rules    | Use arma-reforger skill before writing or refactoring `.c` code.                                               |

## AI Development Workflows

### Task completion checklist (mandatory)

When a task is complete, ALWAYS perform these steps before considering it done:

1. **Post-task review** (major tasks: 3+ files, new feature, spec completion) — Run the full 8-step review: code review (1–6), documentation impact (7), learnings extraction (8). See `.claude/skills/post-task-review/SKILL.md`.
2. **Learnings extraction** (all tasks) — Extract project-level findings and append to `.ai/learnings.md`. See `.claude/skills/task-learnings/SKILL.md`.
3. **Documentation updates** — If any modified files affect docs (per `.claude/skills/post-task-review/references/doc-impact-matrix.md`), update the affected documentation.
4. **Restart backend** — If any backend files were modified, restart the backend container:
   `docker compose -f docker-compose.yaml -f docker-compose.local.yaml up -d backend`
5. **Rebuild and restart frontend** — If any frontend files were modified, rebuild with clean cache and restart:
   `docker compose -f docker-compose.yaml -f docker-compose.local.yaml build --no-cache frontend`
   `docker compose -f docker-compose.yaml -f docker-compose.local.yaml up -d frontend`

### Learnings system

- Consult `.ai/learnings.md` before starting any task — it contains accumulated project knowledge.
- After completing a task, extract and record new learnings using the `task-learnings` skill.
- If a finding reveals a convention gap, update the relevant rule file (AGENTS.md, .cursor/rules/).
- See `.claude/skills/task-learnings/SKILL.md` for the full extraction process.

### Spec-driven development

- Auto-detect task size before implementation using scope analysis.
- Small tasks (1–3 files, single concern): implement directly.
- Medium tasks (4–10 files, new components): create a lightweight spec in `.specs/{task-name}/spec.md`.
- Large tasks (10+ files, multi-feature, architectural): create full spec (requirements.md, design.md, tasks.md) in `.specs/{task-name}/`.
- Large tasks: present requirements → get approval → write design → get approval → write tasks → get approval → implement.
- At each spec gate, iterate if the user requests changes. Challenge changes that are technically unsound or contradict prior approvals — once, with reasoning — then defer to the user.
- All spec documents must be written to `.specs/{task-name}/` as actual files. The Cursor CreatePlan tool does not replace file creation.
- Large tasks with natural phase boundaries: use phased execution with intermediate quality gates to reduce context load and catch drift early.
- Templates live in `.ai/templates/`. See `.claude/skills/spec-driven-dev/SKILL.md` for the full pipeline.

### Post-task review

- Run the 8-step review for all major tasks (3+ files modified, new features, spec completions).
- Steps 1–6: code review and convention compliance.
- Step 7: documentation impact analysis — check and update affected docs.
- Step 8: learnings extraction — capture and record project knowledge.
- See `.claude/skills/post-task-review/SKILL.md` for the full process.

### Plan self-review (plan-critic)

- **Before presenting any spec document or Cursor plan to the user**, run the plan-critic self-review.
- Invoke `.claude/skills/plan-critic/SKILL.md` after writing: `spec.md` (medium tasks), `design.md` (large tasks), `tasks.md` (large tasks, completeness-only), or any `CreatePlan` output.
- Resolve all Blocker and Major findings silently before presenting. Minor findings are fixed without mention.
- If any Blockers or Questions cannot be resolved without user input, surface them prominently at the top of the presented document — do not suppress them.
- See `.claude/skills/plan-critic/SKILL.md` for the full review protocol.
