#ifdef WORKBENCH
// Explicit Workbench-only acceptance mode. No chat/RPC entrypoint, provider calls,
// credentials or network. Artifacts are written to the Workbench profile.
class StavkaSmoke
{
  ref StavkaConfig config;
  ref StavkaGroups registry;
  ref StavkaSnapshot snapshot;
  int phase;
  float started;
  float refreshAt;
  vector initialPosition;
  bool done;
  bool failed;
  SCR_AIGroup opponent;
  float contactPhaseAt;

  void Check(bool condition, string label)
  {
    if (condition) Print("[StavkaSmoke] PASS " + label, LogLevel.NORMAL);
    else { failed = true; Print("[StavkaSmoke] FAIL " + label, LogLevel.ERROR); }
  }

  void Save(string name, string body)
  {
    FileHandle file = FileIO.OpenFile("$profile:stavka-smoke-" + name + ".json", FileMode.WRITE);
    Check(file != null, "open " + name);
    if (!file) return;
    file.Write(body);
    file.Close();
  }

  void Begin()
  {
    config = new StavkaConfig();
    config.sessionId = "native-smoke";
    config.missionId = "native-arland";
    config.epoch = 1;
    config.apiKey = "smoke-machine";
    config.accessClientId = "smoke-client";
    config.accessClientSecret = "smoke-secret";
    // Configure only: no HTTP request is issued by this smoke check.
    RestContext rest = GetGame().GetRestApi().GetContext(config.origin);
    Check(rest && rest.SetHeaders(config.HeaderDefinition()), "native REST accepts all authentication headers");
    config.ConfigureTemplates();
    registry = new StavkaGroups(config);
    snapshot = new StavkaSnapshot(registry);
    started = registry.Now();
    SCR_ManualCamera camera = SCR_CameraEditorComponent.GetCameraInstance();
    if (camera)
    {
      vector cameraTransform[4];
      camera.GetWorldTransform(cameraTransform);
      cameraTransform[3] = Vector(2059, 95, 2047);
      camera.SetWorldTransform(cameraTransform);
      camera.SetDirty(true);
    }
    float interval;
    Check(StavkaWire.TickIntervalSeconds(2000) == 2, "idle tick milliseconds become seconds");
    Check(Math.AbsFloat(StavkaWire.TickIntervalSeconds(750) - 0.75) < 0.001, "active tick milliseconds become seconds");
    Check(Math.AbsFloat(StavkaWire.TickIntervalSeconds(300) - 0.3) < 0.001, "burst tick milliseconds become seconds");
    Check(StavkaWire.TickIntervalSeconds(90000) == 60, "tick interval remains bounded");
    Check(StavkaWire.IsEmptyBodyRejection("{\"error\":{\"code\":\"EMPTY_REQUEST_BODY\"}}"), "recognize server-confirmed empty body");
    Check(!StavkaWire.IsEmptyBodyRejection("{\"error\":{\"code\":\"INVALID_REQUEST\"}}"), "never retry semantic rejection");
    Check(!StavkaWire.IsEmptyBodyRejection("EMPTY_REQUEST_BODY"), "never infer retry from unstructured text");
    StavkaRuntime retryRuntime = new StavkaRuntime();
    retryRuntime.registry = registry;
    retryRuntime.active = true;
    retryRuntime.pendingBody = "retained-payload";
    retryRuntime.pendingPath = "/api/tick";
    retryRuntime.tick = 71;
    for (int attempt = 0; attempt < 3; attempt++)
    {
      retryRuntime.busy = true;
      retryRuntime.Response(retryRuntime.generation, 400, "{\"error\":{\"code\":\"EMPTY_REQUEST_BODY\"}}");
      Check(retryRuntime.active, "empty body recovery attempt " + attempt.ToString());
      Check(retryRuntime.pendingBody == "retained-payload" && retryRuntime.tick == 71, "retry preserves tick and payload");
    }
    Check(!StavkaWire.RetryEmptyBody(400, "{\"error\":{\"code\":\"EMPTY_REQUEST_BODY\"}}", retryRuntime.emptyBodyFailures), "empty body retry budget exhausted");
    Check(!StavkaWire.RetryEmptyBody(401, "{\"error\":{\"code\":\"EMPTY_REQUEST_BODY\"}}", 0), "authentication failure is never retried");
    Check(StavkaWire.DecodeConnect("{\"protocol_version\":1,\"accepted\":true,\"request_full_snapshot\":true,\"tick_rate_hint\":5}", interval), "connect decode");
    string command = "{\"command_id\":\"smoke-spawn\",\"type\":\"spawn_group\",\"params\":{\"template\":\"infantry_squad\",\"position\":[2059,0,2047]}}";
    string replyBody = "{\"protocol_version\":1,\"tick_id\":0,\"tick_rate_hint\":5,\"request_full_snapshot\":false,\"config_updates\":{},";
    replyBody += "\"commander_status\":{\"mode\":\"rule\",\"connected\":true,\"decision_pending\":false,\"active_groups\":0,\"doctrine\":\"balanced\"},\"commands\":[" + command + "]}";
    StavkaTickReply reply = StavkaWire.DecodeTick(replyBody, 0);
    Check(reply && reply.commands.Count() == 1, "tick command array decode");
    Check(StavkaWire.DecodeTick(replyBody, 1) == null, "reject wrong tick");
    if (!reply || reply.commands.Count() != 1) { done = true; return; }
    Check(reply.commands[0].valid, "spawn params decode");
    registry.Execute(reply.commands[0]);
    registry.Execute(reply.commands[0]);
    Check(registry.groups.Count() == 1, "duplicate spawn has one group");
    Save("connect", config.ConnectJson());
    Save("map", StavkaTerrain.Upload(config));
    Save("initial", snapshot.Build(0, true));
    snapshot.Acknowledge(0);
    phase = 1;
  }

  void Update(float timeSlice)
  {
    if (done) return;
    if (!registry) { Begin(); return; }
    float now = registry.Now();
    if (now < refreshAt) return;
    refreshAt = now + 1;
    registry.Refresh();
    StavkaManagedGroup group = registry.groups.Get("g-smoke-spawn");
    if (group && Math.Mod(Math.Floor(now - started), 10) == 0)
    {
      Print("[StavkaSmoke] phase=" + phase.ToString() + " position=" + group.state.position.ToString() + " agents=" + group.state.current.ToString(), LogLevel.NORMAL);
      if (opponent) Print("[StavkaSmoke] opposing agents=" + opponent.GetAgentsCount().ToString(), LogLevel.NORMAL);
      array<AIAgent> observers = {};
      group.entity.GetAgents(observers);
      foreach (AIAgent observer : observers)
      {
        PerceptionComponent sensor = PerceptionComponent.Cast(observer.FindComponent(PerceptionComponent));
        SCR_AIInfoComponent observerInfo = SCR_AIInfoComponent.Cast(observer.FindComponent(SCR_AIInfoComponent));
        if (observerInfo && observerInfo.m_Perception) sensor = observerInfo.m_Perception;
        if (!sensor) { Print("[StavkaSmoke] missing perception component", LogLevel.WARNING); continue; }
        array<BaseTarget> observedTargets = {};
        sensor.GetTargetsList(observedTargets, ETargetCategory.ENEMY);
        Print("[StavkaSmoke] perceived enemies=" + observedTargets.Count().ToString(), LogLevel.NORMAL);
        foreach (BaseTarget perceived : observedTargets)
          Print("[StavkaSmoke] perceived age=" + perceived.GetTimeSinceSeen().ToString() + " pos=" + perceived.GetLastSeenPosition().ToString(), LogLevel.NORMAL);
      }
    }
    if (opponent)
    {
      opponent.ActivateAI();
      array<AIAgent> opposingAgents = {};
      opponent.GetAgents(opposingAgents);
      foreach (AIAgent opposingAgent : opposingAgents)
      {
        opposingAgent.SetPermanentLOD(0);
        opposingAgent.ActivateAI();
      }
    }
    if (phase == 1 && group && group.state.current > 0 && group.state.status != "initializing")
    {
      Check(registry.receipts.Get("smoke-spawn").status == "completed", "spawn completes after agents initialize");
      initialPosition = group.state.position;
      Save("full", snapshot.Build(1, true));
      snapshot.Acknowledge(1);
      StavkaCommand move = new StavkaCommand();
      move.id = "smoke-move";
      move.kind = "move_group";
      move.groupId = group.state.id;
      move.valid = true;
      move.position = initialPosition + Vector(60, 0, 0);
      move.radius = 8;
      registry.Execute(move);
      Check(registry.receipts.Get(move.id).status == "accepted", "native waypoint accepted");
      phase = 2;
    }
    if (phase == 2 && group && vector.Distance(initialPosition, group.state.position) > 15)
    {
      Check(true, "native AI moved over 15 metres");
      Save("delta", snapshot.Build(2, false));
      snapshot.Acknowledge(2);
      Check(registry.contacts.Count() == 0, "no invented enemy contacts");
      vector enemyPosition = group.state.position + Vector(35, 0, 0);
      enemyPosition[1] = GetGame().GetWorld().GetSurfaceY(enemyPosition[0], enemyPosition[2]) + 0.3;
      EntitySpawnParams parameters = new EntitySpawnParams();
      parameters.TransformMode = ETransformMode.WORLD;
      parameters.Transform[3] = enemyPosition;
      Resource enemyResource = Resource.Load("{84E5BBAB25EA23E5}Prefabs/Groups/BLUFOR/Group_US_FireTeam.et");
      opponent = SCR_AIGroup.Cast(GetGame().SpawnEntityPrefab(enemyResource, GetGame().GetWorld(), parameters));
      Check(opponent != null, "opposing native group spawned");
      if (opponent) opponent.SpawnMembers();
      StavkaCommand attack = new StavkaCommand();
      attack.id = "smoke-attack";
      attack.kind = "attack_group";
      attack.groupId = group.state.id;
      attack.position = enemyPosition;
      attack.valid = true;
      registry.Execute(attack);
      contactPhaseAt = now;
      phase = 3;
    }
    if (phase == 3 && group && registry.contacts.Count() > 0)
    {
      Check(true, "native perception reports an observed enemy");
      Save("contacts", snapshot.Build(3, false));
      snapshot.Acknowledge(3);
      StavkaCommand despawn = new StavkaCommand();
      despawn.id = "smoke-despawn";
      despawn.kind = "despawn_group";
      despawn.groupId = group.state.id;
      despawn.valid = true;
      registry.Execute(despawn);
      Check(registry.groups.Count() == 0, "native group despawned");
      Save("removed", snapshot.Build(4, false));
      phase = 4;
      Finish();
    }
    if (now - started > 150)
    {
      Check(false, "native smoke timeout at phase " + phase.ToString());
      if (group) registry.DeleteGroup(group);
      Finish();
    }
  }

  void Finish()
  {
    if (opponent)
    {
      array<AIAgent> agents = {};
      opponent.GetAgents(agents);
      foreach (AIAgent agent : agents)
      {
        if (agent && agent.GetControlledEntity()) SCR_EntityHelper.DeleteEntityAndChildren(agent.GetControlledEntity());
      }
      SCR_EntityHelper.DeleteEntityAndChildren(opponent);
    }
    done = true;
    string deliberateFailure;
    if (System.GetCLIParam("stavkaSmokeFailure", deliberateFailure) && deliberateFailure == "1")
      Check(false, "deliberate CLI failure check");
    string runId;
    string fingerprint;
    System.GetCLIParam("stavkaRunId", runId);
    System.GetCLIParam("stavkaSourceHash", fingerprint);
    string result = "{\"schema_version\":1,\"run_id\":" + StavkaWire.Quote(runId);
    result += ",\"source_hash\":" + StavkaWire.Quote(fingerprint);
    result += ",\"engine_version\":" + StavkaWire.Quote(GetGame().GetBuildVersion());
    result += ",\"passed\":" + StavkaWire.Boolean(!failed) + ",\"phase\":" + phase.ToString() + "}";
    // This completion record is written last, after cleanup and every capture.
    Save("result", result);
    if (!failed) Print("[StavkaSmoke] COMPLETE PASS", LogLevel.NORMAL);
    else Print("[StavkaSmoke] COMPLETE FAIL", LogLevel.ERROR);
  }
}
#endif
