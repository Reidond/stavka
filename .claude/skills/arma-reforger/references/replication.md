# Replication & Multiplayer Reference

## Core Concepts

- **Authority** (server): Owns the definitive state, runs game logic
- **Proxy** (client): Replicated copy, runs visuals/audio
- **Owner**: The client that controls this entity (e.g., the player's character)

## Checking Context

```enforce
// Am I the server?
if (Replication.IsServer()) { ... }

// Check via RplComponent
RplComponent rpl = RplComponent.Cast(entity.FindComponent(RplComponent));
if (rpl.IsProxy())  { /* client copy */ }
if (rpl.IsOwner())  { /* controlling client */ }
if (rpl.IsMaster()) { /* authority/server */ }

// On game mode
SCR_BaseGameMode gm = SCR_BaseGameMode.Cast(GetGame().GetGameMode());
if (gm.IsMaster()) { /* server */ }
```

## RplProp - Replicated Properties

Auto-synced from server to all clients.

```enforce
class MyComponent : ScriptComponent {
  // Simple replicated value
  [RplProp()]
  protected bool m_bFlag;

  // With change callback on proxies
  [RplProp(onRplName: "OnHealthChanged")]
  protected int m_iHealth = 100;

  // With condition (only replicate when not owner)
  [RplProp(condition: RplCondition.NoOwner)]
  protected float m_fValue;

  // With custom condition method
  [RplProp(customConditionName: "ShouldReplicate")]
  protected float m_fConditional;

  void OnHealthChanged() {
    // Called on PROXIES when m_iHealth changes
    UpdateHealthUI(m_iHealth);
  }

  bool ShouldReplicate() {
    return m_bFlag;  // Only replicate m_fConditional when flag is true
  }

  // Server-side setter
  void SetHealth(int val) {
    if (!Replication.IsServer()) return;
    m_iHealth = val;
    Replication.BumpMe();  // Force immediate push
  }
}
```

### RplProp Rules

- Only declare in the **original** class, NOT in `modded` classes
- Only the **server** should write to them
- `onRplName` callback fires on **proxy clients** when value changes
- Complex types (arrays, maps) need `Replication.BumpMe()` after mutation
- JIP players automatically receive current RplProp values

## RplRpc - Remote Procedure Calls

### Channels

| Channel | Guarantee | Use For |
|---------|-----------|---------|
| `RplChannel.Reliable` | Guaranteed, ordered delivery | State changes, critical events |
| `RplChannel.Unreliable` | Best-effort, can be dropped | Frequent updates, position sync |

### Receivers

| Receiver | Who Executes | Use For |
|----------|-------------|---------|
| `RplRcver.Server` | Server only | Client requests (input, actions) |
| `RplRcver.Owner` | Entity owner's client | Targeted feedback to one player |
| `RplRcver.Broadcast` | All clients | Effects, notifications, state sync |

### RPC Patterns

```enforce
class MyNetComponent : ScriptComponent {

  // SERVER -> ALL CLIENTS (broadcast effect)
  [RplRpc(RplChannel.Reliable, RplRcver.Broadcast)]
  protected void RpcDo_PlayExplosion(vector pos, float radius) {
    SpawnExplosionVFX(pos, radius);
    PlayExplosionSFX(pos);
  }

  // CLIENT -> SERVER (request)
  [RplRpc(RplChannel.Reliable, RplRcver.Server)]
  protected void RpcAsk_UseItem(int itemId) {
    // Validate on server
    if (!CanUseItem(itemId)) return;
    ApplyItemEffect(itemId);
    // Broadcast result to all
    Rpc(RpcDo_ItemUsed, itemId);
  }

  // SERVER -> OWNER CLIENT (targeted)
  [RplRpc(RplChannel.Reliable, RplRcver.Owner)]
  protected void RpcDo_ShowMessage(string msg) {
    ShowNotification(msg);
  }

  // Invoke RPCs
  void TriggerExplosion(vector pos) {
    // On server: send to all clients + execute locally
    Rpc(RpcDo_PlayExplosion, pos, 10.0);
    RpcDo_PlayExplosion(pos, 10.0);  // also run on authority
  }

  void ClientRequestUse(int itemId) {
    // On client: send to server
    Rpc(RpcAsk_UseItem, itemId);
  }
}
```

### RPC Naming Convention (BI Standard)

- `RpcDo_*` - Server-to-client: "do this" (play effect, show UI, update state)
- `RpcAsk_*` - Client-to-server: "can I do this?" (request, input, action)

### RPC Limitations

- Max 8 parameters per `Rpc()` call
- Cannot pass object references (only primitives, vectors, strings, enums)
- RPCs fired before a player joins are NOT received by that player (use RplProp instead)
- `Rpc()` is the wrapper that routes the call - always use it, not direct function call

## JIP (Join-In-Progress) Handling

### What Works Automatically

- `[RplProp]` values sync to joining players
- Entity positions and transform sync
- Component state via RplProp

### What Does NOT Work

- RPCs fired before join (lost forever)
- One-time events that already happened
- Non-replicated member variables

### Best Practices

```enforce
// GOOD: State via RplProp (JIP-safe)
[RplProp(onRplName: "OnScoreChanged")]
protected int m_iScore = 0;

// BAD: State via one-shot RPC (lost on JIP)
void OnScoreChange() {
  Rpc(RpcDo_UpdateScore, m_iScore);  // JIP players miss this!
}

// GOOD: Event + RplProp hybrid
void AddScore(int points) {
  if (!Replication.IsServer()) return;
  m_iScore += points;                     // RplProp auto-syncs to JIP
  Replication.BumpMe();
  Rpc(RpcDo_PlayScoreEffect, points);    // visual effect (non-critical)
}
```

## Performance Considerations

```enforce
// BAD: Polling every frame
override void EOnFrame(IEntity owner, float timeSlice) {
  CheckAllPlayers();  // expensive, runs 60x/sec on all machines
}

// GOOD: Event-driven
gameMode.GetOnPlayerKilled().Insert(OnKill);

// GOOD: Periodic via CallLater
GetGame().GetCallqueue().CallLater(PeriodicCheck, 5000, true);

// GOOD: Server-only logic guard
void ExpensiveLogic() {
  if (!Replication.IsServer()) return;
  // Only server computes
}
```

## REST API (HTTP Requests)

```enforce
class MyCallback : RestCallback {
  void MyCallback() {
    SetOnSuccess(OnSuccess);
    SetOnError(OnError);
  }
  void OnSuccess() { Print("Data: " + GetData()); }
  void OnError() { Print("Failed"); }
}

void SendRequest() {
  ref MyCallback cb = new MyCallback();
  RestContext ctx = GetGame().GetRestApi().GetContext("http://myserver.com");
  ctx.SetHeaders("Content-Type,application/json,Authorization,Bearer token");
  ctx.GET(cb, "/api/endpoint");
  ctx.POST(cb, "/api/endpoint", "{\"key\": \"value\"}");
}
```

Note: Keep `ref` to callback alive - if it goes out of scope, callback won't fire.
