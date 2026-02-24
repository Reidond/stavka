// Base class for all Stavka tests.
// Extend this and implement GetName() + Run() to add a new test.
class StavkaTestBase {
  // Default spawn origin for all tests. Change here to move all tests at once.
  static const vector SPAWN_POS = Vector(2059, 0, 2047);

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
