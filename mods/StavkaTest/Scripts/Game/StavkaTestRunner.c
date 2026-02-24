// Test registry and dispatcher.
//
// Triggering tests:
//   1. Chat command: Type in game chat:
//        !test terrain     — run a test by name
//        !tests            — list available tests
//        !stop             — stop active test
//   2. AUTO_RUN: Set the string below to a test name, recompile.
//
// Adding a new test:
//   1. Create Scripts/Game/Tests/StavkaTest_YourName.c extending StavkaTestBase
//   2. Add Register(new StavkaTest_YourName()) in Init() below

class StavkaTestRunner {
  static string AUTO_RUN = "";

  protected static ref array<ref StavkaTestBase> s_aTests;
  protected static ref StavkaTestBase s_pActive;
  protected static bool s_bInitialized = false;
  protected static float s_fDelay = 5.0;
  protected static bool s_bAutoRunDone = false;

  static void Init() {
    if (s_bInitialized)
      return;
    s_bInitialized = true;

    s_aTests = new array<ref StavkaTestBase>();

    // --- Register tests here ---
    Register(new StavkaTest_Terrain());
    Register(new StavkaTest_Rest());
    Register(new StavkaTest_Spawn());
    Register(new StavkaTest_AttackDefend());
    Register(new StavkaTest_MultiDespawn());
    Register(new StavkaTest_StateExtract());
    Register(new StavkaTest_EnumGroups());
    Register(new StavkaTest_Health());
    Register(new StavkaTest_VehicleGetIn());
    Register(new StavkaTest_VehicleDrive());
    Register(new StavkaTest_EventHooks());
    Register(new StavkaTest_Combat());
    Register(new StavkaTest_RoundTrip());

    Print("[StavkaTest] Initialized. Tests available:", LogLevel.NORMAL);
    foreach (StavkaTestBase t : s_aTests)
      Print(string.Format("  - %1", t.GetName()), LogLevel.NORMAL);
  }

  static void Register(StavkaTestBase test) {
    s_aTests.Insert(test);
  }

  // Called from chat handler. Returns true if the message was a test command.
  static bool HandleChat(string message) {
    if (message == "!tests") {
      List();
      return true;
    }

    if (message == "!stop") {
      Stop();
      return true;
    }

    if (message.StartsWith("!test ")) {
      string name = message.Substring(6, message.Length() - 6);
      Run(name);
      return true;
    }

    return false;
  }

  // Run a test by name.
  static void Run(string name) {
    Init();

    foreach (StavkaTestBase test : s_aTests) {
      if (test.GetName() == name) {
        Print(string.Format("[StavkaTest] Running: %1", name), LogLevel.NORMAL);
        s_pActive = test;
        TeleportGMCamera(StavkaTestBase.SPAWN_POS);
        test.Run();
        return;
      }
    }

    Print(string.Format("[StavkaTest] Unknown test: '%1'", name), LogLevel.NORMAL);
    List();
  }

  // Move GM camera to test area (no-op if not in editor mode).
  static void TeleportGMCamera(vector pos) {
    pos[1] = GetGame().GetWorld().GetSurfaceY(pos[0], pos[2]) + 50;

    SCR_ManualCamera camera = SCR_CameraEditorComponent.GetCameraInstance();
    if (!camera) {
      Print("[StavkaTest] No GM camera (not in editor mode?)", LogLevel.NORMAL);
      return;
    }

    SCR_TeleportToCursorManualCameraComponent teleport =
      SCR_TeleportToCursorManualCameraComponent.Cast(
        camera.FindCameraComponent(SCR_TeleportToCursorManualCameraComponent));

    if (teleport) {
      teleport.TeleportCamera(pos);
    } else {
      vector mat[4];
      camera.GetWorldTransform(mat);
      mat[3] = pos;
      camera.SetWorldTransform(mat);
      camera.SetDirty(true);
    }
  }

  // Print all available test names.
  static void List() {
    Init();
    Print("[StavkaTest] Available tests:", LogLevel.NORMAL);
    foreach (StavkaTestBase test : s_aTests)
      Print(string.Format("  - %1", test.GetName()), LogLevel.NORMAL);
  }

  // Stop the active test.
  static void Stop() {
    if (s_pActive) {
      Print(string.Format("[StavkaTest] Stopped: %1", s_pActive.GetName()),
            LogLevel.NORMAL);
      s_pActive = null;
    }
  }

  // Called by the modded game mode every frame.
  static void OnFrame(float timeSlice) {
    if (!s_bInitialized)
      Init();

    // Auto-run after startup delay
    if (AUTO_RUN != "" && !s_bAutoRunDone) {
      s_fDelay -= timeSlice;
      if (s_fDelay <= 0) {
        s_bAutoRunDone = true;
        Run(AUTO_RUN);
      }
    }

    // Delegate frame updates to active test
    if (s_pActive && s_pActive.NeedsUpdate())
      s_pActive.Update(timeSlice);
  }
}

// Game mode hook — delegates frame updates and intercepts chat.
modded class SCR_BaseGameMode {
  override void EOnFrame(IEntity owner, float timeSlice) {
    super.EOnFrame(owner, timeSlice);
    StavkaTestRunner.OnFrame(timeSlice);
  }
}
