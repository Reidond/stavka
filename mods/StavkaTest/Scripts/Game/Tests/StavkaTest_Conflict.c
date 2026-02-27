class StavkaTest_Conflict : StavkaTestBase {
  protected int m_iBaseCount;

  override string GetName() {
    return "conflict";
  }

  override void Run() {
    Print("========================================", LogLevel.NORMAL);
    Print("  CONFLICT BASES & OBJECTIVES TEST", LogLevel.NORMAL);
    Print("========================================", LogLevel.NORMAL);

    // --- Method 1: Check game mode type ---
    Print("--- GAME MODE TYPE ---", LogLevel.NORMAL);

    SCR_BaseGameMode gameMode = SCR_BaseGameMode.Cast(GetGame().GetGameMode());
    if (gameMode)
      Print(string.Format("[Mode] Type: %1", gameMode.Type()), LogLevel.NORMAL);

    SCR_GameModeCampaign campaignMode = SCR_GameModeCampaign.Cast(GetGame().GetGameMode());
    if (campaignMode)
    {
      Print("[Mode] SCR_GameModeCampaign FOUND - this is Conflict!", LogLevel.NORMAL);
      ProbeConflictMode(campaignMode);
    }
    else
    {
      Print("[Mode] Not a Conflict scenario - trying generic base discovery", LogLevel.NORMAL);
    }

    // --- Method 2: Find bases via entity sphere query ---
    Print("", LogLevel.NORMAL);
    Print("--- SPHERE QUERY FOR BASES ---", LogLevel.NORMAL);

    m_iBaseCount = 0;
    GetGame().GetWorld().QueryEntitiesBySphere(
      Vector(5000, 0, 5000), 15000,
      BaseQueryCallback, null,
      EQueryEntitiesFlags.ALL);
    Print(string.Format("[Sphere] Entities with military base component: %1", m_iBaseCount), LogLevel.NORMAL);

    // --- Method 3: Faction manager ---
    Print("", LogLevel.NORMAL);
    Print("--- FACTION MANAGER ---", LogLevel.NORMAL);

    FactionManager factionMgr = GetGame().GetFactionManager();
    if (factionMgr)
    {
      Print(string.Format("[Factions] FactionManager type: %1", factionMgr.Type()), LogLevel.NORMAL);

      array<Faction> factions = {};
      factionMgr.GetFactionsList(factions);
      Print(string.Format("[Factions] Count: %1", factions.Count()), LogLevel.NORMAL);

      foreach (Faction f : factions)
      {
        string key = f.GetFactionKey();
        Print(string.Format("[Factions] Key=%1 type=%2", key, f.Type()), LogLevel.NORMAL);

        SCR_CampaignFaction campFaction = SCR_CampaignFaction.Cast(f);
        if (campFaction)
          Print(string.Format("[Factions] %1 is SCR_CampaignFaction", key), LogLevel.NORMAL);
      }
    }
    else
    {
      Print("[Factions] FactionManager is NULL", LogLevel.NORMAL);
    }

    // --- Method 4: World info ---
    Print("", LogLevel.NORMAL);
    Print("--- WORLD INFO ---", LogLevel.NORMAL);

    BaseWorld world = GetGame().GetWorld();
    if (world)
    {
      vector mins, maxs;
      world.GetBoundBox(mins, maxs);
      Print(string.Format("[World] BoundBox min=%1 max=%2", mins, maxs), LogLevel.NORMAL);
      Print(string.Format("[World] Size: %1 x %2",
        (maxs[0] - mins[0]).ToString(), (maxs[2] - mins[2]).ToString()), LogLevel.NORMAL);
    }

    Print("========================================", LogLevel.NORMAL);
    Print("  CONFLICT TEST COMPLETE", LogLevel.NORMAL);
    Print("========================================", LogLevel.NORMAL);
  }

  // --- Conflict-specific probes ---
  protected void ProbeConflictMode(SCR_GameModeCampaign mode)
  {
    Print("[Conflict] Probing campaign mode ...", LogLevel.NORMAL);

    SCR_CampaignMilitaryBaseManager baseMgr = mode.GetBaseManager();
    if (baseMgr)
    {
      Print("[Conflict] GetBaseManager() found!", LogLevel.NORMAL);
      ProbeBaseManager(baseMgr);
    }
    else
    {
      Print("[Conflict] GetBaseManager() NULL", LogLevel.NORMAL);
    }
  }

  protected void ProbeBaseManager(SCR_CampaignMilitaryBaseManager mgr)
  {
    array<SCR_CampaignMilitaryBaseComponent> bases = {};
    mgr.GetBases(bases);
    Print(string.Format("[BaseMgr] Base count: %1", bases.Count()), LogLevel.NORMAL);

    foreach (SCR_CampaignMilitaryBaseComponent base : bases)
    {
      string name = base.GetBaseName();
      vector pos = base.GetOwner().GetOrigin();
      Faction ownerFaction = base.GetFaction();
      string factionKey = "neutral";
      if (ownerFaction)
        factionKey = ownerFaction.GetFactionKey();

      bool isHQ = base.IsHQ();
      int supplies = base.GetSupplies();

      Print(string.Format("[Base] %1: pos=%2 faction=%3 isHQ=%4 supplies=%5",
        name, pos, factionKey, isHQ, supplies), LogLevel.NORMAL);
    }
  }

  // --- Sphere query callback ---
  protected bool BaseQueryCallback(IEntity ent)
  {
    SCR_CampaignMilitaryBaseComponent baseComp = SCR_CampaignMilitaryBaseComponent.Cast(
      ent.FindComponent(SCR_CampaignMilitaryBaseComponent));
    if (baseComp)
    {
      m_iBaseCount++;
      vector pos = ent.GetOrigin();
      string name = baseComp.GetBaseName();
      Print(string.Format("[Sphere] Base found: %1 at %2 type=%3", name, pos, ent.Type()), LogLevel.NORMAL);
    }
    return true;
  }
}
