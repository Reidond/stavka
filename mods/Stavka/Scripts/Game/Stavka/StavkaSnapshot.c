// Pending snapshots are immutable until acknowledged. Movement thresholds compare
// against acknowledged positions so sub-threshold motion accumulates correctly.
class StavkaSnapshot
{
  ref StavkaGroups registry;
  ref map<string, string> baselineGroups = new map<string, string>();
  ref map<string, vector> baselinePositions = new map<string, vector>();
  ref map<string, string> pendingGroups = new map<string, string>();
  ref map<string, vector> pendingPositions = new map<string, vector>();
  ref map<string, string> pendingReceipts = new map<string, string>();
  ref array<string> baselineObjectives = {};
  ref array<string> baselineContacts = {};
  ref array<string> pendingObjectives = {};
  ref array<string> pendingContacts = {};
  int pendingEventCount;
  int acknowledgedTick = -1;

  void StavkaSnapshot(StavkaGroups groups) { registry = groups; }

  static string Join(array<string> values)
  {
    string result;
    foreach (int index, string value : values)
    {
      if (index > 0) result += ",";
      result += value;
    }
    return "[" + result + "]";
  }

  string MissionJson()
  {
    StavkaConfig config = registry.config;
    int friendly;
    int enemy;
    array<int> players = {};
    GetGame().GetPlayerManager().GetPlayers(players);
    foreach (int playerId : players)
    {
      IEntity entity = GetGame().GetPlayerManager().GetPlayerControlledEntity(playerId);
      if (!entity) continue;
      FactionAffiliationComponent affiliation = FactionAffiliationComponent.Cast(entity.FindComponent(FactionAffiliationComponent));
      if (!affiliation || !affiliation.GetAffiliatedFaction()) continue;
      if (affiliation.GetAffiliatedFaction().GetFactionKey() == config.engineFaction) friendly++;
      else enemy++;
    }
    return "{\"id\":" + StavkaWire.Quote(config.missionId) + ",\"epoch\":" + config.epoch.ToString()
      + ",\"name\":" + StavkaWire.Quote(config.missionId) + ",\"map\":" + StavkaWire.Quote(config.mapName)
      + ",\"time_elapsed_seconds\":" + StavkaWire.Number(registry.Now())
      + ",\"player_count\":{\"friendly\":" + friendly.ToString() + ",\"enemy\":" + enemy.ToString() + "}}";
  }

  string Build(int tick, bool forceFull)
  {
    StavkaConfig config = registry.config;
    bool full = forceFull || acknowledgedTick < 0 || tick % config.fullInterval == 0;
    pendingGroups.Clear();
    pendingPositions.Clear();
    pendingObjectives.Clear();
    pendingContacts.Clear();
    pendingReceipts.Clear();
    array<string> groupJson = {};
    array<string> moved = {};
    array<string> destroyed = {};
    array<string> objectiveJson = {};
    array<string> removedObjectives = {};
    array<string> contactJson = {};
    array<string> expiredContacts = {};
    array<string> receiptJson = {};
    foreach (string id, StavkaManagedGroup group : registry.groups)
    {
      string metadata = group.state.Metadata();
      pendingGroups.Set(id, metadata);
      pendingPositions.Set(id, group.state.position);
      if (full || !baselineGroups.Contains(id) || baselineGroups.Get(id) != metadata)
        groupJson.Insert(group.state.ToJson());
      else if (vector.Distance(baselinePositions.Get(id), group.state.position) >= config.movementThreshold)
        moved.Insert("{\"id\":" + StavkaWire.Quote(id) + ",\"position\":" + StavkaWire.Position(group.state.position) + "}");
      else pendingPositions.Set(id, baselinePositions.Get(id));
    }
    foreach (string previousId, string previousMetadata : baselineGroups)
    {
      if (!pendingGroups.Contains(previousId)) destroyed.Insert(StavkaWire.Quote(previousId));
    }
    foreach (string objectiveId, StavkaObjectiveState objective : registry.objectives)
    {
      pendingObjectives.Insert(objectiveId);
      objectiveJson.Insert(objective.ToJson());
    }
    foreach (string oldObjectiveId : baselineObjectives)
    {
      if (pendingObjectives.Find(oldObjectiveId) < 0) removedObjectives.Insert(StavkaWire.Quote(oldObjectiveId));
    }
    foreach (string contactId, StavkaKnownEnemy contact : registry.contacts)
    {
      pendingContacts.Insert(contactId);
      contactJson.Insert(contact.ToJson(registry.Now()));
    }
    foreach (string oldContactId : baselineContacts)
    {
      if (pendingContacts.Find(oldContactId) < 0) expiredContacts.Insert(StavkaWire.Quote(oldContactId));
    }
    foreach (string commandId, string receipt : registry.dirtyReceipts)
    {
      // Keep envelopes comfortably inside the native REST response/request limit.
      if (receiptJson.Count() >= 256) break;
      pendingReceipts.Set(commandId, receipt);
      receiptJson.Insert(receipt);
    }
    pendingEventCount = registry.events.Count();
    string resources = "{\"manpower\":" + config.manpower.ToString() + ",\"vehicle_pool\":0,\"reinforcement_cooldown_seconds\":0,\"max_active_units\":" + config.maxGroups.ToString() + "}";
    string body = "{" + config.IdentityJson() + ",\"tick_id\":" + tick.ToString() + ",\"timestamp\":" + System.GetUnixTime().ToString()
      + ",\"full_snapshot_interval\":" + config.fullInterval.ToString() + ",\"sergeant_reports\":[],\"events\":" + Join(registry.events)
      + ",\"command_results\":" + Join(receiptJson);
    if (full)
      return body + ",\"type\":\"full\",\"snapshot\":{\"mission\":" + MissionJson() + ",\"objectives\":" + Join(objectiveJson)
        + ",\"friendly_groups\":" + Join(groupJson) + ",\"known_enemies\":" + Join(contactJson) + ",\"resources\":" + resources + "}}";
    body += ",\"type\":\"delta\",\"since_tick\":" + acknowledgedTick.ToString() + ",\"changes\":{\"mission\":" + MissionJson();
    body += ",\"groups_upserted\":" + Join(groupJson) + ",\"groups_moved\":" + Join(moved) + ",\"groups_destroyed\":" + Join(destroyed);
    body += ",\"objectives_upserted\":" + Join(objectiveJson) + ",\"objectives_removed\":" + Join(removedObjectives);
    body += ",\"known_enemies_upserted\":" + Join(contactJson) + ",\"known_enemies_expired\":" + Join(expiredContacts);
    return body + ",\"resources\":" + resources + "}}";
  }

  void Acknowledge(int tick)
  {
    acknowledgedTick = tick;
    baselineGroups.Clear();
    baselinePositions.Clear();
    foreach (string id, string metadata : pendingGroups) baselineGroups.Insert(id, metadata);
    foreach (string positionId, vector position : pendingPositions) baselinePositions.Insert(positionId, position);
    baselineObjectives.Copy(pendingObjectives);
    baselineContacts.Copy(pendingContacts);
    foreach (string commandId, string receipt : pendingReceipts)
    {
      // A native order may have completed while its accepted receipt was in flight.
      if (registry.dirtyReceipts.Get(commandId) == receipt) registry.dirtyReceipts.Remove(commandId);
    }
    for (int i = 0; i < pendingEventCount && registry.events.Count() > 0; i++) registry.events.RemoveOrdered(0);
  }
}
