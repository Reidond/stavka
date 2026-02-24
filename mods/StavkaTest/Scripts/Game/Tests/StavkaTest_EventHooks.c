class StavkaTest_EventHooks : StavkaTestBase {
  protected SCR_AIGroup m_Group1;
  protected SCR_AIGroup m_Group2;
  protected bool m_bDone;

  override string GetName() {
    return "events";
  }

  override bool NeedsUpdate() {
    return !m_bDone;
  }

  override void Run() {
    m_Group1 = null;
    m_Group2 = null;
    m_bDone = false;

    Print("========================================", LogLevel.NORMAL);
    Print("  EVENT HOOKS TEST", LogLevel.NORMAL);
    Print("========================================", LogLevel.NORMAL);

    vector pos1 = SPAWN_POS;
    pos1[1] = GetGame().GetWorld().GetSurfaceY(pos1[0], pos1[2]) + 1;

    vector pos2 = Vector(SPAWN_POS[0], 0, SPAWN_POS[2] + 150);
    pos2[1] = GetGame().GetWorld().GetSurfaceY(pos2[0], pos2[2]) + 1;

    // Spawn two groups
    m_Group1 = SpawnGroup("{E552DABF3636C2AD}Prefabs/Groups/OPFOR/Group_USSR_RifleSquad.et", pos1, "Group1");
    m_Group2 = SpawnGroup("{84E5BBAB25EA23E5}Prefabs/Groups/BLUFOR/Group_US_FireTeam.et", pos2, "Group2");

    // 2s: Hook into events
    GetGame().GetCallqueue().CallLater(AttachHooks, 2000, false);

    // 6s: Kill one agent from Group1
    GetGame().GetCallqueue().CallLater(KillOneAgent, 6000, false);

    // 10s: Kill all of Group2
    GetGame().GetCallqueue().CallLater(KillAllGroup2, 10000, false);

    // 16s: Final report
    GetGame().GetCallqueue().CallLater(FinalReport, 16000, false);
  }

  override void Update(float timeSlice) {
    // No per-frame work; all logic is CallLater-driven
  }

  protected SCR_AIGroup SpawnGroup(string prefab, vector pos, string label) {
    EntitySpawnParams params = new EntitySpawnParams();
    params.TransformMode = ETransformMode.WORLD;
    params.Transform[3] = pos;
    Resource res = Resource.Load(prefab);
    IEntity ent = GetGame().SpawnEntityPrefab(res, GetGame().GetWorld(), params);
    SCR_AIGroup group = SCR_AIGroup.Cast(ent);
    if (group)
      Print(string.Format("[Spawn] %1 at %2 (%3 agents)", label, pos, group.GetAgentsCount()), LogLevel.NORMAL);
    else
      Print(string.Format("[Spawn] %1 FAILED at %2", label, pos), LogLevel.ERROR);
    return group;
  }

  protected void AttachHooks() {
    Print("========================================", LogLevel.NORMAL);
    Print("  [2s] ATTACHING EVENT HOOKS", LogLevel.NORMAL);
    Print("========================================", LogLevel.NORMAL);

    // --- SCR_AIGroup event hooks ---
    if (m_Group1) {
      Print(string.Format("[Hook] Group1 agents: %1", m_Group1.GetAgentsCount()), LogLevel.NORMAL);

      m_Group1.GetOnAgentRemoved().Insert(OnAgentRemovedGroup1);
      Print("[Hook] Group1.GetOnAgentRemoved() hooked", LogLevel.NORMAL);

      m_Group1.GetOnAgentAdded().Insert(OnAgentAddedGroup1);
      Print("[Hook] Group1.GetOnAgentAdded() hooked", LogLevel.NORMAL);
    }

    if (m_Group2) {
      Print(string.Format("[Hook] Group2 agents: %1", m_Group2.GetAgentsCount()), LogLevel.NORMAL);

      m_Group2.GetOnAgentRemoved().Insert(OnAgentRemovedGroup2);
      Print("[Hook] Group2.GetOnAgentRemoved() hooked", LogLevel.NORMAL);
    }

    // --- Per-agent damage hooks ---
    if (m_Group1) {
      array<AIAgent> agents = {};
      m_Group1.GetAgents(agents);
      foreach (AIAgent agent : agents) {
        IEntity ent = agent.GetControlledEntity();
        if (!ent)
          continue;

        SCR_CharacterDamageManagerComponent charDmg = SCR_CharacterDamageManagerComponent.Cast(ent.FindComponent(SCR_CharacterDamageManagerComponent));
        if (charDmg) {
          charDmg.GetOnDamage().Insert(OnAgentDamaged);
          Print(string.Format("[Hook] %1: OnDamage hooked", ent.GetPrefabData().GetPrefabName()), LogLevel.NORMAL);
        }

        EventHandlerManagerComponent evtMgr = EventHandlerManagerComponent.Cast(ent.FindComponent(EventHandlerManagerComponent));
        if (evtMgr)
          Print(string.Format("[Hook] %1: Has EventHandlerManagerComponent", ent.GetPrefabData().GetPrefabName()), LogLevel.NORMAL);
        else
          Print(string.Format("[Hook] %1: No EventHandlerManagerComponent", ent.GetPrefabData().GetPrefabName()), LogLevel.NORMAL);
      }
    }

    Print("[Hook] SCR_BaseGameMode.OnControllableDestroyed available (override)", LogLevel.NORMAL);

    Print("========================================", LogLevel.NORMAL);
    Print("  HOOKS ATTACHED, WAITING FOR EVENTS", LogLevel.NORMAL);
    Print("========================================", LogLevel.NORMAL);
  }

  // --- Event callbacks ---
  protected void OnAgentRemovedGroup1(AIGroup group, AIAgent agent) {
    string info = "unknown";
    if (agent) {
      IEntity ent = agent.GetControlledEntity();
      if (ent)
        info = ent.GetPrefabData().GetPrefabName();
    }
    int remaining = 0;
    if (group)
      remaining = group.GetAgentsCount();
    Print(string.Format("[EVENT] Group1 AGENT REMOVED: %1 (remaining: %2)", info, remaining), LogLevel.NORMAL);
  }

  protected void OnAgentAddedGroup1(AIGroup group, AIAgent agent) {
    string info = "unknown";
    if (agent) {
      IEntity ent = agent.GetControlledEntity();
      if (ent)
        info = ent.GetPrefabData().GetPrefabName();
    }
    Print(string.Format("[EVENT] Group1 AGENT ADDED: %1", info), LogLevel.NORMAL);
  }

  protected void OnAgentRemovedGroup2(AIGroup group, AIAgent agent) {
    string info = "unknown";
    if (agent) {
      IEntity ent = agent.GetControlledEntity();
      if (ent)
        info = ent.GetPrefabData().GetPrefabName();
    }
    int remaining = 0;
    if (group)
      remaining = group.GetAgentsCount();
    Print(string.Format("[EVENT] Group2 AGENT REMOVED: %1 (remaining: %2)", info, remaining), LogLevel.NORMAL);
  }

  protected void OnAgentDamaged(EDamageType type, float damage, HitZone hz, IEntity instigator, inout vector hitTransform[3], float speed, int colliderID, int nodeID) {
    string hzName = "?";
    if (hz)
      hzName = hz.GetName();
    string instigatorType = "null";
    if (instigator)
      instigatorType = instigator.Type().ToString();
    Print(string.Format("[EVENT] DAMAGE: type=%1 dmg=%2 hitzone=%3 instigator=%4",
      type, damage, hzName, instigatorType), LogLevel.NORMAL);
  }

  // --- Test actions ---
  protected void KillOneAgent() {
    Print("========================================", LogLevel.NORMAL);
    Print("  [6s] KILLING ONE AGENT (Group1)", LogLevel.NORMAL);
    Print("========================================", LogLevel.NORMAL);

    if (!m_Group1)
      return;

    array<AIAgent> agents = {};
    m_Group1.GetAgents(agents);
    if (agents.IsEmpty())
      return;

    AIAgent victim = agents[agents.Count() - 1];
    IEntity ent = victim.GetControlledEntity();
    if (!ent)
      return;

    Print(string.Format("[Kill] Target: %1", ent.GetPrefabData().GetPrefabName()), LogLevel.NORMAL);

    SCR_DamageManagerComponent dmg = SCR_DamageManagerComponent.Cast(ent.FindComponent(SCR_DamageManagerComponent));
    if (dmg)
      dmg.Kill(Instigator.CreateInstigator(null));
  }

  protected void KillAllGroup2() {
    Print("========================================", LogLevel.NORMAL);
    Print("  [10s] KILLING ALL GROUP2", LogLevel.NORMAL);
    Print("========================================", LogLevel.NORMAL);

    if (!m_Group2) {
      Print("[Kill] Group2 already null!", LogLevel.WARNING);
      return;
    }

    array<AIAgent> agents = {};
    m_Group2.GetAgents(agents);
    Print(string.Format("[Kill] Group2 agents: %1", agents.Count()), LogLevel.NORMAL);

    foreach (AIAgent agent : agents) {
      IEntity ent = agent.GetControlledEntity();
      if (!ent)
        continue;
      SCR_DamageManagerComponent dmg = SCR_DamageManagerComponent.Cast(ent.FindComponent(SCR_DamageManagerComponent));
      if (dmg && !dmg.IsDestroyed())
        dmg.Kill(Instigator.CreateInstigator(null));
    }

    // Check 2s later if group auto-deleted
    GetGame().GetCallqueue().CallLater(CheckGroup2Deleted, 2000, false);
  }

  protected void CheckGroup2Deleted() {
    Print("========================================", LogLevel.NORMAL);
    Print("  [12s] GROUP2 POST-WIPE CHECK", LogLevel.NORMAL);
    Print("========================================", LogLevel.NORMAL);

    if (!m_Group2)
      Print("[Check] Group2 is NULL (auto-deleted)", LogLevel.NORMAL);
    else
      Print(string.Format("[Check] Group2 still exists, agents: %1", m_Group2.GetAgentsCount()), LogLevel.NORMAL);
  }

  protected void FinalReport() {
    Print("========================================", LogLevel.NORMAL);
    Print("  FINAL REPORT", LogLevel.NORMAL);
    Print("========================================", LogLevel.NORMAL);

    if (m_Group1)
      Print(string.Format("[Final] Group1: agents=%1", m_Group1.GetAgentsCount()), LogLevel.NORMAL);
    else
      Print("[Final] Group1: NULL", LogLevel.NORMAL);

    if (m_Group2)
      Print(string.Format("[Final] Group2: agents=%1", m_Group2.GetAgentsCount()), LogLevel.NORMAL);
    else
      Print("[Final] Group2: NULL", LogLevel.NORMAL);

    Print("========================================", LogLevel.NORMAL);
    Print("  EVENT HOOKS TEST COMPLETE", LogLevel.NORMAL);
    Print("========================================", LogLevel.NORMAL);
    m_bDone = true;
  }
}
