// This file contains no credentials. Runtime settings are read on authority only
// from $profile:stavka.json; that file must never be packed into an addon.
class StavkaConfig
{
  bool enabled;
  string origin = "https://stavka.sands.red";
  string apiKey;
  string accessClientId;
  string accessClientSecret;
  string sessionId;
  string missionId;
  int epoch;
  string mapName = "Arland";
  string engineFaction = "USSR";
  string faction = "OPFOR";
  string doctrine = "balanced";
  int maxGroups = 12;
  int manpower = 48;
  int fullInterval = 12;
  float interval = 5;
  float movementThreshold = 5;
  float contactExpiry = 120;
  float detectionRange = 2000;
  float mapResolution = 250;
  bool adoptExistingGroups;
  bool uploadTerrain = true;
  ref map<string, ResourceName> templates = new map<string, ResourceName>();

  bool Load()
  {
    JsonLoadContext context = new JsonLoadContext();
    if (!FileIO.FileExists("$profile:stavka.json")) return false;
    if (!context.LoadFromFile("$profile:stavka.json") || !context.ReadValue("enabled", enabled)) return false;
    if (!enabled) return false;
    if (!StavkaWire.ReadText(context, "session_id", sessionId) || !StavkaWire.ReadText(context, "mission_id", missionId)) return false;
    if (!context.ReadValue("mission_epoch", epoch) || epoch < 0) return false;
    if (!StavkaWire.ReadText(context, "api_key", apiKey)) return false;
    if (!StavkaWire.ReadText(context, "access_client_id", accessClientId) || !StavkaWire.ReadText(context, "access_client_secret", accessClientSecret)) return false;
    if (context.DoesKeyExist("origin") && !context.ReadValue("origin", origin)) return false;
    // The deployment has exactly one public origin; do not follow redirects or
    // allow credentials to be sent to arbitrary endpoints from mission assets.
    if (origin != "https://stavka.sands.red") return false;
    if (!HeaderSafe(apiKey) || !HeaderSafe(accessClientId) || !HeaderSafe(accessClientSecret)) return false;
    if (context.DoesKeyExist("map_name") && !StavkaWire.ReadText(context, "map_name", mapName)) return false;
    if (context.DoesKeyExist("engine_faction") && !StavkaWire.ReadText(context, "engine_faction", engineFaction)) return false;
    if (context.DoesKeyExist("faction") && !StavkaWire.ReadText(context, "faction", faction)) return false;
    if (context.DoesKeyExist("doctrine") && !StavkaWire.ReadText(context, "doctrine", doctrine)) return false;
    if (doctrine != "balanced" && doctrine != "aggressive" && doctrine != "defensive") return false;
    if (context.DoesKeyExist("max_groups") && !context.ReadValue("max_groups", maxGroups)) return false;
    if (context.DoesKeyExist("manpower") && !context.ReadValue("manpower", manpower)) return false;
    if (context.DoesKeyExist("adopt_existing_groups") && !context.ReadValue("adopt_existing_groups", adoptExistingGroups)) return false;
    if (context.DoesKeyExist("upload_terrain") && !context.ReadValue("upload_terrain", uploadTerrain)) return false;
    if (context.DoesKeyExist("map_resolution_meters") && !context.ReadValue("map_resolution_meters", mapResolution)) return false;
    if (maxGroups < 1 || maxGroups > 50 || manpower < 0 || manpower > 10000) return false;
    if (!StavkaWire.IsFinite(mapResolution) || mapResolution < 50 || mapResolution > 2000) return false;
    // Map content hashing uses the protocol's ASCII canonical JSON representation.
    for (int i = 0; i < mapName.Length(); i++)
    {
      if (mapName.ToAscii(i) < 32 || mapName.ToAscii(i) > 126) return false;
    }
    ConfigureTemplates();
    return templates.Count() > 0;
  }

  void ConfigureTemplates()
  {
    templates.Clear();
    if (engineFaction == "USSR")
    {
      templates.Insert("infantry_squad", "{E552DABF3636C2AD}Prefabs/Groups/OPFOR/Group_USSR_RifleSquad.et");
    }
    else if (engineFaction == "US")
    {
      templates.Insert("infantry_squad", "{84E5BBAB25EA23E5}Prefabs/Groups/BLUFOR/Group_US_FireTeam.et");
    }
  }

  static bool HeaderSafe(string value)
  {
    return StavkaWire.IsText(value, 4096) && !value.Contains(",") && !value.Contains("\r") && !value.Contains("\n");
  }

  string IdentityJson()
  {
    return "\"protocol_version\":1,\"session_id\":" + StavkaWire.Quote(sessionId) + ",\"faction\":" + StavkaWire.Quote(faction);
  }

  string ConnectJson()
  {
    return "{" + IdentityJson() + ",\"mission_id\":" + StavkaWire.Quote(missionId) + ",\"mission_epoch\":" + epoch.ToString()
      + ",\"map_name\":" + StavkaWire.Quote(mapName) + ",\"doctrine\":" + StavkaWire.Quote(doctrine) + "}";
  }
}
