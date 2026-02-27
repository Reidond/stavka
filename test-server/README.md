# test-server

Run a local Arma Reforger dedicated server with saved Conflict state for testing Stavka scripts.

## Setup

1. Install dependencies from the repo root:

```bash
npm install
```

2. Run the setup script to download the server and configure paths:

```bash
node setup.ts
```

This will:
- Find or prompt for SteamCMD
- Download Arma Reforger Dedicated Server (AppID `1874900`) via SteamCMD
- Create `settings.json` with the correct server binary path

To update the server later, run `node setup.ts` again.

### Manual setup

If you prefer to set things up manually:

```bash
cp settings.example.json settings.json
```

Edit `settings.json` with your paths:

```json
{
  "serverBin": "/path/to/ArmaReforgerServer",
  "profileDir": "./profile",
  "addonsDir": "../mods"
}
```

## Getting a save file

Play Conflict on any server. The server stores saves as JSON files in:

```
<server-profile>/.save/sessions/
```

Import a save:

```bash
node saves.ts import /path/to/conflict-save.json
```

## Starting the server

```bash
# Load the latest save
node start.ts

# Load a specific save
node start.ts --save mysave

# Start fresh (no save)
node start.ts --fresh
```

The server binds to `127.0.0.1:2001` by default (see `config.json`).

## Managing saves

```bash
# List all saves
node saves.ts list

# Import a save file (with optional rename)
node saves.ts import /path/to/save.json [name]

# Inspect a save
node saves.ts info mysave
```

## Running tests

1. Start the server with a Conflict save
2. Connect to `127.0.0.1:2001` in Arma Reforger
3. Type `!test conflict` in game chat

## Config

- `config.json` — Arma Reforger server configuration (scenario, ports, player count)
- `settings.json` — local paths (gitignored)
- `addonsDir` defaults to `../mods`, so the StavkaTest mod is loaded automatically
