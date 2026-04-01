# Field Reference (Condensed)

This reference captures the most important constraints from the Arma Reforger server hosting documentation for practical config authoring and reviews.

## Root

- `bindAddress` (string): usually omit/empty; default behavior binds all interfaces.
- `bindPort` (number, 1..65535, default `2001`): game UDP bind port; usually align with `publicPort`.
- `publicAddress` (string): usually omit/empty for auto-detection.
- `publicPort` (number, 1..65535, default `2001`): backend-registered public UDP port.
- `a2s` (object, optional): Steam query binding.
- `rcon` (object, optional): remote console binding/auth.
- `game` (object, required): main server gameplay configuration.
- `operating` (object, optional): operational server behavior.

## Ports (public hosting summary)

- `2001/UDP`: gameplay/public port (required in normal internet hosting).
- `17777/UDP`: A2S/Steam query port (optional but common).
- `19999/UDP`: RCON port (optional; required if remote admin console is used).

## `a2s`

- `address` (string, required if `a2s` exists): interface bind address.
- `port` (number, 1..65535, default `17777`): A2S UDP query port.

## `rcon`

- `address` (string, required if `rcon` exists)
- `port` (number, 1..65535, default `19999`)
- `password` (string, required for RCON startup):
  - no spaces
  - at least 3 chars
- `maxClients` (number, 1..16, default `16`)
- `permission` (string): `admin` or `monitor`
- `blacklist` (array, default `[]`)
- `whitelist` (array, default `[]`)

## `game`

- `name` (string, length 0..100)
- `password` (string): join password
- `passwordAdmin` (string): admin login password; no spaces
- `admins` (array): identity IDs and/or steam IDs
- `scenarioId` (string, required in real configs): `.conf` mission path
- `maxPlayers` (number, 1..128, default `64`)
- `visible` (bool, default `true`)
- `crossPlatform` (bool, default `false`)
- `supportedPlatforms` (array): usually leave undefined when using `crossPlatform`
- `modsRequiredByDefault` (bool, default `true`)
- `mods` (array): list of workshop mods

## `game.gameProperties`

- `serverMaxViewDistance` (500..10000, default `1600`)
- `serverMinGrassDistance` (0 or 50..150, default `0`)
- `networkViewDistance` (500..5000, default `1500`)
- `fastValidation` (bool, default `true`) - keep `true` for public servers
- `battlEye` (bool, default `true`)
- `disableThirdPerson` (bool, default `false`)
- `VONDisableUI` (bool, default `false`)
- `VONDisableDirectSpeechUI` (bool, default `false`)
- `VONCanTransmitCrossFaction` (bool, default `false`)
- `missionHeader` (object, optional): scenario header overrides
- `persistence` (object, optional in newer versions): save/hive/database tuning

## `mods` entries

Each item can include:
- `modId` (string GUID)
- `name` (string, comment-like/human readable)
- `version` (string, optional; latest used when omitted)
- `required` (bool, default true or inherited from `modsRequiredByDefault`)

## `operating`

Common fields:
- `lobbyPlayerSynchronise` (bool, default `true`)
- `disableCrashReporter` (bool, default `false`)
- `disableNavmeshStreaming` (bool in older versions, array in newer versions)
- `disableServerShutdown` (bool, default `false`)
- `disableAI` (bool, default `false`)
- `playerSaveTime` (number, default `120`)
- `aiLimit` (number, default `-1`)
- `slotReservationTimeout` (number, 5..300, default `60`)
- `joinQueue.maxSize` (number, 0..50, default `0`)

## Compatibility notes

- Several keys were renamed before 0.9.8.73; prefer current names in modern configs.
- `disableNavmeshStreaming` changed type across versions (bool -> array behavior).
- `a2s` and `rcon` root objects were formalized in later versions.

## Safety notes

- Public host baseline:
  - `fastValidation: true`
  - `battlEye: true`
  - FPS cap via startup param `-maxFPS`
- IPv6 is not supported in these documented settings.
