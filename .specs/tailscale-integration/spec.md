# Spec: Tailscale Integration for Arma Test Server

## Summary

A new Rust crate `tailscale-integration` that automatically configures Tailscale networking for the Arma Reforger test server. When enabled, it detects or configures a Tailscale IP, generates auth keys for inviting new users, and updates the Arma server config to advertise the Tailscale IP — all with zero manual networking setup.

---

## 1. Requirements

### 1.1 Functional

1. **Tailscale IP detection**: On server start, detect the machine's Tailscale IP address automatically
2. **Auto-config Arma server**: Update `config.json` `public_address` to the Tailscale IP when Tailscale mode is enabled
3. **User invite generation**: Generate Tailscale auth keys for new users to join the tailnet
4. **Dual invite methods**: Support both auth key (copy-paste) and email invite flows
5. **ACL management**: Configure Tailscale ACLs so invited users can only access the Arma server (port 2302) and internet, blocked from other tailnet resources
6. **Tag-based isolation**: Use Tailscale tags (`tag:arma-server` for the server node, `tag:arma-player` for user nodes) for ACL enforcement
7. **Terminal UX**: Print invite links and instructions in the terminal for easy sharing
8. **Credential management**: Store OAuth client credentials securely in the stavka cache directory

### 1.2 Non-functional

1. **Optional**: Tailscale integration is opt-in via CLI flag; existing behavior unchanged without it
2. **Graceful degradation**: If Tailscale is not installed or not running, warn and fall back to normal mode
3. **Cross-platform**: Works on Windows and Linux (matching existing crate support)
4. **No breaking changes**: Existing `arma-test-server` commands work identically

---

## 2. Architecture

### 2.1 Crate structure

```
crates/tailscale-integration/
├── Cargo.toml
├── src/
│   ├── lib.rs              # Public API, re-exports
│   ├── client.rs           # Tailscale API client (OAuth, auth keys, devices)
│   ├── config.rs           # Tailscale-specific config (credentials, tailnet ID)
│   ├── ip.rs               # Tailscale IP detection (local tailscale status)
│   ├── invite.rs           # User invite flow (auth keys + email)
│   ├── acl.rs              # ACL management (policy file updates)
│   └── integration.rs      # Bridge to arma-test-server (config update)
```

### 2.2 Dependencies

| Dependency | Purpose |
|---|---|
| `reqwest` | HTTP client for Tailscale API (already in workspace) |
| `serde` / `serde_json` | API request/response serialization (already in workspace) |
| `tokio` | Async runtime (already in workspace) |
| `anyhow` | Error handling (already in workspace) |
| `dirs` | Cache directory for credentials (already in workspace) |
| `oauth2` | OAuth 2.0 client credentials flow |
| `url` | URL parsing for invite links |

### 2.3 Tailscale API integration

**OAuth flow** (user provides client ID + secret once):
- Token endpoint: `https://api.tailscale.com/api/v2/oauth/token`
- Scopes needed: `devices:core` (list/tag devices), `auth_keys` (generate auth keys), `policy` (read/write ACLs)

**Key API endpoints**:
- `GET /api/v2/tailnet/{tailnet}/devices` — list devices, find tagged server
- `POST /api/v2/tailnet/{tailnet}/keys` — generate auth key for new users
- `GET /api/v2/tailnet/{tailnet}/policy` — read current ACL policy
- `POST /api/v2/tailnet/{tailnet}/policy` — update ACL policy with new rules
- `POST /api/v2/user/{email}/invites` — send email invite (if supported)

### 2.4 Integration with `arma-test-server`

The `start` command gains a `--tailscale` flag:

```
arma-test-server start --tailscale
```

Flow:
1. Check if Tailscale is running locally (`tailscale status` via CLI or local API socket)
2. If not running, offer to guide setup (print instructions, exit)
3. If running, get Tailscale IP from local status
4. Generate OAuth token from stored credentials
5. Verify server node has `tag:arma-server` (auto-tag if not)
6. Update `config.json` `public_address` to Tailscale IP
7. Print connection info: Tailscale IP, port, invite link
8. Start Arma server normally with updated config

### 2.5 Invite subcommand

```
arma-test-server tailscale invite [--email <email>] [--count <n>]
```

- Without `--email`: generates a reusable auth key, prints `tailscale up --auth-key=...` command
- With `--email`: sends email invite via Tailscale API
- `--count`: generate N auth keys at once (default: 1)
- Prints formatted terminal output with copy-paste instructions

---

## 3. Data Models

### 3.1 Tailscale config (`tailscale.json` in cache dir)

```json
{
  "oauth_client_id": "tskey-client-...",
  "oauth_client_secret": "tskey-client-...",
  "tailnet": "example.com",
  "server_tag": "tag:arma-server",
  "player_tag": "tag:arma-player"
}
```

### 3.2 Auth key request

```rust
struct CreateAuthKeyRequest {
    capabilities: AuthKeyCapabilities,
    expiry_seconds: u64,      // default: 7 days
    description: String,      // "Stavka player invite - 2026-03-31"
}

struct AuthKeyCapabilities {
    devices: DeviceCapabilities,
}

struct DeviceCapabilities {
    create: CreateDeviceCapability,
}

struct CreateDeviceCapability {
    tags: Vec<String>,        // ["tag:arma-player"]
    preauthorized: bool,      // true
    ephemeral: bool,          // true (auto-cleanup when user disconnects)
}
```

### 3.3 ACL policy structure

The ACL policy file (HuJSON) will be managed with these rules:

```jsonc
{
  "groups": {
    "group:arma-players": ["tag:arma-player"]
  },
  "hosts": {
    "arma-server": "tag:arma-server"
  },
  "acls": [
    // Players can reach Arma server on port 2302
    {
      "action": "accept",
      "src": ["tag:arma-player"],
      "dst": ["tag:arma-server:2302"]
    },
    // Players can reach internet (exit nodes if configured)
    {
      "action": "accept",
      "src": ["tag:arma-player"],
      "dst": ["*:*"]
    }
  ],
  "tagOwners": {
    "tag:arma-server": ["autogroup:admin"],
    "tag:arma-player": ["autogroup:admin"]
  }
}
```

---

## 4. CLI Design

### 4.1 New top-level subcommand

```
arma-test-server tailscale <SUBCOMMAND>
```

Subcommands:
- `setup` — Configure OAuth credentials, verify connection, set up tags/ACLs
- `status` — Show current Tailscale status (IP, connected devices, server tag)
- `invite` — Generate auth keys or send email invites for new players
- `cleanup` — Revoke unused auth keys, remove stale player devices

### 4.2 Modified existing command

```
arma-test-server start --tailscale
```

New flags on `start`:
- `--tailscale` — Enable Tailscale mode (auto-detect IP, update config)
- `--tailscale-invite` — After starting server, print invite info and wait for user to press Enter

---

## 5. Implementation Tasks

### Phase 1: Crate scaffold and API client
1. Create `crates/tailscale-integration/` with `Cargo.toml`
2. Implement `client.rs` — Tailscale API client with OAuth token management
3. Implement `config.rs` — Load/save `tailscale.json` from cache dir
4. Implement `ip.rs` — Detect Tailscale IP (local CLI call or status socket)

### Phase 2: Core functionality
5. Implement `invite.rs` — Auth key generation and email invite flows
6. Implement `acl.rs` — ACL policy read/update with tag management
7. Implement `integration.rs` — Bridge: update Arma config with Tailscale IP

### Phase 3: CLI integration
8. Add `tailscale` subcommand to `arma-test-server` CLI (clap)
9. Add `--tailscale` flag to `start` command
10. Wire up all subcommands to library functions

### Phase 4: Polish
11. Terminal UX: formatted output for invites, status, connection info
12. Error handling: graceful fallback when Tailscale unavailable
13. Documentation: README, setup guide, troubleshooting

---

## 6. Risks & Mitigations

| Risk | Mitigation |
|---|---|
| Tailscale not installed on host machine | Detect early, print setup instructions, exit gracefully |
| OAuth token expiry (1 hour) | Auto-refresh token before each API call |
| ACL policy conflicts with existing rules | Read existing policy, merge changes, preserve user modifications |
| Tags already defined with different owners | Detect and warn, don't overwrite without confirmation |
| Tailscale API rate limits | Implement basic retry with backoff |
| Windows local API access | Use `tailscale status` CLI as fallback for local API socket |

---

## 7. Open Questions

1. **Tailnet ID**: Should we auto-detect the tailnet from the OAuth token, or require user to specify it during `setup`?
2. **ACL management scope**: Should we manage the full ACL policy file, or only append our rules and leave the rest untouched? (Recommendation: merge, don't overwrite)
3. **Email invites**: Tailscale's email invite API requires the user to already exist in the identity provider. Should we fall back to auth keys if email invite fails?
4. **Server auto-tagging**: Should the `setup` command automatically tag the local machine as `tag:arma-server`, or require manual tagging? (Recommendation: auto-tag)
