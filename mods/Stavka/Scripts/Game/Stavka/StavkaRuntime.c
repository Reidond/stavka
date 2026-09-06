class StavkaHttpCallback : RestCallback
{
  StavkaRuntime owner;
  int generation;

  void StavkaHttpCallback(StavkaRuntime runtime, int requestGeneration)
  {
    owner = runtime;
    generation = requestGeneration;
    SetOnSuccess(Success);
    SetOnError(Failure);
  }

  void Success() { if (owner) owner.Response(generation, GetHttpCode(), GetData()); }
  void Failure()
  {
    if (GetHttpCode() == 415)
    {
      // Report only known, credential-free media-type errors, never arbitrary
      // response bodies or request headers.
      string error = GetData();
      if (error == "Unsupported content-type: application/octet-stream") Print("[Stavka] Native REST uses application/octet-stream.", LogLevel.ERROR);
      if (error == "Unsupported content-type: text/plain") Print("[Stavka] Native REST uses text/plain.", LogLevel.ERROR);
      if (error == "Unsupported content-type: application/x-www-form-urlencoded") Print("[Stavka] Native REST uses application/x-www-form-urlencoded.", LogLevel.ERROR);
    }
    if (owner) owner.Response(generation, GetHttpCode(), "");
  }
}

class StavkaRuntime
{
  ref StavkaConfig config;
  ref StavkaGroups registry;
  ref StavkaSnapshot snapshot;
  ref StavkaHttpCallback callback;
  RestContext context;
  bool active;
  bool connected;
  bool busy;
  bool forceFull = true;
  bool mapUploaded;
  string pendingBody;
  string pendingPath;
  int tick;
  int generation;
  int failures;
  float nextRequest;
  float watchdog;
  float refreshAt;

  bool Start()
  {
    if (!Replication.IsServer()) return false;
    config = new StavkaConfig();
    if (!config.Load()) return false;
    registry = new StavkaGroups(config);
    snapshot = new StavkaSnapshot(registry);
    registry.ScanExisting();
    active = true;
    nextRequest = registry.Now() + 2;
    Print("[Stavka] Authority bridge enabled; protocol 1.", LogLevel.NORMAL);
    return true;
  }

  void Update(float timeSlice)
  {
    if (!active || !Replication.IsServer()) return;
    float now = registry.Now();
    if (now >= refreshAt)
    {
      registry.Refresh();
      refreshAt = now + 1;
    }
    if (busy)
    {
      if (now > watchdog) Fail(0);
      return;
    }
    if (now < nextRequest) return;
    if (pendingBody.IsEmpty())
    {
      if (!connected) { pendingPath = "/api/connect"; pendingBody = config.ConnectJson(); }
      else if (!mapUploaded && config.uploadTerrain)
      {
        pendingPath = "/api/map";
        pendingBody = StavkaTerrain.Upload(config);
        if (pendingBody.IsEmpty())
        {
          active = false;
          Print("[Stavka] Terrain extraction failed; bridge stopped. Check world bounds and resolution.", LogLevel.ERROR);
          return;
        }
      }
      else { pendingPath = "/api/tick"; pendingBody = snapshot.Build(tick, forceFull); }
    }
    Send();
  }

  void Send()
  {
    if (pendingBody.Length() > StavkaWire.MAX_BYTES)
    {
      active = false;
      Print("[Stavka] Protocol envelope exceeds native REST limit; bridge stopped.", LogLevel.ERROR);
      return;
    }
    context = GetGame().GetRestApi().GetContext(config.origin);
    if (!context) { Fail(0); return; }
    if (!context.SetHeaders(config.HeaderDefinition()))
    { active = false; Print("[Stavka] REST headers rejected.", LogLevel.ERROR); return; }
    context.SetTimeout(20);
    generation++;
    callback = new StavkaHttpCallback(this, generation);
    busy = true;
    watchdog = registry.Now() + 25;
    context.POST(callback, pendingPath, pendingBody);
  }

  void Response(int requestGeneration, int status, string body)
  {
    if (!active || !busy || requestGeneration != generation) return;
    if (status < 200 || status >= 300) { Fail(status); return; }
    if (pendingPath == "/api/connect")
    {
      float interval;
      if (!StavkaWire.DecodeConnect(body, interval)) { Fail(0); return; }
      config.interval = Math.Clamp(interval, 1, 60);
      connected = true;
      Print("[Stavka] Commander connected.", LogLevel.NORMAL);
    }
    else if (pendingPath == "/api/tick")
    {
      StavkaTickReply reply = StavkaWire.DecodeTick(body, tick);
      if (!reply) { Fail(0); return; }
      snapshot.Acknowledge(tick);
      config.interval = Math.Clamp(reply.interval, 1, 60);
      if (reply.fullInterval > 0) config.fullInterval = Math.ClampInt(reply.fullInterval, 1, 120);
      if (reply.movementThreshold >= 0) config.movementThreshold = Math.Clamp(reply.movementThreshold, 0, 100);
      if (reply.contactExpiry > 0) config.contactExpiry = Math.Clamp(reply.contactExpiry, 1, 1800);
      if (reply.detectionRange > 0) config.detectionRange = Math.Clamp(reply.detectionRange, 1, 10000);
      forceFull = reply.full;
      tick++;
      foreach (StavkaCommand command : reply.commands) registry.Execute(command);
    }
    else if (pendingPath == "/api/map") mapUploaded = true;
    pendingBody = "";
    busy = false;
    failures = 0;
    nextRequest = registry.Now() + config.interval;
  }

  void Fail(int status)
  {
    busy = false;
    generation++;
    if (callback) callback.owner = null;
    // RestContext.reset is unsupported in 1.8. The native timeout bounds the
    // request; invalidate its callback generation instead of pretending to cancel.
    // Auth, stale epoch and semantic errors require operator correction. Never
    // silently invent a new epoch, reset tick ids or replay under a new identity.
    if (status >= 400 && status < 500 && status != 408 && status != 429)
    {
      active = false;
      Print("[Stavka] Bridge stopped after HTTP " + status.ToString() + "; inspect server configuration.", LogLevel.ERROR);
      return;
    }
    failures++;
    float delay = Math.Min(60, Math.Pow(2, Math.Min(failures, 6)));
    nextRequest = registry.Now() + delay;
    Print("[Stavka] Request failed; retry in " + delay.ToString() + " seconds.", LogLevel.WARNING);
  }

  void Stop()
  {
    active = false;
    generation++;
    if (callback) callback.owner = null;
    if (!connected || !context) return;
    // Best effort during world teardown; no callbacks into destroyed world state.
    callback = new StavkaHttpCallback(null, generation);
    context.POST(callback, "/api/disconnect", "{" + config.IdentityJson() + ",\"reason\":\"mission_ended\"}");
    connected = false;
  }
}

modded class SCR_BaseGameMode
{
  protected ref StavkaRuntime m_StavkaRuntime;
#ifdef WORKBENCH
  protected ref StavkaSmoke m_StavkaSmoke;
  protected bool m_StavkaSmokeChecked;
#endif

  override protected void OnGameModeStart()
  {
    super.OnGameModeStart();
    if (!Replication.IsServer()) return;
#ifdef WORKBENCH
    string smokeMode;
    if (System.GetCLIParam("stavkaSmoke", smokeMode) && smokeMode == "1") return;
#endif
    m_StavkaRuntime = new StavkaRuntime();
    if (!m_StavkaRuntime.Start()) m_StavkaRuntime = null;
  }

  override protected void EOnFrame(IEntity owner, float timeSlice)
  {
    super.EOnFrame(owner, timeSlice);
#ifdef WORKBENCH
    if (!m_StavkaSmokeChecked && Replication.IsServer())
    {
      m_StavkaSmokeChecked = true;
      string smoke;
      if (System.GetCLIParam("stavkaSmoke", smoke) && smoke == "1") m_StavkaSmoke = new StavkaSmoke();
    }
    if (m_StavkaSmoke) m_StavkaSmoke.Update(timeSlice);
#endif
    if (m_StavkaRuntime) m_StavkaRuntime.Update(timeSlice);
  }

  override protected void OnGameModeEnd(SCR_GameModeEndData endData)
  {
    if (m_StavkaRuntime) m_StavkaRuntime.Stop();
    m_StavkaRuntime = null;
    super.OnGameModeEnd(endData);
  }
}
