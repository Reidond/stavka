class StavkaTest_RoundTrip : StavkaTestBase {
  protected ref array<SCR_AIGroup> m_aGroups;
  protected int m_iTick;
  protected bool m_bDone;
  protected ref StavkaTickCallback m_pCallback;

  override string GetName() {
    return "roundtrip";
  }

  override bool NeedsUpdate() {
    return !m_bDone;
  }

  override void Run() {
    m_aGroups = new array<SCR_AIGroup>();
    m_iTick = 0;
    m_bDone = false;

    Print("========================================", LogLevel.NORMAL);
    Print("  FULL ROUND-TRIP TEST", LogLevel.NORMAL);
    Print("========================================", LogLevel.NORMAL);

    vector pos = SPAWN_POS;
    pos[1] = GetGame().GetWorld().GetSurfaceY(pos[0], pos[2]) + 1;
    SCR_AIGroup group = SpawnGroupAtPos("{E552DABF3636C2AD}Prefabs/Groups/OPFOR/Group_USSR_RifleSquad.et", pos);
    if (group)
      m_aGroups.Insert(group);

    // Wait for agents to init, then start tick cycle
    GetGame().GetCallqueue().CallLater(DoTick, 3000, false);
  }

  override void Update(float timeSlice) {
    // All logic is CallLater-driven
  }

  //--- TICK: build state -> POST -> parse response -> execute ---
  protected void DoTick() {
    m_iTick++;
    Print("========================================", LogLevel.NORMAL);
    Print(string.Format("  TICK %1", m_iTick), LogLevel.NORMAL);
    Print("========================================", LogLevel.NORMAL);

    // Clean null groups
    for (int i = m_aGroups.Count() - 1; i >= 0; i--) {
      if (!m_aGroups[i])
        m_aGroups.Remove(i);
    }

    string stateJson = BuildStateJSON();
    Print(string.Format("[Tick%1] State JSON length: %2", m_iTick, stateJson.Length()), LogLevel.NORMAL);
    Print(string.Format("[Tick%1] Groups in registry: %2", m_iTick, m_aGroups.Count()), LogLevel.NORMAL);

    // POST to commander
    RestContext ctx = GetGame().GetRestApi().GetContext("http://localhost:3000");
    if (!ctx) {
      Print("[REST] Failed to get context!", LogLevel.ERROR);
      return;
    }

    ctx.SetHeaders("Content-Type,application/json,Authorization,Bearer sk-stavka-test123");

    m_pCallback = new StavkaTickCallback(this, m_iTick);
    ctx.POST(m_pCallback, "/api/tick", stateJson);

    Print(string.Format("[Tick%1] POST sent, awaiting response ...", m_iTick), LogLevel.NORMAL);

    // Schedule next tick (if under 3)
    if (m_iTick < 3)
      GetGame().GetCallqueue().CallLater(DoTick, 8000, false);
    else
      GetGame().GetCallqueue().CallLater(FinalReport, 10000, false);
  }

  //--- Called by callback when response arrives ---
  void OnCommandResponse(int tick, string responseBody) {
    Print("========================================", LogLevel.NORMAL);
    Print(string.Format("  TICK %1 RESPONSE", tick), LogLevel.NORMAL);
    Print("========================================", LogLevel.NORMAL);
    Print(string.Format("[Resp] Body length: %1", responseBody.Length()), LogLevel.NORMAL);
    Print(string.Format("[Resp] Raw: %1", responseBody), LogLevel.NORMAL);

    ParseAndExecuteCommands(responseBody);
  }

  //--- JSON builder ---
  protected string BuildStateJSON() {
    string json = "{\"tick\":" + m_iTick.ToString() + ",\"groups\":[";
    bool first = true;

    for (int i = 0; i < m_aGroups.Count(); i++) {
      SCR_AIGroup group = m_aGroups[i];
      if (!group)
        continue;

      int agentCount = group.GetAgentsCount();
      if (agentCount == 0)
        continue;

      if (!first)
        json += ",";
      first = false;

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

      string faction = "unknown";
      Faction f = group.GetFaction();
      if (f)
        faction = f.GetFactionKey();

      // Split into two Format calls (max 9 params each)
      string part1 = string.Format(
        "{\"id\":%1,\"faction\":\"%2\",\"agentCount\":%3,\"leaderPos\":[%4,%5,%6],",
        i, faction, agentCount,
        leaderPos[0].ToString(), leaderPos[1].ToString(), leaderPos[2].ToString());

      string part2 = string.Format(
        "\"waypoint\":{\"type\":\"%1\",\"pos\":[%2,%3,%4]}}",
        wpType, wpPos[0].ToString(), wpPos[1].ToString(), wpPos[2].ToString());

      json += part1 + part2;
    }

    json += "]}";
    return json;
  }

  //--- Minimal JSON command parser ---
  protected void ParseAndExecuteCommands(string json) {
    int cmdStart = json.IndexOf("\"commands\":[");
    if (cmdStart == -1) {
      Print("[Parse] No 'commands' array found", LogLevel.WARNING);
      return;
    }

    int searchFrom = cmdStart;
    while (true) {
      int typeIdx = json.IndexOfFrom(searchFrom, "\"type\":\"");
      if (typeIdx == -1)
        break;

      int valStart = typeIdx + 8;
      int valEnd = json.IndexOfFrom(valStart, "\"");
      if (valEnd == -1)
        break;

      string cmdType = json.Substring(valStart, valEnd - valStart);
      Print(string.Format("[Parse] Found command: %1", cmdType), LogLevel.NORMAL);

      if (cmdType == "move_group")
        ExecuteMoveGroup(json, searchFrom);
      else if (cmdType == "spawn_group")
        ExecuteSpawnGroup(json, searchFrom);
      else
        Print(string.Format("[Parse] Unknown command type: %1", cmdType), LogLevel.WARNING);

      searchFrom = valEnd + 1;
    }
  }

  protected void ExecuteMoveGroup(string json, int offset) {
    int gidIdx = json.IndexOfFrom(offset, "\"groupId\":");
    if (gidIdx == -1)
      return;
    int gidStart = gidIdx + 10;
    string gidStr = "";
    for (int i = gidStart; i < json.Length(); i++) {
      string ch = json.Get(i);
      if (ch == "," || ch == "}" || ch == " ")
        break;
      gidStr += ch;
    }
    int groupId = gidStr.ToInt();

    Print(string.Format("[Exec] move_group: groupId=%1", groupId), LogLevel.NORMAL);

    if (groupId < 0 || groupId >= m_aGroups.Count() || !m_aGroups[groupId]) {
      Print("[Exec] Invalid group ID!", LogLevel.ERROR);
      return;
    }

    vector pos = ExtractPosition(json, offset);
    pos[1] = GetGame().GetWorld().GetSurfaceY(pos[0], pos[2]);

    Print(string.Format("[Exec] Moving group %1 to %2", groupId, pos), LogLevel.NORMAL);

    SCR_AIGroup group = m_aGroups[groupId];
    AIWaypoint curWP = group.GetCurrentWaypoint();
    if (curWP) {
      group.RemoveWaypoint(curWP);
      SCR_EntityHelper.DeleteEntityAndChildren(curWP);
    }

    AIWaypoint wp = SpawnWaypoint("{06E1B6EBD480C6E0}Prefabs/AI/Waypoints/AIWaypoint_ForcedMove.et", pos, 30);
    if (wp) {
      group.AddWaypoint(wp);
      Print("[Exec] ForcedMove assigned!", LogLevel.NORMAL);
    }
  }

  protected void ExecuteSpawnGroup(string json, int offset) {
    int prefIdx = json.IndexOfFrom(offset, "\"prefab\":\"");
    if (prefIdx == -1)
      return;
    int prefStart = prefIdx + 10;
    int prefEnd = json.IndexOfFrom(prefStart, "\"");
    if (prefEnd == -1)
      return;
    string prefab = json.Substring(prefStart, prefEnd - prefStart);

    vector pos = ExtractPosition(json, offset);
    pos[1] = GetGame().GetWorld().GetSurfaceY(pos[0], pos[2]) + 1;

    Print(string.Format("[Exec] spawn_group: prefab=%1 pos=%2", prefab, pos), LogLevel.NORMAL);

    SCR_AIGroup newGroup = SpawnGroupAtPos(prefab, pos);
    if (newGroup) {
      m_aGroups.Insert(newGroup);
      Print(string.Format("[Exec] Group spawned! Registry: %1 groups", m_aGroups.Count()), LogLevel.NORMAL);
    }
  }

  protected vector ExtractPosition(string json, int offset) {
    int posIdx = json.IndexOfFrom(offset, "\"position\":[");
    if (posIdx == -1)
      return vector.Zero;
    int arrStart = posIdx + 12;
    int arrEnd = json.IndexOfFrom(arrStart, "]");
    if (arrEnd == -1)
      return vector.Zero;

    string arrStr = json.Substring(arrStart, arrEnd - arrStart);
    array<string> parts = {};
    arrStr.Split(",", parts, false);

    vector pos = vector.Zero;
    if (parts.Count() >= 3) {
      pos[0] = parts[0].Trim().ToFloat();
      pos[1] = parts[1].Trim().ToFloat();
      pos[2] = parts[2].Trim().ToFloat();
    }
    return pos;
  }

  //--- Helpers ---
  protected SCR_AIGroup SpawnGroupAtPos(string prefab, vector pos) {
    EntitySpawnParams params = new EntitySpawnParams();
    params.TransformMode = ETransformMode.WORLD;
    params.Transform[3] = pos;
    Resource res = Resource.Load(prefab);
    if (!res || !res.IsValid())
      return null;
    IEntity ent = GetGame().SpawnEntityPrefab(res, GetGame().GetWorld(), params);
    SCR_AIGroup group = SCR_AIGroup.Cast(ent);
    Print(string.Format("[Spawn] Group at %1", pos), LogLevel.NORMAL);
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

  protected void FinalReport() {
    Print("========================================", LogLevel.NORMAL);
    Print("  FINAL STATE", LogLevel.NORMAL);
    Print("========================================", LogLevel.NORMAL);

    for (int i = m_aGroups.Count() - 1; i >= 0; i--) {
      if (!m_aGroups[i])
        m_aGroups.Remove(i);
    }

    Print(string.Format("[Final] Groups in registry: %1", m_aGroups.Count()), LogLevel.NORMAL);

    for (int i = 0; i < m_aGroups.Count(); i++) {
      SCR_AIGroup group = m_aGroups[i];
      string faction = "?";
      Faction f = group.GetFaction();
      if (f)
        faction = f.GetFactionKey();

      vector pos = vector.Zero;
      AIAgent leader = group.GetLeaderAgent();
      if (leader && leader.GetControlledEntity())
        pos = leader.GetControlledEntity().GetOrigin();

      string wpType = "none";
      AIWaypoint wp = group.GetCurrentWaypoint();
      if (wp)
        wpType = wp.Type().ToString();

      Print(string.Format("[Final] Group[%1]: faction=%2 agents=%3 pos=%4 wp=%5",
        i, faction, group.GetAgentsCount(), pos, wpType), LogLevel.NORMAL);
    }

    Print("========================================", LogLevel.NORMAL);
    Print("  ROUND-TRIP TEST COMPLETE", LogLevel.NORMAL);
    Print("========================================", LogLevel.NORMAL);
    m_bDone = true;
  }
}

// Callback class for REST response
class StavkaTickCallback : RestCallback {
  protected StavkaTest_RoundTrip m_Test;
  protected int m_iTick;

  void StavkaTickCallback(StavkaTest_RoundTrip test, int tick) {
    m_Test = test;
    m_iTick = tick;
  }

  override void OnSuccess(string data, int dataSize) {
    Print(string.Format("[REST] Tick %1 response: %2 bytes", m_iTick, dataSize), LogLevel.NORMAL);
    if (m_Test)
      m_Test.OnCommandResponse(m_iTick, data);
  }

  override void OnError(int errorCode) {
    Print(string.Format("[REST] Tick %1 ERROR: %2", m_iTick, errorCode), LogLevel.NORMAL);
  }

  override void OnTimeout() {
    Print(string.Format("[REST] Tick %1 TIMEOUT", m_iTick), LogLevel.NORMAL);
  }
}
