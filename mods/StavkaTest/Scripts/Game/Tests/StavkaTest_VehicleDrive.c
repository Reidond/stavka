class StavkaTest_VehicleDrive : StavkaTestBase {
  protected SCR_AIGroup m_Group;
  protected IEntity m_Vehicle;
  protected bool m_bDone;
  protected int m_iPhase; // 0=boarding, 1=driving, 2=dismounting
  protected int m_iTrackFrames;

  override string GetName() { return "drive"; }

  override bool NeedsUpdate() { return !m_bDone; }

  override void Run() {
    m_Group = null;
    m_Vehicle = null;
    m_bDone = false;
    m_iPhase = -1;
    m_iTrackFrames = 0;

    Print("========================================", LogLevel.NORMAL);
    Print("  VEHICLE DRIVE + GETOUT TEST", LogLevel.NORMAL);
    Print("========================================", LogLevel.NORMAL);

    vector basePos = SPAWN_POS;
    basePos[1] = GetGame().GetWorld().GetSurfaceY(basePos[0], basePos[2]);

    // Spawn vehicle 30m east
    vector vehPos = Vector(basePos[0] + 30, 0, basePos[2]);
    vehPos[1] = GetGame().GetWorld().GetSurfaceY(vehPos[0], vehPos[2]);

    EntitySpawnParams vParams = new EntitySpawnParams();
    vParams.TransformMode = ETransformMode.WORLD;
    vParams.Transform[3] = vehPos;

    Resource vRes = Resource.Load(
        "{259EE7B78C51B624}Prefabs/Vehicles/Wheeled/UAZ469/UAZ469.et");
    m_Vehicle =
        GetGame().SpawnEntityPrefab(vRes, GetGame().GetWorld(), vParams);
    if (!m_Vehicle) {
      Print("[Drive] Vehicle spawn failed!", LogLevel.ERROR);
      m_bDone = true;
      return;
    }
    Print(string.Format("[Spawn] Vehicle at %1", vehPos), LogLevel.NORMAL);

    // Spawn 4-man group at base
    vector infPos = basePos;
    infPos[1] = GetGame().GetWorld().GetSurfaceY(infPos[0], infPos[2]) + 1;

    EntitySpawnParams gParams = new EntitySpawnParams();
    gParams.TransformMode = ETransformMode.WORLD;
    gParams.Transform[3] = infPos;

    Resource gRes = Resource.Load(
        "{6F72F05752ED62A8}Prefabs/Groups/OPFOR/Group_USSR_FireGroup_Guard.et");
    IEntity gEnt =
        GetGame().SpawnEntityPrefab(gRes, GetGame().GetWorld(), gParams);
    m_Group = SCR_AIGroup.Cast(gEnt);
    if (!m_Group) {
      Print("[Drive] Group spawn failed!", LogLevel.ERROR);
      m_bDone = true;
      return;
    }
    Print(string.Format("[Spawn] Group (4 agents) at %1", infPos),
          LogLevel.NORMAL);

    // Start boarding after 2s
    GetGame().GetCallqueue().CallLater(PhaseBoard, 2000, false);
  }

  override void Update(float timeSlice) {
    if (m_iPhase < 0)
      return;

    m_iTrackFrames++;
    if (m_iTrackFrames % 180 == 0)
      TrackState();
  }

  //--- PHASE 0: Board vehicle ---
  protected void PhaseBoard() {
    Print("========================================", LogLevel.NORMAL);
    Print("  PHASE 0: BOARD VEHICLE", LogLevel.NORMAL);
    Print("========================================", LogLevel.NORMAL);

    if (!m_Group || !m_Vehicle)
      return;

    vector vehPos = m_Vehicle.GetOrigin();
    AIWaypoint wp = SpawnWaypoint(
        "{B049D4C74FBC0C4D}Prefabs/AI/Waypoints/AIWaypoint_GetInNearest.et",
        vehPos, 20);

    if (wp) {
      m_Group.AddWaypoint(wp);
      Print(string.Format("[Board] GetInNearest assigned at %1", vehPos),
            LogLevel.NORMAL);
    }

    m_iPhase = 0;
    m_iTrackFrames = 0;

    // Poll for boarding complete every 5s
    GetGame().GetCallqueue().CallLater(CheckBoarding, 5000, true);
  }

  protected void CheckBoarding() {
    if (m_iPhase != 0)
      return;
    if (!m_Vehicle || !m_Group)
      return;

    int occupied = CountOccupied();
    int agents = m_Group.GetAgentsCount();

    Print(string.Format("[BoardCheck] Occupied: %1/%2", occupied, agents),
          LogLevel.NORMAL);

    if (occupied >= agents) {
      Print("[BoardCheck] ALL ABOARD!", LogLevel.NORMAL);
      GetGame().GetCallqueue().Remove(CheckBoarding);
      GetGame().GetCallqueue().CallLater(PhaseDrive, 1000, false);
    }
  }

  //--- PHASE 1: Drive to destination ---
  protected void PhaseDrive() {
    Print("========================================", LogLevel.NORMAL);
    Print("  PHASE 1: DRIVE TO DESTINATION", LogLevel.NORMAL);
    Print("========================================", LogLevel.NORMAL);

    if (!m_Group)
      return;

    // Remove boarding waypoint
    AIWaypoint curWP = m_Group.GetCurrentWaypoint();
    if (curWP) {
      m_Group.RemoveWaypoint(curWP);
      SCR_EntityHelper.DeleteEntityAndChildren(curWP);
    }

    // Assign ForcedMove 500m east of SPAWN_POS
    vector dest = Vector(SPAWN_POS[0] + 500, 0, SPAWN_POS[2]);
    dest[1] = GetGame().GetWorld().GetSurfaceY(dest[0], dest[2]);

    AIWaypoint moveWP = SpawnWaypoint(
        "{06E1B6EBD480C6E0}Prefabs/AI/Waypoints/AIWaypoint_ForcedMove.et", dest,
        50);

    if (moveWP) {
      m_Group.AddWaypoint(moveWP);
      Print(string.Format("[Drive] ForcedMove assigned to %1", dest),
            LogLevel.NORMAL);
    }

    m_iPhase = 1;

    // Poll for arrival every 5s
    GetGame().GetCallqueue().CallLater(CheckArrival, 5000, true);
  }

  protected void CheckArrival() {
    if (m_iPhase != 1)
      return;
    if (!m_Vehicle || !m_Group)
      return;

    vector vehPos = m_Vehicle.GetOrigin();
    vector dest = Vector(SPAWN_POS[0] + 500, 0, SPAWN_POS[2]);
    float dist = vector.DistanceXZ(vehPos, dest);

    Print(string.Format("[DriveCheck] Vehicle at %1, dist: %2m", vehPos, dist),
          LogLevel.NORMAL);

    if (dist < 60) {
      Print("[DriveCheck] ARRIVED!", LogLevel.NORMAL);
      GetGame().GetCallqueue().Remove(CheckArrival);
      GetGame().GetCallqueue().CallLater(PhaseGetOut, 1000, false);
    }
  }

  //--- PHASE 2: Dismount ---
  protected void PhaseGetOut() {
    Print("========================================", LogLevel.NORMAL);
    Print("  PHASE 2: DISMOUNT", LogLevel.NORMAL);
    Print("========================================", LogLevel.NORMAL);

    if (!m_Group || !m_Vehicle)
      return;

    // Remove drive waypoint
    AIWaypoint curWP = m_Group.GetCurrentWaypoint();
    if (curWP) {
      m_Group.RemoveWaypoint(curWP);
      SCR_EntityHelper.DeleteEntityAndChildren(curWP);
    }

    vector dismountPos = m_Vehicle.GetOrigin();

    AIWaypoint getOutWP = SpawnWaypoint(
        "{C40316EE26846CAB}Prefabs/AI/Waypoints/AIWaypoint_GetOut.et",
        dismountPos, 30);

    if (getOutWP) {
      m_Group.AddWaypoint(getOutWP);
      Print(string.Format("[Dismount] GetOut assigned at %1", dismountPos),
            LogLevel.NORMAL);
    } else {
      Print("[Dismount] GetOut failed! Trying GetOutInstant...",
            LogLevel.WARNING);

      AIWaypoint instantWP = SpawnWaypoint(
          "{E5002E8CD9D1F4AF}Prefabs/AI/Waypoints/AIWaypoint_GetOutInstant.et",
          dismountPos, 30);

      if (instantWP) {
        m_Group.AddWaypoint(instantWP);
        Print(string.Format("[Dismount] GetOutInstant assigned at %1",
                            dismountPos),
              LogLevel.NORMAL);
      }
    }

    m_iPhase = 2;

    // Poll for dismount every 3s
    GetGame().GetCallqueue().CallLater(CheckDismount, 3000, true);
  }

  protected void CheckDismount() {
    if (m_iPhase != 2)
      return;
    if (!m_Group)
      return;

    int inVehicle = CountAgentsInVehicle();
    int agents = m_Group.GetAgentsCount();

    Print(string.Format("[DismountCheck] inVehicle: %1/%2", inVehicle, agents),
          LogLevel.NORMAL);

    if (inVehicle == 0) {
      Print("[DismountCheck] ALL DISMOUNTED!", LogLevel.NORMAL);
      GetGame().GetCallqueue().Remove(CheckDismount);
      GetGame().GetCallqueue().CallLater(FinalReport, 2000, false);
    }
  }

  //--- FINAL ---
  protected void FinalReport() {
    Print("========================================", LogLevel.NORMAL);
    Print("  FINAL REPORT", LogLevel.NORMAL);
    Print("========================================", LogLevel.NORMAL);

    if (m_Vehicle)
      Print(string.Format("[Final] Vehicle pos: %1", m_Vehicle.GetOrigin()),
            LogLevel.NORMAL);

    if (m_Group) {
      Print(string.Format("[Final] Group agents: %1", m_Group.GetAgentsCount()),
            LogLevel.NORMAL);
      array<AIAgent> agents = {};
      m_Group.GetAgents(agents);
      foreach (AIAgent agent : agents) {
        IEntity ent = agent.GetControlledEntity();
        if (!ent)
          continue;
        CompartmentAccessComponent ca = CompartmentAccessComponent.Cast(
            ent.FindComponent(CompartmentAccessComponent));
        bool inVeh = false;
        if (ca)
          inVeh = ca.IsInCompartment();
        Print(string.Format("[Final] %1: pos=%2 inVehicle=%3",
                            ent.GetPrefabData().GetPrefabName(),
                            ent.GetOrigin(), inVeh),
              LogLevel.NORMAL);
      }
    }

    Print("========================================", LogLevel.NORMAL);
    Print("  DRIVE + GETOUT TEST COMPLETE", LogLevel.NORMAL);
    Print("========================================", LogLevel.NORMAL);
    m_bDone = true;
  }

  //--- HELPERS ---
  protected AIWaypoint SpawnWaypoint(string prefab, vector pos, float radius) {
    pos[1] = GetGame().GetWorld().GetSurfaceY(pos[0], pos[2]);
    EntitySpawnParams params = new EntitySpawnParams();
    params.TransformMode = ETransformMode.WORLD;
    params.Transform[3] = pos;
    Resource res = Resource.Load(prefab);
    if (!res || !res.IsValid())
      return null;
    IEntity ent =
        GetGame().SpawnEntityPrefab(res, GetGame().GetWorld(), params);
    AIWaypoint wp = AIWaypoint.Cast(ent);
    if (wp)
      wp.SetCompletionRadius(radius);
    return wp;
  }

  protected int CountOccupied() {
    if (!m_Vehicle)
      return 0;
    BaseCompartmentManagerComponent compMgr =
        BaseCompartmentManagerComponent.Cast(
            m_Vehicle.FindComponent(BaseCompartmentManagerComponent));
    if (!compMgr)
      return 0;
    array<BaseCompartmentSlot> slots = {};
    compMgr.GetCompartments(slots);
    int count = 0;
    foreach (BaseCompartmentSlot slot : slots) {
      if (slot.GetOccupant())
        count++;
    }
    return count;
  }

  protected int CountAgentsInVehicle() {
    if (!m_Group)
      return 0;
    array<AIAgent> agentList = {};
    m_Group.GetAgents(agentList);
    int inVehicle = 0;
    foreach (AIAgent agent : agentList) {
      IEntity ent = agent.GetControlledEntity();
      if (!ent)
        continue;
      CompartmentAccessComponent ca = CompartmentAccessComponent.Cast(
          ent.FindComponent(CompartmentAccessComponent));
      if (ca && ca.IsInCompartment())
        inVehicle++;
    }
    return inVehicle;
  }

  protected void TrackState() {
    if (!m_Vehicle || !m_Group)
      return;

    vector vehPos = m_Vehicle.GetOrigin();
    int occupied = CountOccupied();
    int agents = m_Group.GetAgentsCount();

    AIWaypoint wp = m_Group.GetCurrentWaypoint();
    string wpType = "none";
    if (wp)
      wpType = wp.Type().ToString();

    string phaseStr = "?";
    if (m_iPhase == 0)
      phaseStr = "BOARDING";
    if (m_iPhase == 1)
      phaseStr = "DRIVING";
    if (m_iPhase == 2)
      phaseStr = "DISMOUNTING";

    Print(string.Format("[Track:%1] veh=%2 wp=%3 occupied=%4/%5", phaseStr,
                        vehPos, wpType, occupied, agents),
          LogLevel.NORMAL);
  }
}
