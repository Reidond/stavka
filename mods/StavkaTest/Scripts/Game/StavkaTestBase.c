// Base class for all Stavka tests.
// Extend this and implement GetName() + Run() to add a new test.
class StavkaTestBase {
  string GetName() {
    return "unnamed";
  }

  void Run() {}

  // Override and return true if this test needs per-frame updates after Run().
  bool NeedsUpdate() {
    return false;
  }

  // Called every frame while this test is active and NeedsUpdate() returns true.
  void Update(float timeSlice) {}
}
