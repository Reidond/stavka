// Intercepts chat messages and routes "!" commands to StavkaTestRunner.
// Type in game chat:
//   !test terrain   — run a test
//   !tests          — list available tests
//   !stop           — stop active test

modded class SCR_ChatComponent {
  override void OnNewMessage(string msg, int channelId, int senderId) {
    if (msg.StartsWith("!")) {
      if (StavkaTestRunner.HandleChat(msg))
        return;
    }

    super.OnNewMessage(msg, channelId, senderId);
  }
}
