class StavkaRestCallback : RestCallback {
  string m_sLabel;

  void StavkaRestCallback(string label) {
    m_sLabel = label;
    SetOnSuccess(OnRestSuccess);
    SetOnError(OnRestError);
  }

  void OnRestSuccess() {
    Print(string.Format("[%1] SUCCESS", m_sLabel), LogLevel.NORMAL);
    Print(string.Format("[%1] Data: %2", m_sLabel, GetData()), LogLevel.NORMAL);
  }

  void OnRestError() {
    Print(string.Format("[%1] ERROR", m_sLabel), LogLevel.ERROR);
  }
}

class StavkaTest_Rest : StavkaTestBase {
  protected ref StavkaRestCallback m_GetCallback;
  protected ref StavkaRestCallback m_PostCallback;

  override string GetName() {
    return "rest";
  }

  override void Run() {
    Print("========================================", LogLevel.NORMAL);
    Print("  ASYNC CALLBACK TEST", LogLevel.NORMAL);
    Print("========================================", LogLevel.NORMAL);

    m_GetCallback = new StavkaRestCallback("GET");
    m_PostCallback = new StavkaRestCallback("POST");

    RestContext ctx =
        GetGame().GetRestApi().GetContext("http://localhost:3000");
    ctx.SetHeaders(
        "Content-Type,application/json,Authorization,Bearer sk-stavka-test123");

    Print("[Test] Sending async GET ...", LogLevel.NORMAL);
    ctx.GET(m_GetCallback, "/test-get");

    Print("[Test] Sending async POST ...", LogLevel.NORMAL);
    ctx.POST(m_PostCallback, "/test-post", "{\"tick\": 1, \"units\": 5}");

    Print("[Test] Dispatched, waiting ...", LogLevel.NORMAL);
  }
}
