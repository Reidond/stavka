---
name: arma-reforger-server-config
description: |
  Author and review Arma Reforger dedicated server JSON configuration files (`config.json`) with version-aware defaults and hosting safeguards. Use when creating server config, tuning ports/RCON/A2S/gameProperties/mods/operating, validating Arma Reforger server JSON, or when users mention fastValidation, crossPlatform, scenarioId, RCON, public hosting, or dedicated server setup.
---

# Arma Reforger Server Config

Create or review Arma Reforger dedicated server `config.json` using safe defaults for public hosting and valid schema structure.

## Core hosting rules (always enforce)

1. Keep `game.gameProperties.fastValidation` set to `true` for public servers.
2. Recommend limiting server FPS via startup parameter `-maxFPS` (outside JSON) for performance.
3. Treat JSON keys as case-sensitive and keep correct property casing.
4. Use number/bool JSON types for typed fields; do not quote numeric/bool values.

## Quick workflow

1. Identify target use case:
   - Public internet host
   - LAN/dev host
   - Modded server with optional mods
2. Build/validate these root sections:
   - Root networking (`bindAddress`, `bindPort`, `publicAddress`, `publicPort`)
   - Optional `a2s`
   - Optional `rcon`
   - Required `game`
   - Optional `operating`
3. Validate high-risk settings:
   - `fastValidation: true` (public)
   - `rcon.password` present if `rcon` used, no spaces, length >= 3
   - `game.scenarioId` set to a valid `.conf` scenario path
   - `crossPlatform` and `supportedPlatforms` are not contradictory
4. Return:
   - Final JSON
   - Short list of assumptions
   - Startup flags recommendation (`-maxFPS`, optional others)

## Recommended defaults

- Leave `bindAddress` and `publicAddress` unset/empty unless there is a specific networking need.
- Keep `bindPort` and `publicPort` aligned unless explicit port-forwarding requires differences.
- Prefer `crossPlatform` and leave `supportedPlatforms` undefined unless a strict platform allowlist is required.
- Keep `battlEye: true` for public servers.
- Use `visible: true` unless intentionally private.

## Validation checklist

- [ ] JSON parses and uses valid object structure.
- [ ] Root/game key names use correct case.
- [ ] `game.scenarioId` ends with `.conf`.
- [ ] `game.maxPlayers` is within server policy (and valid numeric range).
- [ ] `game.gameProperties.fastValidation` is `true` for public hosting.
- [ ] `rcon.password` has no spaces and at least 3 characters (if `rcon` exists).
- [ ] `crossPlatform` and `supportedPlatforms` combination is intentional.
- [ ] `mods` entries use `modId`; `required` is set when optional behavior is desired.

## Output pattern

When asked to generate a config, use this response shape:

1. Final `config.json` snippet.
2. "Why these values" bullets (3-6 concise points).
3. "Startup parameters" bullets including `-maxFPS`.
4. "Port checklist" bullets (game, A2S, RCON as applicable).

## Minimal template

```json
{
  "game": {
    "name": "My Server",
    "scenarioId": "{ECC61978EDCC2B5A}Missions/23_Campaign.conf",
    "maxPlayers": 64,
    "visible": true,
    "crossPlatform": true,
    "gameProperties": {
      "fastValidation": true,
      "battlEye": true
    },
    "mods": []
  }
}
```

## When to apply this skill

Use this skill for requests like:
- "Create/configure Arma Reforger dedicated server JSON"
- "Validate my `config.json`"
- "Set up RCON/A2S/ports"
- "Tune public server settings"
- "Why is this Reforger server config not working?"

## Additional reference

For field-level details and constraints, read [reference.md](reference.md).
