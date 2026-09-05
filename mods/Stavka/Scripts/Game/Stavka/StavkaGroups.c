class StavkaManagedGroup
{
  SCR_AIGroup entity;
  AIWaypoint waypoint;
  ref StavkaGroupState state = new StavkaGroupState();
  string pendingCommand;
  string pendingKind;
  string initialBehavior;
  string spawnObjective;
  float deadline;
  float strengthChangedAt;
  int previousStrength = -1;
  bool spawnedByStavka;
  ref map<AIAgent, int> previousLods = new map<AIAgent, int>();
}

// Only this registry grants authority over a group. A protocol group id is never
// resolved by querying arbitrary entities, and player membership revokes control.
class StavkaGroups
{
  ref StavkaConfig config;
  ref map<string, ref StavkaManagedGroup> groups = new map<string, ref StavkaManagedGroup>();
  ref map<string, ref StavkaCommandReceipt> receipts = new map<string, ref StavkaCommandReceipt>();
  ref map<string, string> dirtyReceipts = new map<string, string>();
  ref map<string, ref StavkaObjectiveState> objectives = new map<string, ref StavkaObjectiveState>();
  ref map<string, ref StavkaKnownEnemy> contacts = new map<string, ref StavkaKnownEnemy>();
  ref array<string> events = {};
  int eventSequence;
  int adoptedSequence;

  void StavkaGroups(StavkaConfig settings)
  {
    config = settings;
  }

  float Now()
  {
    return GetGame().GetWorld().GetWorldTime() * 0.001;
  }

  void Result(string id, string status, string reason = "")
  {
    StavkaCommandReceipt receipt = new StavkaCommandReceipt();
    receipt.id = id;
    receipt.status = status;
    receipt.reason = reason;
    receipts.Set(id, receipt);
    dirtyReceipts.Set(id, receipt.ToJson());
  }

  void Event(string kind, string groupId, vector position, string significance = "notable")
  {
    // Snapshot reconciliation still reports final state if the event buffer fills.
    if (events.Count() >= 256) return;
    eventSequence++;
    string eventId = config.sessionId + ":" + config.epoch.ToString() + ":" + eventSequence.ToString();
    string payload = "{\"id\":" + StavkaWire.Quote(eventId) + ",\"type\":" + StavkaWire.Quote(kind);
    payload += ",\"timestamp\":" + System.GetUnixTime().ToString() + ",\"significance\":" + StavkaWire.Quote(significance);
    payload += ",\"group_id\":" + StavkaWire.Quote(groupId) + ",\"position\":" + StavkaWire.Position(position) + "}";
    events.Insert(payload);
  }

  bool SafeGroup(SCR_AIGroup group)
  {
    return group && group.GetFaction() && group.GetFaction().GetFactionKey() == config.engineFaction && group.GetPlayerCount(true) == 0;
  }

  bool Adopt(IEntity entity)
  {
    SCR_AIGroup group = SCR_AIGroup.Cast(entity);
    if (!SafeGroup(group) || groups.Count() >= config.maxGroups) return true;
    foreach (string id, StavkaManagedGroup managed : groups)
    {
      if (managed.entity == group) return true;
    }
    adoptedSequence++;
    StavkaManagedGroup adopted = new StavkaManagedGroup();
    adopted.entity = group;
    adopted.state.id = "adopted-" + adoptedSequence.ToString();
    adopted.state.templateName = "mission_group";
    adopted.state.faction = config.faction;
    groups.Insert(adopted.state.id, adopted);
    return true;
  }

  void ScanExisting()
  {
    if (config.adoptExistingGroups)
      GetGame().GetWorld().QueryEntitiesBySphere(vector.Zero, 50000, Adopt, null, EQueryEntitiesFlags.ALL);
  }

  bool GroundPosition(vector requested, out vector grounded)
  {
    BaseWorld world = GetGame().GetWorld();
    vector minimum, maximum;
    world.GetBoundBox(minimum, maximum);
    if (requested[0] < minimum[0] || requested[0] > maximum[0] || requested[2] < minimum[2] || requested[2] > maximum[2]) return false;
    float height = world.GetSurfaceY(requested[0], requested[2]);
    if (!StavkaWire.IsFinite(height) || height == -256) return false;
    grounded = requested;
    grounded[1] = height + 0.3;
    return true;
  }

  void Execute(StavkaCommand command)
  {
    if (!Replication.IsServer()) return;
    if (receipts.Contains(command.id))
    {
      dirtyReceipts.Set(command.id, receipts.Get(command.id).ToJson());
      return;
    }
    // Never evict an id and risk executing it twice in the same mission epoch.
    if (receipts.Count() >= 8192) return;
    if (!command.valid) { Result(command.id, "failed", "invalid_or_unsupported_command"); return; }
    if (!command.behavior.IsEmpty() && command.behavior != "native" && command.behavior != "defend")
    {
      Result(command.id, "failed", "unsupported_behavior");
      return;
    }
    if (command.kind == "spawn_group") { Spawn(command); return; }
    if (command.kind == "set_objective") { Objective(command); return; }
    StavkaManagedGroup managed = groups.Get(command.groupId);
    if (!managed || !SafeGroup(managed.entity)) { Result(command.id, "failed", "group_not_controllable"); return; }
    if (command.kind == "despawn_group")
    {
      if (!managed.spawnedByStavka) { Result(command.id, "failed", "mission_group_cannot_be_deleted"); return; }
      Cancel(managed, "despawned");
      DeleteGroup(managed);
      groups.Remove(command.groupId);
      Result(command.id, "completed");
      Event("group_despawned", command.groupId, managed.state.position);
      return;
    }
    Assign(managed, command);
  }

  void Spawn(StavkaCommand command)
  {
    if ((!command.faction.IsEmpty() && command.faction != config.faction) || !config.templates.Contains(command.templateName))
    { Result(command.id, "failed", "template_or_faction_not_allowed"); return; }
    if (!command.objectiveId.IsEmpty() && !objectives.Contains(command.objectiveId))
    { Result(command.id, "failed", "unknown_target_objective"); return; }
    int cost = 6;
    if (groups.Count() >= config.maxGroups || config.manpower < cost)
    { Result(command.id, "failed", "reinforcement_limit"); return; }
    vector position;
    if (!GroundPosition(command.position, position)) { Result(command.id, "failed", "invalid_position"); return; }
    Resource resource = Resource.Load(config.templates.Get(command.templateName));
    if (!resource || !resource.IsValid()) { Result(command.id, "failed", "prefab_unavailable"); return; }
    EntitySpawnParams parameters = new EntitySpawnParams();
    parameters.TransformMode = ETransformMode.WORLD;
    parameters.Transform[3] = position;
    IEntity entity = GetGame().SpawnEntityPrefab(resource, GetGame().GetWorld(), parameters);
    SCR_AIGroup group = SCR_AIGroup.Cast(entity);
    if (!group)
    {
      if (entity) SCR_EntityHelper.DeleteEntityAndChildren(entity);
      Result(command.id, "failed", "spawn_failed");
      return;
    }
    StavkaManagedGroup managed = new StavkaManagedGroup();
    managed.entity = group;
    group.SpawnMembers();
    managed.spawnedByStavka = true;
    managed.state.id = "g-" + command.id;
    managed.state.faction = config.faction;
    managed.state.templateName = command.templateName;
    managed.state.position = position;
    managed.state.status = "initializing";
    managed.pendingCommand = command.id;
    managed.pendingKind = command.kind;
    managed.initialBehavior = command.behavior;
    managed.spawnObjective = command.objectiveId;
    managed.deadline = Now() + 30;
    groups.Insert(managed.state.id, managed);
    config.manpower -= cost;
    Result(command.id, "accepted", managed.state.id);
  }

  void ClearWaypoint(StavkaManagedGroup managed)
  {
    if (!managed.waypoint) return;
    if (managed.entity) managed.entity.RemoveWaypoint(managed.waypoint);
    SCR_EntityHelper.DeleteEntityAndChildren(managed.waypoint);
    managed.waypoint = null;
  }

  void Cancel(StavkaManagedGroup managed, string reason)
  {
    if (!managed.pendingCommand.IsEmpty()) Result(managed.pendingCommand, "failed", reason);
    managed.pendingCommand = "";
    ClearWaypoint(managed);
  }

  void KeepNativeAIActive(StavkaManagedGroup managed)
  {
    if (!managed.spawnedByStavka || !managed.entity) return;
    managed.entity.ActivateAI();
    array<AIAgent> agents = {};
    managed.entity.GetAgents(agents);
    foreach (AIAgent agent : agents)
    {
      if (!agent) continue;
      if (!managed.previousLods.Contains(agent)) managed.previousLods.Insert(agent, agent.GetPermanentLOD());
      // The engine's supported external ownership pin keeps the 1.8 dormant
      // lifecycle from removing a squad while Commander owns its movement.
      agent.SetPermanentLOD(0);
      agent.ActivateAI();
    }
  }

  void ReleaseNativeAI(StavkaManagedGroup managed)
  {
    foreach (AIAgent agent, int previous : managed.previousLods)
    {
      if (agent) agent.SetPermanentLOD(previous);
    }
    managed.previousLods.Clear();
  }

  void Assign(StavkaManagedGroup managed, StavkaCommand command)
  {
    vector position;
    if (!GroundPosition(command.position, position)) { Result(command.id, "failed", "invalid_position"); return; }
    ResourceName prefab;
    string status;
    if (command.kind == "move_group") { prefab = "{06E1B6EBD480C6E0}Prefabs/AI/Waypoints/AIWaypoint_ForcedMove.et"; status = "moving"; }
    else if (command.kind == "attack_group") { prefab = "{1B0E3436C30FA211}Prefabs/AI/Waypoints/AIWaypoint_Attack.et"; status = "engaged"; }
    else if (command.kind == "sweep_group") { prefab = "{B3E7B8DC2BAB8ACC}Prefabs/AI/Waypoints/AIWaypoint_SearchAndDestroy.et"; status = "engaged"; }
    else if (command.kind == "defend_group") { prefab = "{93291E72AC23930F}Prefabs/AI/Waypoints/AIWaypoint_Defend.et"; status = "defending"; }
    else if (command.kind == "patrol_group") { prefab = "{22A875E30470BD4F}Prefabs/AI/Waypoints/AIWaypoint_Patrol.et"; status = "patrolling"; }
    else { Result(command.id, "failed", "unsupported_command"); return; }
    Resource resource = Resource.Load(prefab);
    if (!resource || !resource.IsValid()) { Result(command.id, "failed", "waypoint_unavailable"); return; }
    EntitySpawnParams parameters = new EntitySpawnParams();
    parameters.TransformMode = ETransformMode.WORLD;
    parameters.Transform[3] = position;
    AIWaypoint waypoint = AIWaypoint.Cast(GetGame().SpawnEntityPrefab(resource, GetGame().GetWorld(), parameters));
    if (!waypoint) { Result(command.id, "failed", "waypoint_spawn_failed"); return; }
    Cancel(managed, "superseded");
    array<AIWaypoint> previous = {};
    managed.entity.GetWaypoints(previous);
    foreach (AIWaypoint previousWaypoint : previous) managed.entity.RemoveWaypoint(previousWaypoint);
    waypoint.SetCompletionRadius(command.radius);
    managed.entity.AddWaypoint(waypoint);
    KeepNativeAIActive(managed);
    managed.waypoint = waypoint;
    managed.state.status = status;
    managed.pendingCommand = command.id;
    managed.pendingKind = command.kind;
    managed.deadline = Now() + 900;
    Result(command.id, "accepted");
  }

  void Objective(StavkaCommand command)
  {
    StavkaObjectiveState objective = objectives.Get(command.objectiveId);
    if (objective && objective.nativeBase) { Result(command.id, "failed", "native_capture_is_engine_owned"); return; }
    if (command.action == "create")
    {
      if (objective || objectives.Count() >= 128) { Result(command.id, "failed", "objective_exists_or_limit"); return; }
      objective = new StavkaObjectiveState();
      objective.id = command.objectiveId;
      objective.name = command.objectiveId;
    }
    if (!objective) { Result(command.id, "failed", "unknown_objective"); return; }
    if (command.action == "remove") { objectives.Remove(command.objectiveId); Result(command.id, "completed"); return; }
    if (command.action == "assign")
    {
      StavkaManagedGroup managed = groups.Get(command.assignee);
      if (!managed || !SafeGroup(managed.entity)) { Result(command.id, "failed", "group_not_controllable"); return; }
      command.position = objective.position;
      command.kind = "move_group";
      Assign(managed, command);
      return;
    }
    vector position;
    if (command.hasPosition)
    {
      if (!GroundPosition(command.position, position)) { Result(command.id, "failed", "invalid_position"); return; }
      objective.position = position;
    }
    if (!command.status.IsEmpty()) objective.status = command.status;
    objectives.Set(objective.id, objective);
    Result(command.id, "completed");
  }

  void DeleteGroup(StavkaManagedGroup managed)
  {
    if (!SafeGroup(managed.entity)) return;
    ClearWaypoint(managed);
    array<AIAgent> agents = {};
    managed.entity.GetAgents(agents);
    foreach (AIAgent agent : agents)
    {
      if (agent && agent.GetControlledEntity()) SCR_EntityHelper.DeleteEntityAndChildren(agent.GetControlledEntity());
    }
    SCR_EntityHelper.DeleteEntityAndChildren(managed.entity);
  }

  void Refresh()
  {
    RefreshBases();
    float now = Now();
    array<string> removed = {};
    foreach (string id, StavkaManagedGroup managed : groups)
    {
      if (!SafeGroup(managed.entity))
      {
        Cancel(managed, "control_lost");
        ReleaseNativeAI(managed);
        removed.Insert(id);
        Event("group_control_lost", id, managed.state.position);
        continue;
      }
      int count = managed.entity.GetAgentsCount();
      KeepNativeAIActive(managed);
      if (managed.entity.IsDormant()) count = Math.Max(count, managed.entity.GetDormantAliveCount());
      if (count != managed.previousStrength)
      {
        managed.previousStrength = count;
        managed.strengthChangedAt = now;
      }
      AIAgent leader = managed.entity.GetLeaderAgent();
      if (leader && leader.GetControlledEntity()) managed.state.position = leader.GetControlledEntity().GetOrigin();
      if (count < managed.state.current) Event("casualty", id, managed.state.position, "urgent");
      managed.state.current = count;
      managed.state.maximum = Math.Max(count, managed.state.maximum);
      if (managed.pendingKind == "spawn_group" && !managed.pendingCommand.IsEmpty())
      {
        // In 1.8 IsInitializing is a compatibility stub. Wait for stable native
        // membership as prefab units are spawned over multiple frames.
        if (count > 0 && managed.entity.IsExpandComplete() && now - managed.strengthChangedAt >= 3)
        {
          string spawnCommandId = managed.pendingCommand;
          managed.pendingCommand = "";
          managed.state.status = "idle";
          if (managed.initialBehavior == "defend" || !managed.spawnObjective.IsEmpty())
          {
            StavkaCommand initialOrder = new StavkaCommand();
            initialOrder.id = spawnCommandId;
            initialOrder.kind = "defend_group";
            initialOrder.position = managed.state.position;
            StavkaObjectiveState targetObjective = objectives.Get(managed.spawnObjective);
            if (targetObjective) { initialOrder.kind = "move_group"; initialOrder.position = targetObjective.position; }
            Assign(managed, initialOrder);
            // Completion acknowledges the spawn and initial assignment, not arrival.
            if (receipts.Get(spawnCommandId).status == "failed") continue;
            managed.pendingCommand = "";
          }
          Result(spawnCommandId, "completed", id);
          Event("group_spawned", id, managed.state.position);
        }
        else if (now > managed.deadline)
        {
          Cancel(managed, "spawn_timeout");
          DeleteGroup(managed);
          removed.Insert(id);
        }
      }
      else if (count == 0)
      {
        Cancel(managed, "group_destroyed");
        if (managed.spawnedByStavka) DeleteGroup(managed);
        removed.Insert(id);
        Event("group_destroyed", id, managed.state.position, "urgent");
      }
      else if (!managed.pendingCommand.IsEmpty())
      {
        array<AIWaypoint> active = {};
        managed.entity.GetWaypoints(active);
        if (!managed.waypoint || active.Find(managed.waypoint) < 0)
        {
          Result(managed.pendingCommand, "completed");
          managed.pendingCommand = "";
          ClearWaypoint(managed);
          managed.state.status = "idle";
        }
        else if (now > managed.deadline && managed.pendingKind != "defend_group" && managed.pendingKind != "patrol_group")
        {
          Cancel(managed, "order_timeout");
          managed.state.status = "idle";
        }
      }
      Observe(managed, now);
    }
    foreach (string removedId : removed) groups.Remove(removedId);
    array<string> expired = {};
    foreach (string contactId, StavkaKnownEnemy contact : contacts)
    {
      if (now - contact.observedAt > config.contactExpiry) expired.Insert(contactId);
    }
    foreach (string expiredId : expired) contacts.Remove(expiredId);
  }

  void RefreshBases()
  {
    SCR_GameModeCampaign campaign = SCR_GameModeCampaign.Cast(GetGame().GetGameMode());
    if (!campaign || !campaign.GetBaseManager()) return;
    array<SCR_CampaignMilitaryBaseComponent> bases = {};
    campaign.GetBaseManager().GetBases(bases);
    array<string> live = {};
    foreach (SCR_CampaignMilitaryBaseComponent base : bases)
    {
      if (!base || !base.GetOwner()) continue;
      string id = "base-" + base.GetOwner().GetID().ToString();
      live.Insert(id);
      StavkaObjectiveState objective = objectives.Get(id);
      if (!objective)
      {
        objective = new StavkaObjectiveState();
        objective.id = id;
        objective.nativeBase = true;
      }
      objective.name = base.GetCallsignDisplayName();
      if (objective.name.IsEmpty()) objective.name = id;
      objective.position = base.GetOwner().GetOrigin();
      objective.status = "neutral";
      objective.progress = 0;
      Faction faction = base.GetFaction();
      if (faction)
      {
        if (faction.GetFactionKey() == config.engineFaction) { objective.status = "friendly"; objective.progress = 1; }
        else objective.status = "enemy";
      }
      if (base.AreEnemiesPresent()) objective.status = "contested";
      objectives.Set(id, objective);
    }
    array<string> removed = {};
    foreach (string objectiveId, StavkaObjectiveState existing : objectives)
    {
      if (existing.nativeBase && live.Find(objectiveId) < 0) removed.Insert(objectiveId);
    }
    foreach (string removedId : removed) objectives.Remove(removedId);
  }

  void Observe(StavkaManagedGroup managed, float now)
  {
    if (!managed.entity) return;
    array<AIAgent> agents = {};
    managed.entity.GetAgents(agents);
    foreach (AIAgent agent : agents)
    {
      if (!agent) continue;
      PerceptionComponent perception = PerceptionComponent.Cast(agent.FindComponent(PerceptionComponent));
      SCR_AIInfoComponent info = SCR_AIInfoComponent.Cast(agent.FindComponent(SCR_AIInfoComponent));
      if (info && info.m_Perception) perception = info.m_Perception;
      if (!perception) continue;
      array<BaseTarget> targets = {};
      perception.GetTargetsList(targets, ETargetCategory.ENEMY);
      foreach (BaseTarget target : targets)
      {
        if (!target || !target.GetTargetEntity()) continue;
        float age = target.GetTimeSinceSeen();
        if (age < 0 || age > config.contactExpiry) continue;
        vector observed = target.GetLastSeenPosition();
        if (vector.Distance(managed.state.position, observed) > config.detectionRange) continue;
        string id = "contact-" + target.GetTargetEntity().GetID().ToString();
        StavkaKnownEnemy contact = contacts.Get(id);
        if (!contact)
        {
          if (contacts.Count() >= 256) continue;
          contact = new StavkaKnownEnemy();
          contact.id = id;
          Event("enemy_detected", managed.state.id, observed, "urgent");
        }
        if (contact.observedAt > now - age) continue;
        contact.reporter = managed.state.id;
        contact.position = observed;
        contact.observedAt = now - age;
        contacts.Set(id, contact);
      }
    }
  }
}
