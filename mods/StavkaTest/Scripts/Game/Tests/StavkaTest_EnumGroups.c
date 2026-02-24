class StavkaTest_EnumGroups : StavkaTestBase {
  protected int m_iQueryCount;
  protected int m_iGroupCount;
  protected int m_iCharCount;
  protected ref array<SCR_AIGroup> m_aFoundGroups;

  override string GetName() {
    return "enumgroups";
  }

  override void Run() {
    m_iQueryCount = 0;
    m_iGroupCount = 0;
    m_iCharCount = 0;
    m_aFoundGroups = new array<SCR_AIGroup>();

    Print("========================================", LogLevel.NORMAL);
    Print("  ENUMERATE GROUPS TEST v2", LogLevel.NORMAL);
    Print("========================================", LogLevel.NORMAL);

    // Spawn 3 groups: 2 OPFOR, 1 BLUFOR
    vector pos1 = Vector(2059, 0, 2047);
    vector pos2 = Vector(2059, 0, 2197);
    vector pos3 = Vector(2059, 0, 2347);
    pos1[1] = GetGame().GetWorld().GetSurfaceY(pos1[0], pos1[2]) + 1;
    pos2[1] = GetGame().GetWorld().GetSurfaceY(pos2[0], pos2[2]) + 1;
    pos3[1] = GetGame().GetWorld().GetSurfaceY(pos3[0], pos3[2]) + 1;

    SpawnGroup("{E552DABF3636C2AD}Prefabs/Groups/OPFOR/Group_USSR_RifleSquad.et", pos1, "OPFOR-1");
    SpawnGroup("{E552DABF3636C2AD}Prefabs/Groups/OPFOR/Group_USSR_RifleSquad.et", pos2, "OPFOR-2");
    SpawnGroup("{84E5BBAB25EA23E5}Prefabs/Groups/BLUFOR/Group_US_FireTeam.et", pos3, "BLUFOR-1");

    GetGame().GetCallqueue().CallLater(EnumerateAll, 2500, false);
  }

  protected void SpawnGroup(string prefab, vector pos, string label) {
    EntitySpawnParams params = new EntitySpawnParams();
    params.TransformMode = ETransformMode.WORLD;
    params.Transform[3] = pos;
    Resource res = Resource.Load(prefab);
    IEntity ent = GetGame().SpawnEntityPrefab(res, GetGame().GetWorld(), params);
    Print(string.Format("[Spawn] %1 at %2", label, pos), LogLevel.NORMAL);
  }

  protected void EnumerateAll() {
    Print("========================================", LogLevel.NORMAL);
    Print("  METHOD 1: Find characters, trace to groups", LogLevel.NORMAL);
    Print("========================================", LogLevel.NORMAL);
    Print("[M1] Querying entities in 500m sphere ...", LogLevel.NORMAL);

    m_iQueryCount = 0;
    m_iCharCount = 0;
    m_iGroupCount = 0;
    m_aFoundGroups.Clear();
    GetGame().GetWorld().QueryEntitiesBySphere(Vector(2059, 50, 2197), 500, CharacterToGroupCallback);
    Print(string.Format("[M1] Entities scanned: %1", m_iQueryCount), LogLevel.NORMAL);
    Print(string.Format("[M1] Characters found: %1", m_iCharCount), LogLevel.NORMAL);
    Print(string.Format("[M1] Unique groups discovered: %1", m_aFoundGroups.Count()), LogLevel.NORMAL);

    // Print details of each discovered group
    for (int i = 0; i < m_aFoundGroups.Count(); i++) {
      SCR_AIGroup group = m_aFoundGroups[i];
      if (!group)
        continue;

      int agents = group.GetAgentsCount();
      vector pos = group.GetOrigin();

      string faction = "?";
      Faction f = group.GetFaction();
      if (f)
        faction = f.GetFactionKey();

      string wpType = "none";
      AIWaypoint wp = group.GetCurrentWaypoint();
      if (wp)
        wpType = wp.Type().ToString();

      Print(string.Format("[M1] Group[%1]: faction=%2 agents=%3 wp=%4 pos=%5", i, faction, agents, wpType, pos), LogLevel.NORMAL);
    }

    Print("========================================", LogLevel.NORMAL);
    Print("  METHOD 2: Entity type census", LogLevel.NORMAL);
    Print("========================================", LogLevel.NORMAL);
    Print("[M2] Scanning entity types in 500m ...", LogLevel.NORMAL);

    m_iQueryCount = 0;
    GetGame().GetWorld().QueryEntitiesBySphere(Vector(2059, 50, 2197), 500, TypeCensusCallback);
    Print(string.Format("[M2] Total entities: %1", m_iQueryCount), LogLevel.NORMAL);

    Print("========================================", LogLevel.NORMAL);
    Print("  METHOD 3: SCR_AIWorld probe", LogLevel.NORMAL);
    Print("========================================", LogLevel.NORMAL);

    AIWorld aiWorld = GetGame().GetAIWorld();
    if (aiWorld) {
      Print(string.Format("[M3] AIWorld type: %1", aiWorld.Type()), LogLevel.NORMAL);
      SCR_AIWorld scrAIWorld = SCR_AIWorld.Cast(aiWorld);
      if (scrAIWorld) {
        Print("[M3] SCR_AIWorld cast OK", LogLevel.NORMAL);
      } else {
        Print("[M3] SCR_AIWorld cast FAILED", LogLevel.NORMAL);
      }
    } else {
      Print("[M3] AIWorld is NULL", LogLevel.WARNING);
    }

    Print("========================================", LogLevel.NORMAL);
    Print("  METHOD 4: Agent detail extraction", LogLevel.NORMAL);
    Print("========================================", LogLevel.NORMAL);

    for (int i = 0; i < m_aFoundGroups.Count(); i++) {
      SCR_AIGroup group = m_aFoundGroups[i];
      if (!group)
        continue;

      string faction = "?";
      Faction f = group.GetFaction();
      if (f)
        faction = f.GetFactionKey();

      array<AIAgent> agents = {};
      group.GetAgents(agents);
      Print(string.Format("[M4] Group[%1] (%2): %3 agents", i, faction, agents.Count()), LogLevel.NORMAL);

      foreach (AIAgent agent : agents) {
        IEntity ent = agent.GetControlledEntity();
        if (!ent)
          continue;

        vector aPos = ent.GetOrigin();
        string entType = ent.Type().ToString();
        string prefab = ent.GetPrefabData().GetPrefabName();
        Print(string.Format("[M4]   agent: type=%1 pos=%2", entType, aPos), LogLevel.NORMAL);
        Print(string.Format("[M4]   prefab: %1", prefab), LogLevel.NORMAL);
      }
    }

    Print("========================================", LogLevel.NORMAL);
    Print("  ENUMERATE COMPLETE", LogLevel.NORMAL);
    Print("========================================", LogLevel.NORMAL);
  }

  protected bool CharacterToGroupCallback(IEntity ent) {
    m_iQueryCount++;

    // Try to get AIControlComponent from entity to find its agent/group
    AIControlComponent aiCtrl = AIControlComponent.Cast(ent.FindComponent(AIControlComponent));
    if (!aiCtrl)
      return true;

    m_iCharCount++;
    AIAgent agent = aiCtrl.GetAIAgent();
    if (!agent)
      return true;

    AIGroup aiGroup = agent.GetParentGroup();
    if (!aiGroup)
      return true;

    SCR_AIGroup scrGroup = SCR_AIGroup.Cast(aiGroup);
    if (!scrGroup)
      return true;

    // Check if we already found this group
    if (m_aFoundGroups.Find(scrGroup) == -1) {
      m_aFoundGroups.Insert(scrGroup);
    }

    return true;
  }

  protected bool TypeCensusCallback(IEntity ent) {
    m_iQueryCount++;

    // Log first 20 unique types for census
    if (m_iQueryCount <= 20) {
      string entType = ent.Type().ToString();
      Print(string.Format("[M2] Entity[%1]: type=%2", m_iQueryCount, entType), LogLevel.NORMAL);
    }

    // Check specific casts
    SCR_AIGroup group = SCR_AIGroup.Cast(ent);
    if (group) {
      Print(string.Format("[M2] !!! SCR_AIGroup found: %1", ent), LogLevel.NORMAL);
    }

    AIGroup aiGroup = AIGroup.Cast(ent);
    if (aiGroup) {
      Print(string.Format("[M2] !!! AIGroup found: %1", ent), LogLevel.NORMAL);
    }

    return true;
  }
}
