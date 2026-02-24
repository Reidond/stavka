class StavkaTest_MultiDespawn : StavkaTestBase {
  protected SCR_AIGroup m_Group1;
  protected SCR_AIGroup m_Group2;
  protected SCR_AIGroup m_Group3;
  protected int m_iTrackFrames = 0;
  protected bool m_bTracking = false;
  protected bool m_bDone = false;

  override string GetName() {
    return "multidespawn";
  }

  override bool NeedsUpdate() {
    return !m_bDone;
  }

  override void Run() {
    m_bDone = false;
    m_bTracking = false;
    m_iTrackFrames = 0;
    m_Group1 = null;
    m_Group2 = null;
    m_Group3 = null;

    Print("========================================", LogLevel.NORMAL);
    Print("  MULTI-GROUP + DESPAWN TEST", LogLevel.NORMAL);
    Print("========================================", LogLevel.NORMAL);

    vector basePos = Vector(2059, 0, 2047);

    vector pos1 = basePos;
    vector pos2 = Vector(basePos[0], 0, basePos[2] + 150);
    vector pos3 = Vector(basePos[0], 0, basePos[2] + 300);

    pos1[1] = GetGame().GetWorld().GetSurfaceY(pos1[0], pos1[2]) + 1;
    pos2[1] = GetGame().GetWorld().GetSurfaceY(pos2[0], pos2[2]) + 1;
    pos3[1] = GetGame().GetWorld().GetSurfaceY(pos3[0], pos3[2]) + 1;

    m_Group1 = SpawnGroup(pos1, "Group1");
    m_Group2 = SpawnGroup(pos2, "Group2");
    m_Group3 = SpawnGroup(pos3, "Group3");

    GetGame().GetCallqueue().CallLater(AssignWaypoints, 2000, false);
    GetGame().GetCallqueue().CallLater(DespawnGroup2, 8000, false);
    GetGame().GetCallqueue().CallLater(ReassignGroup1, 14000, false);
  }

  override void Update(float timeSlice) {
    if (!m_bTracking)
      return;

    m_iTrackFrames++;
    if (m_iTrackFrames % 180 == 0) {
      PrintGroupStatus("Group1", m_Group1);
      PrintGroupStatus("Group2", m_Group2);
      PrintGroupStatus("Group3", m_Group3);
      Print("----------------------------------------", LogLevel.NORMAL);
    }

    if (m_iTrackFrames > 1800) {
      m_bTracking = false;
      m_bDone = true;
      Print("[MultiDespawn] Test complete.", LogLevel.NORMAL);
    }
  }

  protected void PrintGroupStatus(string label, SCR_AIGroup group) {
    if (!group) {
      Print(string.Format("[%1] NULL (deleted)", label), LogLevel.NORMAL);
      return;
    }

    int agents = group.GetAgentsCount();
    if (agents == 0) {
      Print(string.Format("[%1] EMPTY (0 agents)", label), LogLevel.NORMAL);
      return;
    }

    AIAgent leader = group.GetLeaderAgent();
    vector pos = vector.Zero;
    if (leader && leader.GetControlledEntity())
      pos = leader.GetControlledEntity().GetOrigin();

    AIWaypoint wp = group.GetCurrentWaypoint();
    string wpStr = "none";
    if (wp)
      wpStr = wp.Type().ToString();

    Print(string.Format("[%1] agents=%2 pos=%3 wp=%4", label, agents, pos, wpStr), LogLevel.NORMAL);
  }

  protected SCR_AIGroup SpawnGroup(vector pos, string label) {
    EntitySpawnParams params = new EntitySpawnParams();
    params.TransformMode = ETransformMode.WORLD;
    params.Transform[3] = pos;

    Resource res = Resource.Load("{E552DABF3636C2AD}Prefabs/Groups/OPFOR/Group_USSR_RifleSquad.et");
    IEntity ent = GetGame().SpawnEntityPrefab(res, GetGame().GetWorld(), params);
    SCR_AIGroup group = SCR_AIGroup.Cast(ent);
    Print(string.Format("[Spawn] %1 at %2", label, pos), LogLevel.NORMAL);
    return group;
  }

  protected AIWaypoint SpawnWaypoint(string prefab, vector pos, float radius) {
    pos[1] = GetGame().GetWorld().GetSurfaceY(pos[0], pos[2]);

    EntitySpawnParams params = new EntitySpawnParams();
    params.TransformMode = ETransformMode.WORLD;
    params.Transform[3] = pos;

    Resource res = Resource.Load(prefab);
    if (!res || !res.IsValid())
      return null;

    IEntity ent = GetGame().SpawnEntityPrefab(res, GetGame().GetWorld(), params);
    AIWaypoint wp = AIWaypoint.Cast(ent);
    if (wp)
      wp.SetCompletionRadius(radius);

    return wp;
  }

  protected void AssignWaypoints() {
    Print("========================================", LogLevel.NORMAL);
    Print("  [2s] ASSIGNING WAYPOINTS", LogLevel.NORMAL);
    Print("========================================", LogLevel.NORMAL);

    if (m_Group1) {
      vector pos = m_Group1.GetOrigin();
      AIWaypoint wp = SpawnWaypoint("{06E1B6EBD480C6E0}Prefabs/AI/Waypoints/AIWaypoint_ForcedMove.et", Vector(pos[0] + 400, 0, pos[2]), 30);
      if (wp) {
        m_Group1.AddWaypoint(wp);
        Print("[WP] Group1 → ForcedMove east", LogLevel.NORMAL);
      }
    }

    if (m_Group2) {
      vector pos = m_Group2.GetOrigin();
      AIWaypoint wp = SpawnWaypoint("{1B0E3436C30FA211}Prefabs/AI/Waypoints/AIWaypoint_Attack.et", Vector(pos[0] + 400, 0, pos[2]), 30);
      if (wp) {
        m_Group2.AddWaypoint(wp);
        Print("[WP] Group2 → Attack east", LogLevel.NORMAL);
      }
    }

    if (m_Group3) {
      vector pos = m_Group3.GetOrigin();
      AIWaypoint wp = SpawnWaypoint("{93291E72AC23930F}Prefabs/AI/Waypoints/AIWaypoint_Defend.et", pos, 50);
      if (wp) {
        m_Group3.AddWaypoint(wp);
        Print("[WP] Group3 → Defend in place", LogLevel.NORMAL);
      }
    }

    m_bTracking = true;
    m_iTrackFrames = 0;
  }

  protected void DespawnGroup2() {
    Print("========================================", LogLevel.NORMAL);
    Print("  [8s] DESPAWNING GROUP 2", LogLevel.NORMAL);
    Print("========================================", LogLevel.NORMAL);

    if (!m_Group2) {
      Print("[Despawn] Group2 already null!", LogLevel.WARNING);
      return;
    }

    Print(string.Format("[Despawn] Group2 agents before: %1", m_Group2.GetAgentsCount()), LogLevel.NORMAL);

    array<AIAgent> agents = {};
    m_Group2.GetAgents(agents);
    Print(string.Format("[Despawn] Found %1 agents to delete", agents.Count()), LogLevel.NORMAL);

    foreach (AIAgent agent : agents) {
      IEntity ent = agent.GetControlledEntity();
      if (ent) {
        Print(string.Format("[Despawn] Deleting agent entity: %1", ent), LogLevel.NORMAL);
        SCR_EntityHelper.DeleteEntityAndChildren(ent);
      }
    }

    Print("[Despawn] Deleting group entity ...", LogLevel.NORMAL);
    SCR_EntityHelper.DeleteEntityAndChildren(m_Group2);
    m_Group2 = null;

    Print("[Despawn] Group2 deleted. Checking others ...", LogLevel.NORMAL);
    PrintGroupStatus("Group1", m_Group1);
    PrintGroupStatus("Group3", m_Group3);
  }

  protected void ReassignGroup1() {
    Print("========================================", LogLevel.NORMAL);
    Print("  [14s] REASSIGNING GROUP 1", LogLevel.NORMAL);
    Print("========================================", LogLevel.NORMAL);

    if (!m_Group1) {
      Print("[Reassign] Group1 is null!", LogLevel.ERROR);
      return;
    }

    Print(string.Format("[Reassign] Group1 agents: %1", m_Group1.GetAgentsCount()), LogLevel.NORMAL);

    AIWaypoint curWP = m_Group1.GetCurrentWaypoint();
    if (curWP) {
      Print(string.Format("[Reassign] Removing old WP: %1", curWP.Type()), LogLevel.NORMAL);
      m_Group1.RemoveWaypoint(curWP);
      SCR_EntityHelper.DeleteEntityAndChildren(curWP);
    }

    AIAgent leader = m_Group1.GetLeaderAgent();
    if (leader && leader.GetControlledEntity()) {
      vector pos = leader.GetControlledEntity().GetOrigin();
      AIWaypoint newWP = SpawnWaypoint("{93291E72AC23930F}Prefabs/AI/Waypoints/AIWaypoint_Defend.et", pos, 50);
      if (newWP) {
        m_Group1.AddWaypoint(newWP);
        Print(string.Format("[Reassign] Group1 → Defend at %1", pos), LogLevel.NORMAL);
      }
    }
  }
}
