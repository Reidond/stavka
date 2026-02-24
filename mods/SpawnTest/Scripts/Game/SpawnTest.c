modded class SCR_BaseGameMode {
  protected float m_fSpawnTimer = 5.0;
  protected bool m_bSpawnTestRan = false;
  protected SCR_AIGroup m_TestGroup;
  protected int m_iCheckFrames = 0;
  protected bool m_bWaitingForAgents = false;
  protected bool m_bTracking = false;

  override void EOnFrame(IEntity owner, float timeSlice) {
    super.EOnFrame(owner, timeSlice);

    if (m_bTracking && m_TestGroup) {
      m_iCheckFrames++;
      if (m_iCheckFrames % 120 == 0) {
        AIAgent leader = m_TestGroup.GetLeaderAgent();
        if (leader && leader.GetControlledEntity())
          Print(string.Format("[Track] Frame %1: Leader at %2", m_iCheckFrames,
                              leader.GetControlledEntity().GetOrigin()),
                LogLevel.NORMAL);

        if (m_iCheckFrames > 600)
          m_bTracking = false;
      }
      return;
    }

    if (m_bWaitingForAgents && m_TestGroup) {
      m_iCheckFrames++;
      if (m_iCheckFrames % 30 == 0) {
        int agents = m_TestGroup.GetAgentsCount();
        if (agents > 0 && !m_TestGroup.IsInitializing()) {
          m_bWaitingForAgents = false;
          AssignWaypoint();
        } else if (m_iCheckFrames > 300) {
          m_bWaitingForAgents = false;
          Print("[Wait] Gave up", LogLevel.WARNING);
        }
      }
      return;
    }

    if (m_bSpawnTestRan)
      return;

    m_fSpawnTimer -= timeSlice;
    if (m_fSpawnTimer <= 0) {
      m_bSpawnTestRan = true;
      RunSpawnTest();
    }
  }

  protected void RunSpawnTest() {
    Print("========================================", LogLevel.NORMAL);
    Print("  AI SPAWN + WAYPOINT TEST v4", LogLevel.NORMAL);
    Print("========================================", LogLevel.NORMAL);

    vector spawnPos = FindDryPosition();
    Print(string.Format("[Spawn] Position: %1", spawnPos), LogLevel.NORMAL);

    EntitySpawnParams params = new EntitySpawnParams();
    params.TransformMode = ETransformMode.WORLD;
    params.Transform[3] = spawnPos;

    Resource res = Resource.Load(
        "{E552DABF3636C2AD}Prefabs/Groups/OPFOR/Group_USSR_RifleSquad.et");
    IEntity ent =
        GetGame().SpawnEntityPrefab(res, GetGame().GetWorld(), params);
    m_TestGroup = SCR_AIGroup.Cast(ent);

    if (!m_TestGroup) {
      Print("[Spawn] FAILED", LogLevel.ERROR);
      return;
    }

    Print("[Spawn] Group created, waiting for agents ...", LogLevel.NORMAL);
    m_bWaitingForAgents = true;
    m_iCheckFrames = 0;
  }

  protected void AssignWaypoint() {
    Print("========================================", LogLevel.NORMAL);
    Print(string.Format("[Agents] Count: %1", m_TestGroup.GetAgentsCount()),
          LogLevel.NORMAL);

    AIAgent leader = m_TestGroup.GetLeaderAgent();
    vector leaderPos = leader.GetControlledEntity().GetOrigin();
    Print(string.Format("[Agents] Leader at: %1", leaderPos), LogLevel.NORMAL);

    // Waypoint 300m east
    vector wpPos = leaderPos;
    wpPos[0] = wpPos[0] + 300;
    wpPos[1] = GetGame().GetWorld().GetSurfaceY(wpPos[0], wpPos[2]);

    EntitySpawnParams wpParams = new EntitySpawnParams();
    wpParams.TransformMode = ETransformMode.WORLD;
    wpParams.Transform[3] = wpPos;

    Resource wpRes = Resource.Load(
        "{06E1B6EBD480C6E0}Prefabs/AI/Waypoints/AIWaypoint_ForcedMove.et");
    IEntity wpEnt =
        GetGame().SpawnEntityPrefab(wpRes, GetGame().GetWorld(), wpParams);
    AIWaypoint wp = AIWaypoint.Cast(wpEnt);

    if (!wp) {
      Print("[WP] FAILED to spawn", LogLevel.ERROR);
      return;
    }

    // Set completion radius explicitly
    wp.SetCompletionRadius(30);
    Print(string.Format("[WP] Completion radius: %1", wp.GetCompletionRadius()),
          LogLevel.NORMAL);
    Print(string.Format("[WP] Completion type: %1", wp.GetCompletionType()),
          LogLevel.NORMAL);
    Print(string.Format("[WP] Position: %1", wpPos), LogLevel.NORMAL);

    // Add waypoint to group
    m_TestGroup.AddWaypoint(wp);

    AIWaypoint curWP = m_TestGroup.GetCurrentWaypoint();
    Print(string.Format("[WP] Current WP: %1", curWP), LogLevel.NORMAL);

    // Debug checks
    Print(string.Format("[Debug] IsMaster: %1", Replication.IsServer()),
          LogLevel.NORMAL);

    SCR_AIGroupUtilityComponent utilComp =
        m_TestGroup.GetGroupUtilityComponent();
    if (utilComp)
      Print(string.Format("[Debug] UtilComp action: %1",
                          utilComp.GetCurrentAction()),
            LogLevel.NORMAL);
    else
      Print("[Debug] No UtilComp!", LogLevel.WARNING);

    Print("[Track] Monitoring leader position for 10 seconds ...",
          LogLevel.NORMAL);
    Print("========================================", LogLevel.NORMAL);

    m_bTracking = true;
    m_iCheckFrames = 0;
  }

  protected vector FindDryPosition() {
    //        BaseWorld world = GetGame().GetWorld();
    //        for (int radius = 0; radius < 2000; radius += 100)
    //        {
    //            for (int angle = 0; angle < 360; angle += 45)
    //            {
    //                float x = 1900 + radius * Math.Cos(angle * Math.DEG2RAD);
    //                float z = 1800 + radius * Math.Sin(angle * Math.DEG2RAD);
    //                float y = world.GetSurfaceY(x, z);
    //                if (y > 1)
    //                    return Vector(x, y + 1, z);
    //            }
    //        }
    return Vector(2059.38, 44.16, 2046.97);
  }
}
