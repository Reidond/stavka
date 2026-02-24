class StavkaTest_AttackDefend : StavkaTestBase {
  protected SCR_AIGroup m_GroupA;
  protected SCR_AIGroup m_GroupD;
  protected SCR_AIGroup m_GroupS;
  protected SCR_AIGroup m_GroupP;
  protected int m_iTrackFrames = 0;
  protected bool m_bTracking = false;
  protected bool m_bDone = false;

  override string GetName() {
    return "attack";
  }

  override bool NeedsUpdate() {
    return !m_bDone;
  }

  override void Run() {
    m_bDone = false;
    m_bTracking = false;
    m_iTrackFrames = 0;

    Print("========================================", LogLevel.NORMAL);
    Print("  WAYPOINT TYPE TEST", LogLevel.NORMAL);
    Print("========================================", LogLevel.NORMAL);

    vector basePos = SPAWN_POS;
    basePos[1] = GetGame().GetWorld().GetSurfaceY(basePos[0], basePos[2]) + 1;

    vector posA = basePos;
    vector posD = basePos;
    posD[2] = posD[2] + 100;
    vector posS = basePos;
    posS[2] = posS[2] + 200;
    vector posP = basePos;
    posP[2] = posP[2] + 300;

    posA[1] = GetGame().GetWorld().GetSurfaceY(posA[0], posA[2]) + 1;
    posD[1] = GetGame().GetWorld().GetSurfaceY(posD[0], posD[2]) + 1;
    posS[1] = GetGame().GetWorld().GetSurfaceY(posS[0], posS[2]) + 1;
    posP[1] = GetGame().GetWorld().GetSurfaceY(posP[0], posP[2]) + 1;

    m_GroupA = SpawnGroup(posA, "Attack");
    m_GroupD = SpawnGroup(posD, "Defend");
    m_GroupS = SpawnGroup(posS, "S&D");
    m_GroupP = SpawnGroup(posP, "Patrol");

    GetGame().GetCallqueue().CallLater(AssignAllWaypoints, 2000, false);
  }

  override void Update(float timeSlice) {
    if (!m_bTracking)
      return;

    m_iTrackFrames++;
    if (m_iTrackFrames % 180 == 0) {
      PrintGroupPos("Attack", m_GroupA);
      PrintGroupPos("Defend", m_GroupD);
      PrintGroupPos("S&D", m_GroupS);
      PrintGroupPos("Patrol", m_GroupP);
      Print("----------------------------------------", LogLevel.NORMAL);

      if (m_iTrackFrames > 1200) {
        m_bTracking = false;
        m_bDone = true;
        Print("[Attack] Test complete.", LogLevel.NORMAL);
      }
    }
  }

  protected void PrintGroupPos(string label, SCR_AIGroup group) {
    if (!group)
      return;
    AIAgent leader = group.GetLeaderAgent();
    if (!leader || !leader.GetControlledEntity())
      return;

    vector pos = leader.GetControlledEntity().GetOrigin();
    AIWaypoint wp = group.GetCurrentWaypoint();
    string wpType = "none";
    if (wp)
      wpType = wp.Type().ToString();

    Print(string.Format("[%1] pos=%2 wp=%3 agents=%4", label, pos, wpType,
                        group.GetAgentsCount()),
          LogLevel.NORMAL);
  }

  protected SCR_AIGroup SpawnGroup(vector pos, string label) {
    EntitySpawnParams params = new EntitySpawnParams();
    params.TransformMode = ETransformMode.WORLD;
    params.Transform[3] = pos;

    Resource res = Resource.Load(
        "{E552DABF3636C2AD}Prefabs/Groups/OPFOR/Group_USSR_RifleSquad.et");
    IEntity ent =
        GetGame().SpawnEntityPrefab(res, GetGame().GetWorld(), params);
    SCR_AIGroup group = SCR_AIGroup.Cast(ent);
    Print(string.Format("[Spawn] %1 at %2", label, pos), LogLevel.NORMAL);
    return group;
  }

  protected void AssignAllWaypoints() {
    Print("========================================", LogLevel.NORMAL);
    Print("  ASSIGNING WAYPOINTS", LogLevel.NORMAL);
    Print("========================================", LogLevel.NORMAL);

    if (m_GroupA) {
      vector posA = m_GroupA.GetOrigin();
      AssignWaypoint(
          m_GroupA, "Attack",
          "{1B0E3436C30FA211}Prefabs/AI/Waypoints/AIWaypoint_Attack.et",
          Vector(posA[0] + 300, 0, posA[2]));
    }

    if (m_GroupD) {
      vector posD = m_GroupD.GetOrigin();
      AssignWaypoint(
          m_GroupD, "Defend",
          "{93291E72AC23930F}Prefabs/AI/Waypoints/AIWaypoint_Defend.et", posD);
    }

    if (m_GroupS) {
      vector posS = m_GroupS.GetOrigin();
      AssignWaypoint(m_GroupS, "S&D",
                     "{B3E7B8DC2BAB8ACC}Prefabs/AI/Waypoints/AIWaypoint_SearchAndDestroy.et",
                     Vector(posS[0] + 300, 0, posS[2]));
    }

    if (m_GroupP) {
      vector posP = m_GroupP.GetOrigin();
      AssignWaypoint(
          m_GroupP, "Patrol",
          "{22A875E30470BD4F}Prefabs/AI/Waypoints/AIWaypoint_Patrol.et",
          Vector(posP[0] + 300, 0, posP[2]));
    }

    Print("========================================", LogLevel.NORMAL);
    Print("  TRACKING FOR 20 SECONDS", LogLevel.NORMAL);
    Print("========================================", LogLevel.NORMAL);

    m_bTracking = true;
    m_iTrackFrames = 0;
  }

  protected void AssignWaypoint(SCR_AIGroup group, string label, string prefab,
                                vector pos) {
    pos[1] = GetGame().GetWorld().GetSurfaceY(pos[0], pos[2]);

    EntitySpawnParams wpParams = new EntitySpawnParams();
    wpParams.TransformMode = ETransformMode.WORLD;
    wpParams.Transform[3] = pos;

    Resource wpRes = Resource.Load(prefab);
    if (!wpRes || !wpRes.IsValid()) {
      Print(string.Format("[WP] %1 FAILED: prefab not found", label),
            LogLevel.ERROR);
      return;
    }

    IEntity wpEnt =
        GetGame().SpawnEntityPrefab(wpRes, GetGame().GetWorld(), wpParams);
    AIWaypoint wp = AIWaypoint.Cast(wpEnt);
    if (!wp) {
      Print(string.Format("[WP] %1 FAILED: not AIWaypoint", label),
            LogLevel.ERROR);
      return;
    }

    wp.SetCompletionRadius(30);
    group.AddWaypoint(wp);

    Print(string.Format("[WP] %1 assigned: %2 at %3", label, wp.Type(), pos),
          LogLevel.NORMAL);
  }
}
