class StavkaTest_Combat : StavkaTestBase {
  protected SCR_AIGroup m_OPFOR;
  protected SCR_AIGroup m_BLUFOR;
  protected int m_iOPFORKills;
  protected int m_iBLUFORKills;
  protected int m_iTrackFrames;
  protected bool m_bTracking;
  protected bool m_bDone;

  override string GetName() {
    return "combat";
  }

  override bool NeedsUpdate() {
    return !m_bDone;
  }

  override void Run() {
    m_OPFOR = null;
    m_BLUFOR = null;
    m_iOPFORKills = 0;
    m_iBLUFORKills = 0;
    m_iTrackFrames = 0;
    m_bTracking = false;
    m_bDone = false;

    Print("========================================", LogLevel.NORMAL);
    Print("  COMBAT TEST: OPFOR vs BLUFOR", LogLevel.NORMAL);
    Print("========================================", LogLevel.NORMAL);

    // Spawn OPFOR (USSR) at SPAWN_POS
    vector posOPFOR = SPAWN_POS;
    posOPFOR[1] = GetGame().GetWorld().GetSurfaceY(posOPFOR[0], posOPFOR[2]) + 1;

    // Spawn BLUFOR (US) 150m east
    vector posBLUFOR = Vector(SPAWN_POS[0] + 150, 0, SPAWN_POS[2]);
    posBLUFOR[1] = GetGame().GetWorld().GetSurfaceY(posBLUFOR[0], posBLUFOR[2]) + 1;

    m_OPFOR = SpawnGroup("{E552DABF3636C2AD}Prefabs/Groups/OPFOR/Group_USSR_RifleSquad.et",
      posOPFOR, "OPFOR");
    m_BLUFOR = SpawnGroup("{84E5BBAB25EA23E5}Prefabs/Groups/BLUFOR/Group_US_FireTeam.et",
      posBLUFOR, "BLUFOR");

    // 2s: attach death hooks + report initial state
    GetGame().GetCallqueue().CallLater(AttachAndReport, 2000, false);

    // 10s: check if they auto-engage
    GetGame().GetCallqueue().CallLater(CheckAutoEngage, 10000, false);

    // 15s: if no engagement, give Attack waypoints
    GetGame().GetCallqueue().CallLater(ForceEngage, 15000, false);
  }

  override void Update(float timeSlice) {
    if (!m_bTracking)
      return;

    m_iTrackFrames++;
    if (m_iTrackFrames % 300 == 0)
      TrackState();
    if (m_iTrackFrames > 7200) {
      Print("[Combat] Timeout reached (2 min)", LogLevel.NORMAL);
      FinalReport();
    }
  }

  protected SCR_AIGroup SpawnGroup(string prefab, vector pos, string label) {
    EntitySpawnParams params = new EntitySpawnParams();
    params.TransformMode = ETransformMode.WORLD;
    params.Transform[3] = pos;
    Resource res = Resource.Load(prefab);
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

  protected void AttachAndReport() {
    Print("========================================", LogLevel.NORMAL);
    Print("  [2s] INITIAL STATE + HOOKS", LogLevel.NORMAL);
    Print("========================================", LogLevel.NORMAL);

    if (m_OPFOR) {
      Print(string.Format("[Init] OPFOR: %1 agents", m_OPFOR.GetAgentsCount()), LogLevel.NORMAL);
      m_OPFOR.GetOnAgentRemoved().Insert(OnOPFORRemoved);
    }
    if (m_BLUFOR) {
      Print(string.Format("[Init] BLUFOR: %1 agents", m_BLUFOR.GetAgentsCount()), LogLevel.NORMAL);
      m_BLUFOR.GetOnAgentRemoved().Insert(OnBLUFORRemoved);
    }

    PrintGroupDetail("OPFOR", m_OPFOR);
    PrintGroupDetail("BLUFOR", m_BLUFOR);

    m_bTracking = true;
    m_iTrackFrames = 0;
  }

  protected void OnOPFORRemoved(AIGroup group, AIAgent agent) {
    m_iOPFORKills++;
    string info = "unknown";
    if (agent) {
      IEntity ent = agent.GetControlledEntity();
      if (ent)
        info = ent.GetPrefabData().GetPrefabName();
    }
    int remaining = 0;
    if (group)
      remaining = group.GetAgentsCount();
    Print(string.Format("[CASUALTY] OPFOR down: %1 (remaining: %2, lost: %3)",
      info, remaining, m_iOPFORKills), LogLevel.NORMAL);

    if (remaining == 0) {
      Print("[RESULT] OPFOR WIPED - BLUFOR WINS!", LogLevel.NORMAL);
      GetGame().GetCallqueue().CallLater(FinalReport, 1000, false);
    }
  }

  protected void OnBLUFORRemoved(AIGroup group, AIAgent agent) {
    m_iBLUFORKills++;
    string info = "unknown";
    if (agent) {
      IEntity ent = agent.GetControlledEntity();
      if (ent)
        info = ent.GetPrefabData().GetPrefabName();
    }
    int remaining = 0;
    if (group)
      remaining = group.GetAgentsCount();
    Print(string.Format("[CASUALTY] BLUFOR down: %1 (remaining: %2, lost: %3)",
      info, remaining, m_iBLUFORKills), LogLevel.NORMAL);

    if (remaining == 0) {
      Print("[RESULT] BLUFOR WIPED - OPFOR WINS!", LogLevel.NORMAL);
      GetGame().GetCallqueue().CallLater(FinalReport, 1000, false);
    }
  }

  protected void CheckAutoEngage() {
    Print("========================================", LogLevel.NORMAL);
    Print("  [10s] AUTO-ENGAGE CHECK", LogLevel.NORMAL);
    Print("========================================", LogLevel.NORMAL);

    if (m_iOPFORKills > 0 || m_iBLUFORKills > 0)
      Print("[Auto] Casualties detected - AI IS engaging without waypoints!", LogLevel.NORMAL);
    else
      Print("[Auto] No casualties yet - AI may need Attack waypoints", LogLevel.NORMAL);
  }

  protected void ForceEngage() {
    if (m_iOPFORKills > 0 || m_iBLUFORKills > 0) {
      Print("[Force] Already fighting, skipping forced engagement", LogLevel.NORMAL);
      return;
    }

    Print("========================================", LogLevel.NORMAL);
    Print("  [15s] FORCING ENGAGEMENT", LogLevel.NORMAL);
    Print("========================================", LogLevel.NORMAL);

    // OPFOR attacks toward BLUFOR
    if (m_OPFOR && m_BLUFOR) {
      vector bluPos = vector.Zero;
      AIAgent bluLeader = m_BLUFOR.GetLeaderAgent();
      if (bluLeader && bluLeader.GetControlledEntity())
        bluPos = bluLeader.GetControlledEntity().GetOrigin();

      AIWaypoint wp1 = SpawnWaypoint(
        "{1B0E3436C30FA211}Prefabs/AI/Waypoints/AIWaypoint_Attack.et",
        bluPos, 30);
      if (wp1) {
        m_OPFOR.AddWaypoint(wp1);
        Print(string.Format("[Attack] OPFOR toward BLUFOR at %1", bluPos), LogLevel.NORMAL);
      }
    }

    // BLUFOR attacks toward OPFOR
    if (m_BLUFOR && m_OPFOR) {
      vector opPos = vector.Zero;
      AIAgent opLeader = m_OPFOR.GetLeaderAgent();
      if (opLeader && opLeader.GetControlledEntity())
        opPos = opLeader.GetControlledEntity().GetOrigin();

      AIWaypoint wp2 = SpawnWaypoint(
        "{1B0E3436C30FA211}Prefabs/AI/Waypoints/AIWaypoint_Attack.et",
        opPos, 30);
      if (wp2) {
        m_BLUFOR.AddWaypoint(wp2);
        Print(string.Format("[Attack] BLUFOR toward OPFOR at %1", opPos), LogLevel.NORMAL);
      }
    }
  }

  protected void TrackState() {
    int opCount = 0;
    int bluCount = 0;
    vector opPos = vector.Zero;
    vector bluPos = vector.Zero;

    if (m_OPFOR) {
      opCount = m_OPFOR.GetAgentsCount();
      AIAgent leader = m_OPFOR.GetLeaderAgent();
      if (leader && leader.GetControlledEntity())
        opPos = leader.GetControlledEntity().GetOrigin();
    }

    if (m_BLUFOR) {
      bluCount = m_BLUFOR.GetAgentsCount();
      AIAgent leader = m_BLUFOR.GetLeaderAgent();
      if (leader && leader.GetControlledEntity())
        bluPos = leader.GetControlledEntity().GetOrigin();
    }

    float dist = 0;
    if (opPos != vector.Zero && bluPos != vector.Zero)
      dist = vector.Distance(opPos, bluPos);

    Print(string.Format("[Track] OPFOR=%1 at %2 | BLUFOR=%3 at %4 | dist=%5m",
      opCount, opPos, bluCount, bluPos, dist), LogLevel.NORMAL);
  }

  protected void PrintGroupDetail(string label, SCR_AIGroup group) {
    if (!group)
      return;
    array<AIAgent> agents = {};
    group.GetAgents(agents);
    foreach (AIAgent agent : agents) {
      IEntity ent = agent.GetControlledEntity();
      if (!ent)
        continue;
      Print(string.Format("[%1] %2 at %3", label, ent.GetPrefabData().GetPrefabName(), ent.GetOrigin()), LogLevel.NORMAL);
    }
  }

  protected void FinalReport() {
    m_bTracking = false;
    m_bDone = true;

    Print("========================================", LogLevel.NORMAL);
    Print("  COMBAT RESULTS", LogLevel.NORMAL);
    Print("========================================", LogLevel.NORMAL);

    Print(string.Format("[Result] OPFOR casualties: %1", m_iOPFORKills), LogLevel.NORMAL);
    Print(string.Format("[Result] BLUFOR casualties: %1", m_iBLUFORKills), LogLevel.NORMAL);

    if (m_OPFOR) {
      Print(string.Format("[Result] OPFOR survivors: %1", m_OPFOR.GetAgentsCount()), LogLevel.NORMAL);
      PrintGroupDetail("OPFOR-survivor", m_OPFOR);
    } else {
      Print("[Result] OPFOR: ELIMINATED", LogLevel.NORMAL);
    }

    if (m_BLUFOR) {
      Print(string.Format("[Result] BLUFOR survivors: %1", m_BLUFOR.GetAgentsCount()), LogLevel.NORMAL);
      PrintGroupDetail("BLUFOR-survivor", m_BLUFOR);
    } else {
      Print("[Result] BLUFOR: ELIMINATED", LogLevel.NORMAL);
    }

    Print("========================================", LogLevel.NORMAL);
    Print("  COMBAT TEST COMPLETE", LogLevel.NORMAL);
    Print("========================================", LogLevel.NORMAL);
  }
}
