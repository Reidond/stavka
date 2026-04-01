---
name: arma-reforger-server-hosting
description: |
  Create and troubleshoot Arma Reforger hosting setups for dedicated, player-hosted, Linux, and Docker environments. Use when users ask about server hosting modes, port forwarding, SteamCMD app IDs, startup flags (`-config`, `-maxFPS`, `-server`), BattlEye RCon config safety, or dedicated server connectivity issues.
---

# Arma Reforger Server Hosting

Use this skill to produce practical hosting guidance and safe server configuration recommendations.

## Quick intent check

Start by identifying:
1. Hosting mode: `player-hosted` or `dedicated`.
2. Platform: Windows or Linux.
3. Exposure target: LAN-only or public internet.
4. Whether mods/RCon/A2S are needed.

## Core rules

1. For public hosting, remind users that router port forwarding is required.
2. Recommend `-maxFPS` in the `60..120` range for dedicated servers.
3. Keep JSON data types correct (numbers and booleans unquoted).
4. Treat config keys as case-sensitive.
5. If BattlEye config is edited, append settings only; do not alter existing mandatory lines.

## Required hosting guidance

When asked for setup help, cover these points in order:

1. **Mode choice**
   - Dedicated: no local player, server-only process.
   - Player-hosted: started from in-game hosting UI.
2. **Ports**
   - Typical game port: `2001/UDP`.
   - Optional query/RCon ports as configured.
   - Public servers need router/NAT forwarding.
3. **Startup flags**
   - `-config "<path-to-config.json>"` for dedicated config.
   - `-maxFPS 60` (or similar) for resource control.
   - `-server "<world.ent>"` ignores `-config` and starts local world directly.
4. **BattlEye safety**
   - RCon values can be appended to `BEServer_x64.cfg`:
     - `RConPort <port>`
     - `RConPassword <password>`
   - If broken, restore by deleting the file and verifying game files via Steam.

## SteamCMD app IDs

- Stable dedicated server app ID: `1874900`
- Experimental app ID: `1890870`

## Linux notes

1. For Linux/Docker setups, validate the server advertises/reports the reachable host IP, not an internal container-only address.
2. If browser join fails, test direct IP connect.
3. For Docker mod-download write failures, recommend setting `-addonTempDir` to a writable path.

## Response format

When generating instructions/config, respond with:
1. Recommended command/config snippet.
2. Assumptions (2-5 bullets).
3. Port checklist.
4. Validation/test steps.

## Additional reference

For detailed field-level and platform-specific notes, read [reference.md](reference.md).
