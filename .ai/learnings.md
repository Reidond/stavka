# Project Learnings

Accumulated project-level knowledge discovered during task implementation, bug fixes, and development sessions. This file is the single source of truth for lessons learned.

**How entries are added:** The `task-learnings` skill automatically appends entries after each task completion. Entries should never be deleted — only consolidated when the list grows beyond ~200 entries.

**How to use:** Consult this file before starting any task to avoid repeating past mistakes and to leverage known patterns.

### [2026-04-01] Tailscale ACL must include all Arma service ports
- **Context**: Added Tailscale runtime support for Arma Reforger A2S and RCON alongside game connect port.
- **Finding**: Tailscale automation previously synced ACL rules using only `publicPort`, which leaves `rcon.port` and `a2s.port` unreachable over tailnet unless manually allowed.
- **Impact**: When applying Tailscale ACL policy for server access, always read and include `publicPort`, `rcon.port`, and `a2s.port` from `config.json`, and clean up all three rules symmetrically on shutdown.
- **Category**: pattern
