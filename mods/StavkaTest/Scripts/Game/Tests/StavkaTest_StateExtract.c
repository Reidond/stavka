class StavkaTest_StateExtract : StavkaTestBase {
  protected SCR_AIGroup m_Group1;
  protected SCR_AIGroup m_Group2;
  protected SCR_AIGroup m_Group3;

  override string GetName() {
    return "stateextract";
  }

  override void Run() {
    m_Group1 = null;
    m_Group2 = null;
    m_Group3 = null;

    Print("========================================", LogLevel.NORMAL);
    Print("  STATE EXTRACTION TEST", LogLevel.NORMAL);
    Print("========================================", LogLevel.NORMAL);

    vector pos1 = SPAWN_POS;
    vector pos2 = Vector(SPAWN_POS[0], 0, SPAWN_POS[2] + 150);
    vector pos3 = Vector(SPAWN_POS[0], 0, SPAWN_POS[2] + 300);
    pos1[1] = GetGame().GetWorld().GetSurfaceY(pos1[0], pos1[2]) + 1;
    pos2[1] = GetGame().GetWorld().GetSurfaceY(pos2[0], pos2[2]) + 1;
    pos3[1] = GetGame().GetWorld().GetSurfaceY(pos3[0], pos3[2]) + 1;

    m_Group1 = SpawnGroup(pos1, "Squad-Alpha");
    m_Group2 = SpawnGroup(pos2, "Squad-Bravo");
    m_Group3 = SpawnGroup(pos3, "Squad-Charlie");

    GetGame().GetCallqueue().CallLater(AssignAndExtract, 2500, false);
  }

  protected SCR_AIGroup SpawnGroup(vector pos, string label) {
    EntitySpawnParams params = new EntitySpawnParams();
    params.TransformMode = ETransformMode.WORLD;
    params.Transform[3] = pos;

    Resource res = Resource.Load("{E552DABF3636C2AD}Prefabs/Groups/OPFOR/Group_USSR_RifleSquad.et");
    IEntity ent = GetGame().SpawnEntityPrefab(res, GetGame().GetWorld(), params);
    Print(string.Format("[Spawn] %1 at %2", label, pos), LogLevel.NORMAL);
    return SCR_AIGroup.Cast(ent);
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

  protected void AssignAndExtract() {
    if (m_Group1) {
      vector p = m_Group1.GetOrigin();
      AIWaypoint wp = SpawnWaypoint("{06E1B6EBD480C6E0}Prefabs/AI/Waypoints/AIWaypoint_ForcedMove.et", Vector(p[0] + 300, 0, p[2]), 30);
      if (wp)
        m_Group1.AddWaypoint(wp);
    }
    if (m_Group2) {
      AIWaypoint wp = SpawnWaypoint("{93291E72AC23930F}Prefabs/AI/Waypoints/AIWaypoint_Defend.et", m_Group2.GetOrigin(), 50);
      if (wp)
        m_Group2.AddWaypoint(wp);
    }
    if (m_Group3) {
      vector p = m_Group3.GetOrigin();
      AIWaypoint wp = SpawnWaypoint("{1B0E3436C30FA211}Prefabs/AI/Waypoints/AIWaypoint_Attack.et", Vector(p[0] + 300, 0, p[2]), 30);
      if (wp)
        m_Group3.AddWaypoint(wp);
    }

    Print("[WP] All waypoints assigned, waiting 1s for state ...", LogLevel.NORMAL);
    GetGame().GetCallqueue().CallLater(ExtractState, 1000, false);
  }

  protected void ExtractState() {
    Print("========================================", LogLevel.NORMAL);
    Print("  EXTRACTING WORLD STATE", LogLevel.NORMAL);
    Print("========================================", LogLevel.NORMAL);

    // Method 1: QueryEntitiesBySphere to discover all AI groups in world
    Print("[Method1] QueryEntitiesBySphere (r=5000) ...", LogLevel.NORMAL);
    vector center = Vector(SPAWN_POS[0], 0, SPAWN_POS[2] + 150);
    GetGame().GetWorld().QueryEntitiesBySphere(center, 5000, QueryGroupCallback);

    // Method 2: Extract state from our known spawned groups
    Print("[Method2] Known group state ...", LogLevel.NORMAL);
    PrintGroupState("Alpha", m_Group1);
    PrintGroupState("Bravo", m_Group2);
    PrintGroupState("Charlie", m_Group3);

    // Method 3: Build JSON from known groups
    Print("========================================", LogLevel.NORMAL);
    Print("  BUILDING JSON STATE", LogLevel.NORMAL);
    Print("========================================", LogLevel.NORMAL);

    string json = BuildStateJSON();
    Print(string.Format("[JSON] Length: %1", json.Length()), LogLevel.NORMAL);

    int chunkSize = 512;
    int offset = 0;
    while (offset < json.Length()) {
      int remaining = json.Length() - offset;
      int len = remaining;
      if (len > chunkSize)
        len = chunkSize;
      Print("[JSON] " + json.Substring(offset, len), LogLevel.NORMAL);
      offset += len;
    }

    Print("========================================", LogLevel.NORMAL);
    Print("  STATE EXTRACTION COMPLETE", LogLevel.NORMAL);
    Print("========================================", LogLevel.NORMAL);
  }

  protected bool QueryGroupCallback(IEntity ent) {
    SCR_AIGroup group = SCR_AIGroup.Cast(ent);
    if (group) {
      Print(string.Format("[Method1] Found: %1 agents=%2 pos=%3", group.Type(), group.GetAgentsCount(), group.GetOrigin()), LogLevel.NORMAL);
    }
    return true;
  }

  protected void PrintGroupState(string label, SCR_AIGroup group) {
    if (!group) {
      Print(string.Format("[Method2] %1: NULL", label), LogLevel.NORMAL);
      return;
    }

    int agents = group.GetAgentsCount();
    vector pos = group.GetOrigin();

    string wpType = "none";
    AIWaypoint wp = group.GetCurrentWaypoint();
    if (wp)
      wpType = wp.Type().ToString();

    Faction faction = group.GetFaction();
    string fKey = "unknown";
    if (faction)
      fKey = faction.GetFactionKey();

    Print(string.Format("[Method2] %1: agents=%2 pos=%3 wp=%4 faction=%5", label, agents, pos, wpType, fKey), LogLevel.NORMAL);
  }

  protected string BuildStateJSON() {
    string json = "{\"tick\":" + System.GetTickCount().ToString() + ",\"groups\":[";

    array<SCR_AIGroup> groups = {};
    if (m_Group1)
      groups.Insert(m_Group1);
    if (m_Group2)
      groups.Insert(m_Group2);
    if (m_Group3)
      groups.Insert(m_Group3);

    for (int i = 0; i < groups.Count(); i++) {
      SCR_AIGroup group = groups[i];

      if (i > 0)
        json += ",";

      vector leaderPos = vector.Zero;
      AIAgent leader = group.GetLeaderAgent();
      if (leader && leader.GetControlledEntity())
        leaderPos = leader.GetControlledEntity().GetOrigin();

      string wpType = "none";
      vector wpPos = vector.Zero;
      AIWaypoint wp = group.GetCurrentWaypoint();
      if (wp) {
        wpType = wp.Type().ToString();
        wpPos = wp.GetOrigin();
      }

      Faction faction = group.GetFaction();
      string factionKey = "unknown";
      if (faction)
        factionKey = faction.GetFactionKey();

      // Build members array
      string membersJson = "[";
      array<AIAgent> agents = {};
      group.GetAgents(agents);
      for (int a = 0; a < agents.Count(); a++) {
        IEntity ent = agents[a].GetControlledEntity();
        if (!ent)
          continue;

        if (a > 0)
          membersJson += ",";

        vector aPos = ent.GetOrigin();
        string prefabName = ent.GetPrefabData().GetPrefabName();
        membersJson += string.Format("{\"pos\":[%1,%2,%3],\"prefab\":\"%4\"}", aPos[0].ToString(), aPos[1].ToString(), aPos[2].ToString(), prefabName);
      }
      membersJson += "]";

      // Build group entry in parts (Format supports max 9 params)
      string entry = string.Format("{\"id\":%1,\"faction\":\"%2\",\"agentCount\":%3", i, factionKey, group.GetAgentsCount());
      entry += string.Format(",\"leaderPos\":[%1,%2,%3]", leaderPos[0].ToString(), leaderPos[1].ToString(), leaderPos[2].ToString());
      entry += string.Format(",\"waypoint\":{\"type\":\"%1\",\"pos\":[%2,%3,%4]}", wpType, wpPos[0].ToString(), wpPos[1].ToString(), wpPos[2].ToString());
      entry += ",\"members\":" + membersJson + "}";

      json += entry;
    }

    json += "]}";
    return json;
  }
}
