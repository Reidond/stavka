[WorkbenchPluginAttribute("Stavka native smoke", "CLI-only native acceptance", "", "", {"WorldEditor"})]
class StavkaSmokePlugin : WorkbenchPlugin
{
  override void RunCommandline()
  {
    string mode;
    if (!System.GetCLIParam("stavkaSmoke", mode) || mode != "1")
    {
      Print("[StavkaTools] Missing explicit smoke mode", LogLevel.ERROR);
      Workbench.Exit(2);
      return;
    }
    WorldEditor editor = Workbench.GetModule(WorldEditor);
    if (!editor || !editor.SetOpenedResource("{EC9A501F17BF46E8}Worlds/StavkaGM_Arland.ent"))
    {
      Print("[StavkaTools] Smoke world failed to load", LogLevel.ERROR);
      Workbench.Exit(3);
      return;
    }
    // This fixed AI test needs no player arsenal. Remove it from the in-memory
    // test world to avoid unrelated loadout FileIO authorization. Never save.
    WorldEditorAPI api = editor.GetApi();
    api.BeginEntityAction("Prepare native AI smoke");
    for (int i = 0; i < api.GetEditorEntityCount(); i++)
    {
      IEntitySource source = api.GetEditorEntity(i);
      for (int c = source.GetComponentCount() - 1; c >= 0; c--)
      {
        IEntityComponentSource component = source.GetComponent(c);
        if (component.GetClassName() == "SCR_ArsenalManagerComponent")
        {
          api.DeleteComponent(source, component);
          Print("[StavkaTools] Excluded player arsenal from unsaved smoke world");
        }
      }
    }
    api.EndEntityAction();
    Print("[StavkaTools] Starting native smoke through Workbench API");
    editor.SwitchToGameMode();
  }
}
