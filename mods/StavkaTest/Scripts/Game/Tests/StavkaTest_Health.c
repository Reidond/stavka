class StavkaTest_Health : StavkaTestBase {
  protected SCR_AIGroup m_Group;

  override string GetName() {
    return "health";
  }

  override void Run() {
    m_Group = null;

    Print("========================================", LogLevel.NORMAL);
    Print("  HEALTH / ALIVE STATUS TEST", LogLevel.NORMAL);
    Print("========================================", LogLevel.NORMAL);

    vector pos = Vector(2059, 0, 2047);
    pos[1] = GetGame().GetWorld().GetSurfaceY(pos[0], pos[2]) + 1;

    EntitySpawnParams params = new EntitySpawnParams();
    params.TransformMode = ETransformMode.WORLD;
    params.Transform[3] = pos;

    Resource res = Resource.Load("{E552DABF3636C2AD}Prefabs/Groups/OPFOR/Group_USSR_RifleSquad.et");
    IEntity ent = GetGame().SpawnEntityPrefab(res, GetGame().GetWorld(), params);
    m_Group = SCR_AIGroup.Cast(ent);
    Print(string.Format("[Spawn] Group at %1", pos), LogLevel.NORMAL);

    // 2s: probe all health APIs on healthy squad
    GetGame().GetCallqueue().CallLater(ProbeHealthAPIs, 2000, false);

    // 6s: kill one agent, then probe again
    GetGame().GetCallqueue().CallLater(KillOneAndProbe, 6000, false);

    // 10s: kill all remaining, check group status
    GetGame().GetCallqueue().CallLater(KillAllAndProbe, 10000, false);
  }

  protected void ProbeHealthAPIs() {
    Print("========================================", LogLevel.NORMAL);
    Print("  [2s] PROBING HEALTH APIs - ALL HEALTHY", LogLevel.NORMAL);
    Print("========================================", LogLevel.NORMAL);

    if (!m_Group)
      return;

    array<AIAgent> agents = {};
    m_Group.GetAgents(agents);
    Print(string.Format("[Health] Group agents: %1", agents.Count()), LogLevel.NORMAL);

    foreach (AIAgent agent : agents) {
      IEntity ent = agent.GetControlledEntity();
      if (!ent) {
        Print("[Health] Agent has no controlled entity", LogLevel.WARNING);
        continue;
      }

      string prefab = ent.GetPrefabData().GetPrefabName();

      // Try SCR_DamageManagerComponent
      SCR_DamageManagerComponent dmgMgr = SCR_DamageManagerComponent.Cast(ent.FindComponent(SCR_DamageManagerComponent));
      if (dmgMgr) {
        float health = dmgMgr.GetHealth();
        float maxHealth = dmgMgr.GetMaxHealth();
        EDamageState state = dmgMgr.GetState();
        bool isDestroyed = dmgMgr.IsDestroyed();
        Print(string.Format("[Health] %1: hp=%2/%3 state=%4 destroyed=%5", prefab, health, maxHealth, state, isDestroyed), LogLevel.NORMAL);
      } else {
        Print(string.Format("[Health] %1: NO SCR_DamageManagerComponent", prefab), LogLevel.NORMAL);
      }

      // Try DamageManagerComponent (base class)
      DamageManagerComponent baseDmg = DamageManagerComponent.Cast(ent.FindComponent(DamageManagerComponent));
      if (baseDmg) {
        Print(string.Format("[Health] %1: DamageManagerComponent type=%2", prefab, baseDmg.Type()), LogLevel.NORMAL);
      }

      // Try SCR_CharacterDamageManagerComponent
      SCR_CharacterDamageManagerComponent charDmg = SCR_CharacterDamageManagerComponent.Cast(ent.FindComponent(SCR_CharacterDamageManagerComponent));
      if (charDmg) {
        float health = charDmg.GetHealth();
        float maxHealth = charDmg.GetMaxHealth();
        EDamageState state = charDmg.GetState();
        bool isDestroyed = charDmg.IsDestroyed();
        Print(string.Format("[Health] %1: CharDmg hp=%2/%3 state=%4 destroyed=%5", prefab, health, maxHealth, state, isDestroyed), LogLevel.NORMAL);
      }

      // Try CharacterControllerComponent for IsDead
      CharacterControllerComponent ctrl = CharacterControllerComponent.Cast(ent.FindComponent(CharacterControllerComponent));
      if (ctrl) {
        bool isDead = ctrl.IsDead();
        Print(string.Format("[Health] %1: CharCtrl.IsDead()=%2", prefab, isDead), LogLevel.NORMAL);
      }

      // Try SCR_ChimeraCharacter direct cast
      SCR_ChimeraCharacter chimChar = SCR_ChimeraCharacter.Cast(ent);
      if (chimChar) {
        CharacterControllerComponent cc = chimChar.GetCharacterController();
        if (cc) {
          bool isDead = cc.IsDead();
          Print(string.Format("[Health] %1: ChimeraChar.IsDead()=%2", prefab, isDead), LogLevel.NORMAL);
        }
      }

      Print("  ---", LogLevel.NORMAL);
    }
  }

  protected void KillOneAndProbe() {
    Print("========================================", LogLevel.NORMAL);
    Print("  [6s] KILLING ONE AGENT", LogLevel.NORMAL);
    Print("========================================", LogLevel.NORMAL);

    if (!m_Group)
      return;

    array<AIAgent> agents = {};
    m_Group.GetAgents(agents);
    if (agents.IsEmpty())
      return;

    AIAgent victim = agents[agents.Count() - 1];
    IEntity victimEnt = victim.GetControlledEntity();
    if (victimEnt) {
      string prefab = victimEnt.GetPrefabData().GetPrefabName();
      Print(string.Format("[Kill] Target: %1", prefab), LogLevel.NORMAL);

      SCR_DamageManagerComponent dmgMgr = SCR_DamageManagerComponent.Cast(victimEnt.FindComponent(SCR_DamageManagerComponent));
      if (dmgMgr) {
        Print("[Kill] Calling dmgMgr.Kill()", LogLevel.NORMAL);
        dmgMgr.Kill(Instigator.CreateInstigator(null));
      }

      SCR_CharacterDamageManagerComponent charDmg = SCR_CharacterDamageManagerComponent.Cast(victimEnt.FindComponent(SCR_CharacterDamageManagerComponent));
      if (charDmg) {
        Print(string.Format("[Kill] After Kill(): hp=%1 state=%2 destroyed=%3", charDmg.GetHealth(), charDmg.GetState(), charDmg.IsDestroyed()), LogLevel.NORMAL);
      }
    }

    GetGame().GetCallqueue().CallLater(ProbeAfterKill, 1000, false);
  }

  protected void ProbeAfterKill() {
    Print("========================================", LogLevel.NORMAL);
    Print("  [7s] PROBING AFTER 1 KILL", LogLevel.NORMAL);
    Print("========================================", LogLevel.NORMAL);

    if (!m_Group)
      return;

    Print(string.Format("[PostKill] Group agent count: %1", m_Group.GetAgentsCount()), LogLevel.NORMAL);

    array<AIAgent> agents = {};
    m_Group.GetAgents(agents);

    foreach (AIAgent agent : agents) {
      IEntity ent = agent.GetControlledEntity();
      if (!ent) {
        Print("[PostKill] Agent: no entity (removed?)", LogLevel.NORMAL);
        continue;
      }

      string prefab = ent.GetPrefabData().GetPrefabName();

      SCR_CharacterDamageManagerComponent charDmg = SCR_CharacterDamageManagerComponent.Cast(ent.FindComponent(SCR_CharacterDamageManagerComponent));
      if (charDmg) {
        Print(string.Format("[PostKill] %1: hp=%2/%3 destroyed=%4 state=%5", prefab, charDmg.GetHealth(), charDmg.GetMaxHealth(), charDmg.IsDestroyed(), charDmg.GetState()), LogLevel.NORMAL);
      }

      CharacterControllerComponent ctrl = CharacterControllerComponent.Cast(ent.FindComponent(CharacterControllerComponent));
      if (ctrl) {
        Print(string.Format("[PostKill] %1: IsDead=%2", prefab, ctrl.IsDead()), LogLevel.NORMAL);
      }
    }
  }

  protected void KillAllAndProbe() {
    Print("========================================", LogLevel.NORMAL);
    Print("  [10s] KILLING ALL REMAINING", LogLevel.NORMAL);
    Print("========================================", LogLevel.NORMAL);

    if (!m_Group)
      return;

    array<AIAgent> agents = {};
    m_Group.GetAgents(agents);
    Print(string.Format("[KillAll] Agents before: %1", agents.Count()), LogLevel.NORMAL);

    foreach (AIAgent agent : agents) {
      IEntity ent = agent.GetControlledEntity();
      if (!ent)
        continue;
      SCR_DamageManagerComponent dmgMgr = SCR_DamageManagerComponent.Cast(ent.FindComponent(SCR_DamageManagerComponent));
      if (dmgMgr && !dmgMgr.IsDestroyed()) {
        dmgMgr.Kill(Instigator.CreateInstigator(null));
      }
    }

    GetGame().GetCallqueue().CallLater(ProbeEmptyGroup, 2000, false);
  }

  protected void ProbeEmptyGroup() {
    Print("========================================", LogLevel.NORMAL);
    Print("  [12s] PROBING AFTER FULL WIPE", LogLevel.NORMAL);
    Print("========================================", LogLevel.NORMAL);

    if (!m_Group) {
      Print("[Wipe] Group reference is NULL (auto-deleted?)", LogLevel.NORMAL);
    } else {
      Print(string.Format("[Wipe] Group still exists, agents=%1", m_Group.GetAgentsCount()), LogLevel.NORMAL);

      array<AIAgent> agents = {};
      m_Group.GetAgents(agents);
      Print(string.Format("[Wipe] GetAgents() returned: %1", agents.Count()), LogLevel.NORMAL);

      foreach (AIAgent agent : agents) {
        IEntity ent = agent.GetControlledEntity();
        if (!ent) {
          Print("[Wipe] Agent: no entity", LogLevel.NORMAL);
          continue;
        }
        SCR_CharacterDamageManagerComponent charDmg = SCR_CharacterDamageManagerComponent.Cast(ent.FindComponent(SCR_CharacterDamageManagerComponent));
        if (charDmg) {
          Print(string.Format("[Wipe] Agent: hp=%1 destroyed=%2 state=%3", charDmg.GetHealth(), charDmg.IsDestroyed(), charDmg.GetState()), LogLevel.NORMAL);
        }

        CharacterControllerComponent ctrl = CharacterControllerComponent.Cast(ent.FindComponent(CharacterControllerComponent));
        if (ctrl)
          Print(string.Format("[Wipe] Agent: IsDead=%1", ctrl.IsDead()), LogLevel.NORMAL);
      }
    }

    Print("========================================", LogLevel.NORMAL);
    Print("  HEALTH TEST COMPLETE", LogLevel.NORMAL);
    Print("========================================", LogLevel.NORMAL);
  }
}
