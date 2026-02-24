# Entity Component System Reference

## Entity Hierarchy

```
Managed
  IEntity
    GenericEntity
      ScriptedGameEntity
        BaseGameMode > SCR_BaseGameMode
        ChimeraCharacter > SCR_ChimeraCharacter
        Vehicle
        AIAgent > ChimeraAIAgent > SCR_ChimeraAIAgent / SCR_PlayerAIAgent
        AIGroup > ChimeraAIGroup > SCR_AIGroup
```

Every entity class has a matching `*Class` prefab data counterpart:
```enforce
GenericEntityClass > SCR_BaseGameModeClass : BaseGameModeClass
```

## Entity Lifecycle

```enforce
void EOnInit(IEntity owner)
void EOnFrame(IEntity owner, float timeSlice)
void EOnPostFrame(IEntity owner, float timeSlice)
void EOnContact(IEntity owner, IEntity other, Contact contact)
void EOnActivate(IEntity owner)
void EOnDeactivate(IEntity owner)
void EOnDelete(IEntity owner)
```

Register for events: `SetEventMask(owner, EntityEvent.FRAME | EntityEvent.INIT);`

## ScriptComponent Lifecycle

1. `EOnInit(owner)` - Entity initialized
2. `OnPostInit(owner)` - All components ready, query siblings here
3. `EOnActivate(owner)` - Entity activated
4. `EOnFrame(owner, timeSlice)` - Each frame (needs `EntityEvent.FRAME`)
5. `EOnContact(owner, other, contact)` - Physics collision
6. `EOnDelete(owner)` - Cleanup

## Creating Custom Components

```enforce
[ComponentEditorProps(category: "MyMod", description: "Description")]
class MyComponentClass : ScriptComponentClass {}

class MyComponent : ScriptComponent {
  [Attribute("0", UIWidgets.EditBox, desc: "My value")]
  protected int m_iMyValue;

  override void OnPostInit(IEntity owner) {
    super.OnPostInit(owner);
    SetEventMask(owner, EntityEvent.FRAME);
  }

  override void EOnFrame(IEntity owner, float timeSlice) { }
}
```

## Finding Components

```enforce
MyComponent comp = MyComponent.Cast(entity.FindComponent(MyComponent));
if (!comp) return;
```

## Core Built-in Components

| Component | Purpose |
|-----------|---------|
| `RplComponent` | Network replication |
| `HierarchyComponent` | Parent-child transforms |
| `RigidBodyComponent` | Physics rigid body |
| `MeshObject` | Visual mesh |
| `CharacterControllerComponent` | Character movement |
| `SCR_CharacterControllerComponent` | Scripted character extension |
| `DamageManagerComponent` | Hit zones, damage |
| `SCR_DamageManagerComponent` | Scripted damage (burn, repair) |
| `FactionAffiliationComponent` | Faction assignment |
| `ActionsManagerComponent` | User actions |
| `BaseWeaponManagerComponent` | Weapon slots |
| `CompartmentAccessComponent` | Vehicle compartments |
| `PerceptionComponent` | AI sight/sound |
| `AIPathfindingComponent` | AI navigation |
| `SoundComponent` | Audio playback |

## Character System

### SCR_ChimeraCharacter

```enforce
SCR_ChimeraCharacter char = SCR_ChimeraCharacter.Cast(entity);
Faction faction = char.GetFaction();
string factionKey = char.GetFactionKey();
bool driving = char.IsDriving();
bool inVehicle = char.IsInVehicle();
CompartmentAccessComponent access = char.GetCompartmentAccessComponent();
```

### SCR_CharacterControllerComponent

```enforce
SCR_CharacterControllerComponent ctrl = SCR_CharacterControllerComponent.Cast(
    entity.FindComponent(SCR_CharacterControllerComponent));

ECharacterLifeState lifeState = ctrl.GetLifeState(); // ALIVE, INCAPACITATED, DEAD
bool canInteract = ctrl.CanInteract();
BaseWeaponManagerComponent wpn = ctrl.GetWeaponManagerComponent();

// Events
ctrl.m_OnPlayerDeath.Insert(OnDeath);
ctrl.GetOnPlayerDeathWithParam().Insert(OnDeathWithParam);
ctrl.m_OnLifeStateChanged.Insert(OnLifeStateChanged);
```

### Damage System

```enforce
SCR_DamageManagerComponent dmg = SCR_DamageManagerComponent.Cast(
    entity.FindComponent(SCR_DamageManagerComponent));
EDamageState state = dmg.GetState();  // FINE, DAMAGED, DESTROYED
```

Enums: `EDamageType` (KINETIC, EXPLOSION, FIRE, COLLISION, MELEE, FRAGMENTATION, HEALING)
`ECharacterLifeState` (ALIVE, INCAPACITATED, DEAD)

## Vehicle System

```enforce
// Get vehicle from character
CompartmentAccessComponent access = character.GetCompartmentAccessComponent();
BaseCompartmentSlot slot = access.GetCompartment();
PilotCompartmentSlot pilot = PilotCompartmentSlot.Cast(slot);
Vehicle vehicle = Vehicle.Cast(pilot.GetOwner());
```

Compartment types: `PilotCompartmentSlot`, `TurretCompartmentSlot`, `CargoCompartmentSlot`

## Weapon System

```enforce
BaseWeaponManagerComponent wpnMan = ctrl.GetWeaponManagerComponent();
BaseWeaponComponent weapon = wpnMan.GetCurrentWeapon();
EWeaponType wt = weapon.GetWeaponType();

BaseMuzzleComponent muzzle = BaseMuzzleComponent.Cast(
    weaponEntity.FindComponent(BaseMuzzleComponent));
```

## AI System

### AI Group Workflow

```enforce
// 1. Spawn group
Resource res = Resource.Load("{GUID}Prefabs/Groups/OPFOR/Group_USSR_RifleSquad.et");
IEntity ent = GetGame().SpawnEntityPrefab(res, world, params);
SCR_AIGroup group = SCR_AIGroup.Cast(ent);

// 2. Wait for init (1-2 seconds)
GetGame().GetCallqueue().CallLater(AssignWP, 2000, false);

// 3. Spawn waypoint and assign
Resource wpRes = Resource.Load("{GUID}Prefabs/AI/Waypoints/AIWaypoint_ForcedMove.et");
AIWaypoint wp = AIWaypoint.Cast(
    GetGame().SpawnEntityPrefab(wpRes, world, wpParams));
wp.SetCompletionRadius(30);
group.AddWaypoint(wp);

// 4. Query state
int count = group.GetAgentsCount();
AIAgent leader = group.GetLeaderAgent();
AIWaypoint curWP = group.GetCurrentWaypoint();
bool initializing = group.IsInitializing();
```

### AI Agent Hierarchy

```
AIAgent > ChimeraAIAgent
  > SCR_ChimeraAIAgent      // NPC
  > SCR_PlayerAIAgent        // Player-controlled AI
AIGroup > ChimeraAIGroup > SCR_AIGroup
```

### AI Components

| Component | Purpose |
|-----------|---------|
| `AICharacterMovementComponent` | Foot soldier movement |
| `AICarMovementComponent` | Vehicle driving |
| `AIChimeraBehaviorTreeComponent` | Behavior trees |
| `SCR_AIBaseUtilityComponent` | Decision making |
| `SCR_MailboxComponent` | Agent messaging |
| `ChimeraAIPathfindingComponent` | Navigation |
| `AICombatPropertiesComponent` | Combat behavior |

### Waypoint Prefabs

| Prefab | Behavior |
|--------|----------|
| `AIWaypoint_ForcedMove.et` | Move to position directly |
| `AIWaypoint_Attack.et` | Attack area |
| `AIWaypoint_Defend.et` | Defend position |
| `AIWaypoint_Patrol.et` | Patrol area |
| `AIWaypoint_SearchAndDestroy.et` | Hunt enemies |
| `AIWaypoint_GetIn.et` | Enter vehicle |

## World Queries

```enforce
// Entities in sphere
GetGame().GetWorld().QueryEntitiesBySphere(center, radius,
    func(IEntity e) {
      // return true to continue, false to stop
      return true;
    }, EQueryEntitiesFlags.ALL);

// Raycast
TraceParam param = new TraceParam();
param.Start = startPos;
param.End = endPos;
param.Flags = TraceFlags.ENTS | TraceFlags.WORLD;
float fraction = GetGame().GetWorld().TraceMove(param, null);
IEntity hit = param.TraceEnt;
vector hitPos = param.TracePos;
```

## Spawning Entities

```enforce
EntitySpawnParams params = new EntitySpawnParams();
params.TransformMode = ETransformMode.WORLD;
params.Transform[3] = position;

Resource res = Resource.Load("{GUID}path/to/prefab.et");
IEntity spawned = GetGame().SpawnEntityPrefab(res, GetGame().GetWorld(), params);
```

## Game Mode Events

### SCR_BaseGameMode Overrides

```enforce
OnGameModeStart()
OnGameModeEnd(SCR_GameModeEndData data)
OnGameStateChanged()
OnPlayerConnected(int playerId)              // server only
OnPlayerRegistered(int playerId)             // server + clients
OnPlayerDisconnected(int playerId, KickCauseCode cause, int timeout)
OnPlayerSpawned(int playerId, IEntity player)
OnPlayerKilled(notnull SCR_InstigatorContextData data)
OnPlayerDeleted(int playerId, IEntity player)
OnControllableSpawned(IEntity entity)
OnControllableDestroyed(notnull SCR_InstigatorContextData data)
OnWorldPostProcess(World world)
```

### Game Mode State

```enforce
enum SCR_EGameModeState { PREGAME, GAME, POSTGAME }

SCR_BaseGameMode gm = SCR_BaseGameMode.Cast(GetGame().GetGameMode());
bool running = gm.IsRunning();
SCR_EGameModeState state = gm.GetState();
float elapsed = gm.GetElapsedTime();
bool isMaster = gm.IsMaster();
```

### SCR_BaseGameModeComponent Pattern

Preferred approach for mods - receive all game mode events via component:

```enforce
class MyGMComponentClass : SCR_BaseGameModeComponentClass {}

class MyGMComponent : SCR_BaseGameModeComponent {
  override void OnGameModeStart() { }
  override void OnPlayerConnected(int playerId) { }
  override void OnPlayerKilled(notnull SCR_InstigatorContextData data) { }
}
```

## Key Singletons / Managers

```enforce
GetGame()                                    // ArmaReforgerScripted
GetGame().GetWorld()                         // BaseWorld
GetGame().GetWorkspace()                     // WorkspaceWidget (UI root)
GetGame().GetMenuManager()                   // MenuManager
GetGame().GetPlayerManager()                 // PlayerManager
GetGame().GetPlayerController()              // local PlayerController
GetGame().GetGameMode()                      // BaseGameMode
GetGame().GetInputManager()                  // InputManager
GetGame().GetCallqueue()                     // ScriptCallQueue
GetGame().GetRestApi()                       // RestApi (HTTP)

SCR_RespawnSystemComponent.GetInstance()     // Respawn system
```
