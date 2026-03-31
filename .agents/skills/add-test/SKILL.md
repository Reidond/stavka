---
name: add-test
description: |
  Add a new Enforce Script test to the StavkaTest mod. Creates the test class file,
  wraps it in the StavkaTestBase pattern, and registers it in StavkaTestRunner.

  Use when: "add test", "new test", "create test", "add a test for", "test script".
---

# Add Test to StavkaTest Mod

Add a new Enforce Script test to `mods/StavkaTest/`. The user provides a test name and either raw script logic or a description of what to test. You create the file and register it.

## Steps

### 1. Determine test name and class name

- User provides a short name like "pathfind" or "vehicle"
- Chat command name: the short name (lowercase, no spaces)
- Class name: `StavkaTest_{PascalCase}` (e.g., `StavkaTest_Pathfind`)

### 2. Create the test file

Write to: `mods/StavkaTest/Scripts/Game/Tests/StavkaTest_{Name}.c`

**One-shot test** (runs once, no frame updates):

```enforce
class StavkaTest_{Name} : StavkaTestBase {
  override string GetName() {
    return "{shortname}";
  }

  override void Run() {
    Print("========================================", LogLevel.NORMAL);
    Print("  {TEST TITLE}", LogLevel.NORMAL);
    Print("========================================", LogLevel.NORMAL);

    // Test logic here
  }
}
```

**Frame-update test** (needs ongoing tracking after Run):

```enforce
class StavkaTest_{Name} : StavkaTestBase {
  // Member variables for tracking state
  protected bool m_bDone = false;

  override string GetName() {
    return "{shortname}";
  }

  override bool NeedsUpdate() {
    return !m_bDone;
  }

  override void Run() {
    m_bDone = false;
    Print("========================================", LogLevel.NORMAL);
    Print("  {TEST TITLE}", LogLevel.NORMAL);
    Print("========================================", LogLevel.NORMAL);

    // Initial setup logic
  }

  override void Update(float timeSlice) {
    // Per-frame logic, set m_bDone = true when finished
  }
}
```

### 3. Register in StavkaTestRunner

Edit `mods/StavkaTest/Scripts/Game/StavkaTestRunner.c`.

In the `Init()` method, add a `Register` line after the existing ones:

```enforce
    Register(new StavkaTest_{Name}());
```

Add it right before the `Print("[StavkaTest] Initialized...")` line.

### 4. Confirm to user

Tell the user:
- File created at `mods/StavkaTest/Scripts/Game/Tests/StavkaTest_{Name}.c`
- Registered in `StavkaTestRunner.Init()`
- Trigger with: `!test {shortname}` in game chat

## Spawn position

- Use `SPAWN_POS` constant (inherited from `StavkaTestBase`) for the base spawn position
- `static const vector SPAWN_POS = Vector(2059, 0, 2047)` — defined in `StavkaTestBase.c`
- For multi-group tests, offset from SPAWN_POS: `Vector(SPAWN_POS[0], 0, SPAWN_POS[2] + 150)`
- Always resolve Y from terrain: `pos[1] = GetGame().GetWorld().GetSurfaceY(pos[0], pos[2]) + 1`
- **Never hardcode `Vector(2059, 0, 2047)`** — always use `SPAWN_POS`

## Enforce Script rules

**IMPORTANT**: Always load the `arma-reforger` skill before writing test code. It contains the full
Enforce Script language reference, API patterns, naming conventions, and critical compile-time rules
(no `ref` on entities, `string.Format` max 9 params, non-existent APIs to avoid, etc.).
