# Arma Reforger Hosting Reference

Condensed source notes for hosting workflows.

## Hosting modes

- **Player-hosted (listen server):** local player + server in one session.
- **Dedicated:** standalone server process, no local player.

## Public reachability

- Public access requires router/NAT port forwarding.
- If outside clients cannot connect, verify forwarded UDP ports and firewall rules.

## BattlEye (`BEServer_x64.cfg`)

Allowed additive entries:

```txt
RConPort 5678
RConPassword myNewBEPassword
```

Safety:
- Append new keys; do not remove or modify required existing lines.
- Broken BattlEye config can cause kicks or non-functional anti-cheat/RCon.
- Recovery path: delete bad file and verify game files in Steam.

## Startup parameters

- `-config "<path>"` loads JSON configuration file.
- `-maxFPS <value>` recommended (typically `60..120`) to avoid runaway resource usage.
- `-server "<world.ent>"` starts local world and ignores `-config`.
- Optional diagnostics:
  - `-logStats`
  - `-logLevel`
  - `-listScenarios`

## SteamCMD setup essentials

- Stable app ID: `1874900`
- Experimental app ID: `1890870`

Minimal script pattern:

```bash
@ShutdownOnFailedCommand 1
@NoPromptForPassword 1
force_install_dir ../armar_ds
login anonymous
app_update 1874900 validate
quit
```

Run with:

```bash
steamcmd +runscript update_armar_ds.txt
```

## Linux/Docker notes

- In containerized setups, clients may fail if the server registers container-only IP.
- Prefer explicit reachable host IP/port registration fields in config where needed.
- Join troubleshooting:
  - test local IP direct connect first,
  - then validate published UDP ports and bind/register settings.
- Docker mod download errors related to write access can be mitigated with `-addonTempDir <writable-path>`.

## Suggested troubleshooting sequence

1. Confirm process starts and reads intended config/flags.
2. Validate correct scenario/world path.
3. Check UDP ports and forwarding.
4. Confirm BattlEye file integrity if RCon/BattlEye issues appear.
5. Re-test with direct IP connect.
6. If Linux containerized, validate advertised IP/port is externally reachable.
