class StavkaTest_VehicleGetIn : StavkaTestBase {
  protected SCR_AIGroup m_Group;
  protected IEntity m_Vehicle;
  protected int m_iTrackFrames;
  protected bool m_bTracking;
  protected bool m_bDone;

  override string GetName() {
    return "vehicle";
  }

  override bool NeedsUpdate() {
    return !m_bDone;
  }

  override void Run() {
    m_Group = null;
    m_Vehicle = null;
    m_iTrackFrames = 0;
    m_bTracking = false;
    m_bDone = false;

    Print("========================================", LogLevel.NORMAL);
    Print("  VEHICLE + GETIN TEST", LogLevel.NORMAL);
    Print("========================================", LogLevel.NORMAL);

    vector basePos = SPAWN_POS;
    basePos[1] = GetGame().GetWorld().GetSurfaceY(basePos[0], basePos[2]);

    Print("[Vehicle] Attempting vehicle spawns ...", LogLevel.NORMAL);

    string vehiclePrefabs[] = {
      "{259EE7B78C51B624}Prefabs/Vehicles/Wheeled/UAZ469/UAZ469.et"
    };

    vector vehPos = Vector(basePos[0] + 50, basePos[1], basePos[2]);
    vehPos[1] = GetGame().GetWorld().GetSurfaceY(vehPos[0], vehPos[2]);

    foreach (string prefab : vehiclePrefabs) {
      Resource res = Resource.Load(prefab);
      if (!res || !res.IsValid()) {
        Print(string.Format("[Vehicle] MISS: %1", prefab), LogLevel.NORMAL);
        continue;
      }

      EntitySpawnParams params = new EntitySpawnParams();
      params.TransformMode = ETransformMode.WORLD;
      params.Transform[3] = vehPos;

      m_Vehicle = GetGame().SpawnEntityPrefab(res, GetGame().GetWorld(), params);
      if (m_Vehicle) {
        Print(string.Format("[Vehicle] HIT: %1", prefab), LogLevel.NORMAL);
        Print(string.Format("[Vehicle] Type: %1 Pos: %2", m_Vehicle.Type(), m_Vehicle.GetOrigin()), LogLevel.NORMAL);
        ProbeVehicleComponents(m_Vehicle);
        break;
      }
    }

    if (!m_Vehicle) {
      Print("[Vehicle] No vehicle prefabs loaded! Need correct GUIDs.", LogLevel.ERROR);
      Print("[Vehicle] Try browsing: Prefabs/Vehicles/ in Resource Browser", LogLevel.NORMAL);
      m_bDone = true;
      return;
    }

    // Spawn infantry near vehicle
    vector infPos = Vector(basePos[0], basePos[1], basePos[2]);
    infPos[1] = GetGame().GetWorld().GetSurfaceY(infPos[0], infPos[2]) + 1;

    EntitySpawnParams gParams = new EntitySpawnParams();
    gParams.TransformMode = ETransformMode.WORLD;
    gParams.Transform[3] = infPos;
    Resource gRes = Resource.Load("{6F72F05752ED62A8}Prefabs/Groups/OPFOR/Group_USSR_FireGroup_Guard.et");
    IEntity gEnt = GetGame().SpawnEntityPrefab(gRes, GetGame().GetWorld(), gParams);
    m_Group = SCR_AIGroup.Cast(gEnt);
    Print(string.Format("[Spawn] Infantry at %1", infPos), LogLevel.NORMAL);

    GetGame().GetCallqueue().CallLater(AssignGetIn, 2000, false);
    GetGame().GetCallqueue().CallLater(CheckBoardingStatus, 10000, false);
    GetGame().GetCallqueue().CallLater(CheckBoardingStatus, 20000, false);
    GetGame().GetCallqueue().CallLater(CheckBoardingStatus, 30000, false);
  }

  override void Update(float timeSlice) {
    if (!m_bTracking)
      return;

    m_iTrackFrames++;
    if (m_iTrackFrames % 180 == 0)
      ProbeVehicleState();

    if (m_iTrackFrames > 2400) {
      m_bTracking = false;
      m_bDone = true;
      Print("[Vehicle] Tracking complete.", LogLevel.NORMAL);
    }
  }

  protected void ProbeVehicleComponents(IEntity veh) {
    BaseCompartmentManagerComponent compMgr = BaseCompartmentManagerComponent.Cast(veh.FindComponent(BaseCompartmentManagerComponent));
    if (compMgr) {
      Print("[Vehicle] Has BaseCompartmentManagerComponent", LogLevel.NORMAL);

      array<BaseCompartmentSlot> compartments = {};
      compMgr.GetCompartments(compartments);
      Print(string.Format("[Vehicle] Compartment count: %1", compartments.Count()), LogLevel.NORMAL);

      foreach (BaseCompartmentSlot slot : compartments) {
        bool occupied = slot.GetOccupant() != null;
        Print(string.Format("[Vehicle]   Slot: type=%1 occupied=%2", slot.Type(), occupied), LogLevel.NORMAL);
      }
    } else {
      Print("[Vehicle] NO BaseCompartmentManagerComponent", LogLevel.WARNING);
    }

    SCR_DamageManagerComponent dmg = SCR_DamageManagerComponent.Cast(veh.FindComponent(SCR_DamageManagerComponent));
    if (dmg)
      Print(string.Format("[Vehicle] Health: %1/%2", dmg.GetHealth(), dmg.GetMaxHealth()), LogLevel.NORMAL);

    VehicleControllerComponent vCtrl = VehicleControllerComponent.Cast(veh.FindComponent(VehicleControllerComponent));
    if (vCtrl)
      Print("[Vehicle] Has VehicleControllerComponent", LogLevel.NORMAL);
  }

  protected void AssignGetIn() {
    Print("========================================", LogLevel.NORMAL);
    Print("  [2s] ASSIGNING GETIN WAYPOINT", LogLevel.NORMAL);
    Print("========================================", LogLevel.NORMAL);

    if (!m_Group || !m_Vehicle)
      return;

    Print(string.Format("[GetIn] Group agents: %1", m_Group.GetAgentsCount()), LogLevel.NORMAL);

    vector vehPos = m_Vehicle.GetOrigin();

    // Probe which GetIn prefabs exist
    string getInPrefabs[] = {
      "{712F4795CF8B91C7}Prefabs/AI/Waypoints/AIWaypoint_GetIn.et",
      "{B049D4C74FBC0C4D}Prefabs/AI/Waypoints/AIWaypoint_GetInNearest.et",
      "{8AD8C82346156494}Prefabs/AI/Waypoints/AIWaypoint_GetInSelected.et"
    };

    foreach (string prefab : getInPrefabs) {
      Resource res = Resource.Load(prefab);
      if (!res || !res.IsValid()) {
        Print(string.Format("[GetIn] MISS: %1", prefab), LogLevel.NORMAL);
        continue;
      }
      Print(string.Format("[GetIn] HIT: %1", prefab), LogLevel.NORMAL);
    }

    // Use GetInNearest at vehicle position
    Resource wpRes = Resource.Load("{B049D4C74FBC0C4D}Prefabs/AI/Waypoints/AIWaypoint_GetInNearest.et");
    if (!wpRes || !wpRes.IsValid()) {
      Print("[GetIn] GetInNearest prefab not found!", LogLevel.ERROR);
      return;
    }

    EntitySpawnParams wpParams = new EntitySpawnParams();
    wpParams.TransformMode = ETransformMode.WORLD;
    wpParams.Transform[3] = vehPos;

    IEntity wpEnt = GetGame().SpawnEntityPrefab(wpRes, GetGame().GetWorld(), wpParams);
    AIWaypoint wp = AIWaypoint.Cast(wpEnt);
    if (wp) {
      wp.SetCompletionRadius(20);
      m_Group.AddWaypoint(wp);
      Print(string.Format("[GetIn] Assigned GetInNearest at %1", vehPos), LogLevel.NORMAL);
      Print(string.Format("[GetIn] WP type: %1", wp.Type()), LogLevel.NORMAL);
    }

    m_bTracking = true;
    m_iTrackFrames = 0;
  }

  protected void CheckBoardingStatus() {
    Print("========================================", LogLevel.NORMAL);
    Print("  [8s] CHECKING BOARDING STATUS", LogLevel.NORMAL);
    Print("========================================", LogLevel.NORMAL);

    if (!m_Vehicle)
      return;

    BaseCompartmentManagerComponent compMgr = BaseCompartmentManagerComponent.Cast(m_Vehicle.FindComponent(BaseCompartmentManagerComponent));
    if (compMgr) {
      array<BaseCompartmentSlot> compartments = {};
      compMgr.GetCompartments(compartments);
      int occupied = 0;
      foreach (BaseCompartmentSlot slot : compartments) {
        if (slot.GetOccupant())
          occupied++;
      }
      Print(string.Format("[Board] Compartments: %1 total, %2 occupied", compartments.Count(), occupied), LogLevel.NORMAL);
    }

    if (m_Group) {
      Print(string.Format("[Board] Group agents: %1", m_Group.GetAgentsCount()), LogLevel.NORMAL);

      array<AIAgent> agents = {};
      m_Group.GetAgents(agents);
      foreach (AIAgent agent : agents) {
        IEntity ent = agent.GetControlledEntity();
        if (!ent)
          continue;

        CompartmentAccessComponent compAccess = CompartmentAccessComponent.Cast(ent.FindComponent(CompartmentAccessComponent));
        if (compAccess) {
          bool isInVeh = compAccess.IsInCompartment();
          Print(string.Format("[Board] Agent %1: inCompartment=%2", ent.GetPrefabData().GetPrefabName(), isInVeh), LogLevel.NORMAL);
        }
      }
    }
  }

  protected void ProbeVehicleState() {
    if (!m_Vehicle || !m_Group)
      return;

    AIAgent leader = m_Group.GetLeaderAgent();
    vector leaderPos = vector.Zero;
    if (leader && leader.GetControlledEntity())
      leaderPos = leader.GetControlledEntity().GetOrigin();

    int occupied = 0;
    BaseCompartmentManagerComponent compMgr = BaseCompartmentManagerComponent.Cast(m_Vehicle.FindComponent(BaseCompartmentManagerComponent));
    if (compMgr) {
      array<BaseCompartmentSlot> compartments = {};
      compMgr.GetCompartments(compartments);
      foreach (BaseCompartmentSlot slot : compartments) {
        if (slot.GetOccupant())
          occupied++;
      }
    }

    AIWaypoint wp = m_Group.GetCurrentWaypoint();
    string wpType = "none";
    if (wp)
      wpType = wp.Type().ToString();

    Print(string.Format("[Track] leader=%1 wp=%2 occupied=%3/%4", leaderPos, wpType, occupied, m_Group.GetAgentsCount()), LogLevel.NORMAL);

    // Count how many agents are in compartments
    int boarded = 0;
    array<AIAgent> agents = {};
    m_Group.GetAgents(agents);
    foreach (AIAgent agent : agents) {
      IEntity ent = agent.GetControlledEntity();
      if (!ent)
        continue;
      CompartmentAccessComponent compAccess = CompartmentAccessComponent.Cast(ent.FindComponent(CompartmentAccessComponent));
      if (compAccess && compAccess.IsInCompartment())
        boarded++;
    }
    Print(string.Format("[Track] agents boarded: %1/%2", boarded, agents.Count()), LogLevel.NORMAL);
  }
}
