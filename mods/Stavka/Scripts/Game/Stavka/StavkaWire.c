// Protocol v1. Keep field names and numeric arrays aligned with @stavka/protocol.
// JsonLoadContext owns parsing; never search response strings for commands.
class StavkaWire
{
  static const int VERSION = 1;
  static const int MAX_BYTES = 900000;
  static const int MAX_COMMANDS = 64;

  static string Quote(string value)
  {
    string encoded = "\"";
    string hex = "0123456789abcdef";
    for (int i = 0; i < value.Length(); i++)
    {
      string character = value.Get(i);
      int code = value.ToAscii(i);
      if (character == "\"") encoded += "\\\"";
      else if (character == "\\") encoded += "\\\\";
      else if (code >= 0 && code < 32) encoded += "\\u00" + hex.Get(code / 16) + hex.Get(code % 16);
      else encoded += character;
    }
    return encoded + "\"";
  }

  static bool IsText(string value, int maxLength = 128)
  {
    if (value.IsEmpty() || value.Length() > maxLength || value != value.Trim()) return false;
    for (int i = 0; i < value.Length(); i++)
    {
      if (value.ToAscii(i) < 32) return false;
    }
    return true;
  }

  static bool IsFinite(float value)
  {
    return value == value && value > -1.0e30 && value < 1.0e30;
  }

  static string Number(float value)
  {
    // Fixed three decimal places avoid locale-dependent formatting and non-finite JSON.
    if (!IsFinite(value)) return "0";
    return value.ToString(-1, 3);
  }

  static string Position(vector value)
  {
    return "[" + Number(value[0]) + "," + Number(value[1]) + "," + Number(value[2]) + "]";
  }

  static string Boolean(bool value)
  {
    if (value) return "true";
    return "false";
  }

  static bool ReadText(JsonLoadContext context, string name, out string value)
  {
    return context.ReadValue(name, value) && IsText(value);
  }

  static bool ReadPosition(JsonLoadContext context, string name, out vector value)
  {
    array<float> coordinates = {};
    if (!context.ReadValue(name, coordinates) || coordinates.Count() != 3) return false;
    for (int i = 0; i < 3; i++)
    {
      if (!IsFinite(coordinates[i]) || Math.AbsFloat(coordinates[i]) > 1000000) return false;
      value[i] = coordinates[i];
    }
    return true;
  }

  static bool DecodeConnect(string body, out float interval)
  {
    if (body.Length() > MAX_BYTES) return false;
    JsonLoadContext context = new JsonLoadContext();
    int version;
    bool accepted;
    bool full;
    return context.LoadFromString(body) && context.ReadValue("protocol_version", version) && version == VERSION
      && context.ReadValue("accepted", accepted) && accepted
      && context.ReadValue("request_full_snapshot", full)
      && context.ReadValue("tick_rate_hint", interval) && IsFinite(interval) && interval > 0;
  }

  static bool IsEmptyBodyRejection(string body)
  {
    if (body.IsEmpty() || body.Length() > 4096) return false;
    JsonLoadContext context = new JsonLoadContext();
    string code;
    return context.LoadFromString(body) && context.StartObject("error")
      && context.ReadValue("code", code) && code == "EMPTY_REQUEST_BODY" && context.EndObject();
  }

  static bool RetryEmptyBody(int status, string body, int previousFailures)
  {
    return status == 400 && previousFailures >= 0 && previousFailures < 3 && IsEmptyBodyRejection(body);
  }

  static float TickIntervalSeconds(float milliseconds)
  {
    // Protocol hints use milliseconds; native world time uses seconds.
    return Math.Clamp(milliseconds / 1000, 0.1, 60);
  }

  static StavkaTickReply DecodeTick(string body, int expectedTick)
  {
    if (body.Length() > MAX_BYTES) return null;
    JsonLoadContext context = new JsonLoadContext();
    if (!context.LoadFromString(body)) return null;
    StavkaTickReply reply = new StavkaTickReply();
    int version;
    int tick;
    if (!context.ReadValue("protocol_version", version) || version != VERSION) return null;
    if (!context.ReadValue("tick_id", tick) || tick != expectedTick) return null;
    if (!context.ReadValue("tick_rate_hint", reply.interval) || !IsFinite(reply.interval) || reply.interval <= 0) return null;
    if (!context.ReadValue("request_full_snapshot", reply.full)) return null;
    if (!context.StartObject("config_updates")) return null;
    if (context.DoesKeyExist("full_snapshot_interval"))
    {
      if (!context.ReadValue("full_snapshot_interval", reply.fullInterval) || reply.fullInterval < 1) return null;
    }
    if (context.DoesKeyExist("delta_movement_threshold_meters"))
    {
      if (!context.ReadValue("delta_movement_threshold_meters", reply.movementThreshold) || !IsFinite(reply.movementThreshold) || reply.movementThreshold < 0) return null;
    }
    if (context.DoesKeyExist("contact_expiry_seconds"))
    {
      if (!context.ReadValue("contact_expiry_seconds", reply.contactExpiry) || !IsFinite(reply.contactExpiry) || reply.contactExpiry <= 0) return null;
    }
    if (context.DoesKeyExist("detection_range_meters"))
    {
      if (!context.ReadValue("detection_range_meters", reply.detectionRange) || !IsFinite(reply.detectionRange) || reply.detectionRange <= 0) return null;
    }
    if (!context.EndObject() || !context.StartObject("commander_status")) return null;
    if (!ReadText(context, "mode", reply.mode)) return null;
    if (reply.mode != "rule" && reply.mode != "llm" && reply.mode != "degraded") return null;
    bool connected;
    bool decisionPending;
    int activeGroups;
    string doctrine;
    if (!context.ReadValue("connected", connected) || !context.ReadValue("decision_pending", decisionPending)) return null;
    if (!context.ReadValue("active_groups", activeGroups) || activeGroups < 0 || !ReadText(context, "doctrine", doctrine)) return null;
    if (!context.EndObject()) return null;
    int count;
    if (!context.StartArray("commands", count) || count < 0 || count > MAX_COMMANDS) return null;
    map<string, bool> seen = new map<string, bool>();
    for (int i = 0; i < count; i++)
    {
      if (!context.StartObject()) return null;
      StavkaCommand command = new StavkaCommand();
      if (!ReadText(context, "command_id", command.id) || seen.Contains(command.id)) return null;
      seen.Insert(command.id, true);
      if (!ReadText(context, "type", command.kind)) return null;
      if (!context.StartObject("params")) return null;
      command.valid = command.ReadParams(context);
      if (!context.EndObject() || !context.EndObject()) return null;
      reply.commands.Insert(command);
    }
    if (!context.EndArray()) return null;
    return reply;
  }
}

class StavkaTickReply
{
  float interval;
  bool full;
  int fullInterval = -1;
  float movementThreshold = -1;
  float contactExpiry = -1;
  float detectionRange = -1;
  string mode;
  ref array<ref StavkaCommand> commands = {};
}

class StavkaCommand
{
  string id;
  string kind;
  string groupId;
  string templateName;
  string faction;
  string behavior;
  string objectiveId;
  string action;
  string status;
  string assignee;
  vector position;
  bool hasPosition;
  float radius = 30;
  bool valid;

  bool ReadParams(JsonLoadContext context)
  {
    if (kind == "spawn_group")
    {
      if (!StavkaWire.ReadText(context, "template", templateName)) return false;
      if (context.DoesKeyExist("faction") && !StavkaWire.ReadText(context, "faction", faction)) return false;
      if (context.DoesKeyExist("behavior") && !StavkaWire.ReadText(context, "behavior", behavior)) return false;
      if (context.DoesKeyExist("target_objective") && !StavkaWire.ReadText(context, "target_objective", objectiveId)) return false;
      hasPosition = StavkaWire.ReadPosition(context, "position", position);
      return hasPosition;
    }
    if (kind == "set_objective")
    {
      if (!StavkaWire.ReadText(context, "objective_id", objectiveId) || !StavkaWire.ReadText(context, "action", action)) return false;
      if (context.DoesKeyExist("position"))
      {
        hasPosition = StavkaWire.ReadPosition(context, "position", position);
        if (!hasPosition) return false;
      }
      if (context.DoesKeyExist("status") && !StavkaWire.ReadText(context, "status", status)) return false;
      if (!status.IsEmpty() && status != "friendly" && status != "enemy" && status != "neutral" && status != "contested") return false;
      if (action == "create") return hasPosition;
      if (action == "update") return hasPosition || !status.IsEmpty();
      if (action == "remove") return true;
      if (action == "assign") return StavkaWire.ReadText(context, "assignee_group_id", assignee);
      return false;
    }
    if (!StavkaWire.ReadText(context, "group_id", groupId)) return false;
    if (kind == "despawn_group") return true;
    if (kind == "move_group" || kind == "attack_group" || kind == "sweep_group")
    {
      if (context.DoesKeyExist("behavior") && !StavkaWire.ReadText(context, "behavior", behavior)) return false;
      hasPosition = StavkaWire.ReadPosition(context, "destination", position);
      return hasPosition;
    }
    if (kind == "defend_group" || kind == "patrol_group")
    {
      if (context.DoesKeyExist("radius"))
      {
        if (!context.ReadValue("radius", radius) || !StavkaWire.IsFinite(radius) || radius <= 0 || radius > 2000) return false;
      }
      else if (kind == "patrol_group") return false;
      hasPosition = StavkaWire.ReadPosition(context, "position", position);
      return hasPosition;
    }
    return false;
  }
}

class StavkaCommandReceipt
{
  string id;
  string status;
  string reason;

  string ToJson()
  {
    string result = "{\"command_id\":" + StavkaWire.Quote(id) + ",\"status\":" + StavkaWire.Quote(status);
    if (!reason.IsEmpty()) result += ",\"reason\":" + StavkaWire.Quote(reason);
    return result + "}";
  }
}

class StavkaObjectiveState
{
  string id;
  string name;
  vector position;
  string status = "neutral";
  float progress;
  bool nativeBase;

  string ToJson()
  {
    return "{\"id\":" + StavkaWire.Quote(id) + ",\"name\":" + StavkaWire.Quote(name) + ",\"position\":" + StavkaWire.Position(position)
      + ",\"status\":" + StavkaWire.Quote(status) + ",\"capture_progress\":" + StavkaWire.Number(progress) + "}";
  }
}

class StavkaGroupState
{
  string id;
  string faction;
  string templateName;
  vector position;
  int current;
  int maximum;
  string behavior = "native";
  string status = "idle";

  string StrengthJson()
  {
    return "{\"current\":" + current.ToString() + ",\"max\":" + maximum.ToString() + "}";
  }

  string Metadata()
  {
    return faction + ":" + templateName + ":" + current.ToString() + ":" + maximum.ToString() + ":" + behavior + ":" + status;
  }

  string ToJson()
  {
    return "{\"id\":" + StavkaWire.Quote(id) + ",\"faction\":" + StavkaWire.Quote(faction) + ",\"template\":" + StavkaWire.Quote(templateName)
      + ",\"position\":" + StavkaWire.Position(position) + ",\"strength\":" + StrengthJson() + ",\"behavior\":" + StavkaWire.Quote(behavior) + ",\"status\":" + StavkaWire.Quote(status) + "}";
  }
}

class StavkaKnownEnemy
{
  string id;
  string reporter;
  vector position;
  float observedAt;

  string ToJson(float now)
  {
    string confidence = "confirmed";
    if (now - observedAt > 15) confidence = "stale";
    return "{\"id\":" + StavkaWire.Quote(id) + ",\"reported_by\":" + StavkaWire.Quote(reporter)
      + ",\"type\":\"unknown\",\"estimated_count\":1,\"last_known_position\":" + StavkaWire.Position(position)
      + ",\"confidence\":" + StavkaWire.Quote(confidence) + ",\"age_seconds\":" + StavkaWire.Number(Math.Max(0, now - observedAt)) + "}";
  }
}
