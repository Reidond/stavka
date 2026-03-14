# arma-test-server

Arma Reforger dedicated server management tool written in Rust.

## Features

- **setup**: Downloads and installs SteamCMD and the Arma Reforger dedicated server
- **start**: Launches the server with various options (--fresh, --save, --fps, --config)
- **saves**: Manage save files (list, import, info)

## Installation

### From Source

```bash
cargo build --release
```

The binary will be at `target/release/arma-test-server`.

### Prerequisites

- Rust toolchain (1.85 or later)
- For Linux: `tar`, `chmod` commands available

## Usage

### Setup

Install SteamCMD and the Arma Reforger server:

```bash
arma-test-server setup
```

This will:
1. Download and extract SteamCMD
2. Use SteamCMD to download the Arma Reforger server (AppID 1874900)
3. Store everything in the OS cache directory

### Start

Start the server:

```bash
# Start with latest save
arma-test-server start

# Start fresh (no save)
arma-test-server start --fresh

# Start with specific save
arma-test-server start --save mysave

# Custom FPS limit
arma-test-server start --fps 60

# Use custom config
arma-test-server start --config /path/to/config.json
```

### Saves

Manage save files:

```bash
# List all saves
arma-test-server saves list

# Import a save file
arma-test-server saves import /path/to/save.json [optional_name]

# Show save details
arma-test-server saves info mysave
```

## Data Storage

All data is stored in the OS cache directory:

- **Linux**: `~/.cache/stavka/`
- **macOS**: `~/Library/Caches/stavka/`
- **Windows**: `%LOCALAPPDATA%\stavka\`

Directory structure:
```
stavka/
├── settings.json       # User settings (server path, directories)
├── config.json         # Server configuration
├── steamcmd/           # SteamCMD installation
├── arma-server/        # Arma Reforger server installation
├── profile/            # Server profile data
├── addons/             # Mod addons
└── saves/              # Save files
```

## Configuration

### Server Config (config.json)

The server configuration is automatically created with defaults on first run:

```json
{
  "bindAddress": "0.0.0.0",
  "bindPort": 2302,
  "publicAddress": "127.0.0.1",
  "publicPort": 2302,
  "rcon": {
    "address": "127.0.0.1",
    "port": 19999,
    "password": "stavka",
    "maxClients": 2,
    "permission": "admin"
  },
  "a2s": {
    "address": "0.0.0.0",
    "port": 17777
  },
  "game": {
    "name": "Stavka Local Test",
    "password": "",
    "passwordAdmin": "stavka",
    "scenarioId": "{68B1A0F0C0DE0002}Missions/StavkaTest_Conflict.conf",
    "maxPlayers": 4,
    "visible": true,
    "supportedPlatforms": ["PLATFORM_PC"],
    "gameProperties": {
      "serverMaxViewDistance": 2500,
      "serverMinGrassDistance": 50,
      "networkViewDistance": 1500,
      "disableThirdPerson": false,
      "fastValidation": true,
      "battlEye": false
    },
    "mods": []
  }
}
```

Edit this file to customize your server settings.

### Settings (settings.json)

Created automatically after setup:

```json
{
  "serverBin": "/path/to/ArmaReforgerServer",
  "profileDir": "./profile",
  "addonsDir": "./addons"
}
```

## Commands Reference

```
arma-test-server <COMMAND>

Commands:
  setup  Setup and install the Arma Reforger server
  start  Start the Arma Reforger server
  saves  Manage save files
  help   Print this message or the given subcommand(s)

Options:
  -h, --help     Print help
  -V, --version  Print version
```

## License

MIT
