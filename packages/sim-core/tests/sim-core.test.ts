import { describe, expect, it } from "vitest";

import {
  applyCasualty,
  beginBoarding,
  beginDismount,
  createScenario,
  createWorld,
  executeCommand,
  hashTerrainSamples,
  issueWaypoint,
  restoreWorld,
  snapshotWorld,
  spawnGroup,
  spawnVehicle,
  stepWorld,
  stepWorldMany,
  terrainBriefingSamples,
  upsertObjective,
} from "../src";

describe("deterministic world", () => {
  it("replays the same seed byte-for-byte", () => {
    const first = createScenario("engagement", 42);
    const second = createScenario("engagement", 42);
    stepWorldMany(first, 2_000);
    stepWorldMany(second, 2_000);
    expect(first).toEqual(second);
  });

  it("restores without diverging", () => {
    const uninterrupted = createScenario("engagement", 7);
    stepWorldMany(uninterrupted, 600);
    const restored = restoreWorld(snapshotWorld(uninterrupted));
    stepWorldMany(uninterrupted, 600);
    stepWorldMany(restored, 600);
    expect(restored).toEqual(uninterrupted);
  });

  it("rejects incomplete, non-finite, tampered, and dangling restore snapshots", () => {
    const world = createWorld({ seed: 8, terrainWidth: 4, terrainHeight: 3 });
    spawnGroup(world, { id: "g", faction: "A", template: "squad", position: [0, 0, 0] });
    stepWorldMany(world, 10);
    const base = snapshotWorld(world);
    const corrupt = (mutate: (candidate: Record<string, unknown>) => void): unknown => {
      const candidate = structuredClone(base) as unknown as Record<string, unknown>;
      mutate(candidate);
      return candidate;
    };

    const candidates = [
      corrupt((candidate) => {
        delete candidate.rngState;
      }),
      corrupt((candidate) => {
        delete candidate.groups;
      }),
      corrupt((candidate) => {
        delete candidate.objectives;
      }),
      corrupt((candidate) => {
        delete candidate.terrain;
      }),
      corrupt((candidate) => {
        candidate.version = 2;
      }),
      corrupt((candidate) => {
        candidate.seed = Number.NaN;
      }),
      corrupt((candidate) => {
        candidate.timeMs = 999;
      }),
      corrupt((candidate) => {
        const groups = candidate.groups as Record<string, { targetObjectiveId?: string }>;
        const group = groups.g;
        if (group) group.targetObjectiveId = "missing";
      }),
      corrupt((candidate) => {
        const groups = candidate.groups as Record<string, { mountedVehicleId?: string }>;
        const group = groups.g;
        if (group) group.mountedVehicleId = "missing";
      }),
      corrupt((candidate) => {
        candidate.engagements = {
          "g:missing": {
            key: "g:missing",
            groupA: "g",
            groupB: "missing",
            accumulatedMs: 0,
            contactReported: false,
          },
        };
      }),
      corrupt((candidate) => {
        const terrain = candidate.terrain as { samples: number[] };
        terrain.samples[0] = (terrain.samples[0] ?? 0) + 0.01;
      }),
      corrupt((candidate) => {
        const terrain = candidate.terrain as { samples: number[] };
        terrain.samples.pop();
      }),
      corrupt((candidate) => {
        candidate.unrecognized = true;
      }),
    ];

    for (const candidate of candidates) {
      expect(() => restoreWorld(candidate)).toThrow();
    }
  });

  it("binds terrain identity to rectangular dimensions and restores a valid non-square grid", () => {
    const samples = [1, 2, 3, 4, 5, 6];
    expect(hashTerrainSamples(samples, 2, 3, 10)).not.toBe(hashTerrainSamples(samples, 3, 2, 10));
    expect(hashTerrainSamples(samples, 2, 3, 10)).not.toBe(hashTerrainSamples(samples, 2, 3, 20));

    const world = createWorld({ seed: 9, terrainWidth: 4, terrainHeight: 3 });
    expect(restoreWorld(snapshotWorld(world)).terrain).toEqual(world.terrain);
  });
});

describe("production-scale simulation envelope", () => {
  it("advances a 50-group engagement deterministically within the CI budget", () => {
    const world = createWorld({ seed: 50 });
    for (let index = 0; index < 25; index += 1) {
      spawnGroup(world, {
        id: `blue_${index}`,
        faction: "BLUFOR",
        template: "infantry_squad",
        position: [index * 20, 0, 0],
        strength: 6,
      });
      spawnGroup(world, {
        id: `red_${index}`,
        faction: "OPFOR",
        template: "infantry_squad",
        position: [index * 20, 0, 150],
        strength: 6,
      });
    }
    stepWorldMany(world, 10);
    for (let index = 0; index < 25; index += 1) {
      issueWaypoint(world, `blue_${index}`, "attack", [index * 20, 0, 150]);
      issueWaypoint(world, `red_${index}`, "attack", [index * 20, 0, 0]);
    }
    const started = performance.now();
    stepWorldMany(world, 600);
    const elapsedMs = performance.now() - started;
    expect(Object.keys(world.groups)).toHaveLength(50);
    expect(world.timeMs).toBe(61_000);
    expect(elapsedMs).toBeLessThan(5_000);
  });
});

describe("validated engine behavior", () => {
  it("ForcedMove covers at least 180m in 120 seconds", () => {
    const world = createScenario("movement", 1);
    stepWorldMany(world, 1_200);
    expect(world.groups.blue_1?.position[0]).toBeGreaterThanOrEqual(180);
  });

  it("the normal Move waypoint remains broken by default", () => {
    const world = createWorld({ seed: 1 });
    spawnGroup(world, { id: "g", faction: "A", template: "squad", position: [0, 0, 0] });
    issueWaypoint(world, "g", "move", [100, 0, 0]);
    stepWorldMany(world, 1_200);
    expect(world.groups.g?.position).toEqual([0, 0, 0]);
  });

  it("materializes agents after one second and deletes a wiped group", () => {
    const world = createWorld({ seed: 1 });
    spawnGroup(world, {
      id: "g",
      faction: "A",
      template: "squad",
      position: [0, 0, 0],
      strength: 2,
    });
    stepWorldMany(world, 9);
    expect(world.groups.g?.agents).toHaveLength(0);
    stepWorldMany(world, 1);
    expect(world.groups.g?.agents).toHaveLength(2);
    applyCasualty(world, "g");
    applyCasualty(world, "g");
    expect(world.groups.g).toBeUndefined();
    expect(world.events.at(-1)?.type).toBe("group_wiped");
  });

  it("cleans vehicle occupancy and combat references when a group disappears", () => {
    const world = createWorld({ seed: 37 });
    spawnGroup(world, { id: "g", faction: "A", template: "squad", position: [0, 0, 0] });
    spawnGroup(world, { id: "enemy", faction: "B", template: "squad", position: [50, 0, 0] });
    spawnVehicle(world, { id: "v", template: "UAZ469", position: [0, 0, 0], capacity: 6 });
    stepWorldMany(world, 10);
    beginBoarding(world, "g", "v");
    stepWorldMany(world, 350);
    expect(() => beginBoarding(world, "enemy", "v")).toThrow("occupied by g");
    world.engagements["enemy:g"] = {
      key: "enemy:g",
      groupA: "enemy",
      groupB: "g",
      accumulatedMs: 0,
      contactReported: false,
    };

    executeCommand(world, {
      command_id: "despawn",
      type: "despawn_group",
      params: { group_id: "g" },
    });

    expect(world.groups.g).toBeUndefined();
    expect(world.vehicles.v?.occupiedByGroupId).toBeUndefined();
    expect(world.engagements).toEqual({});
    expect(() => restoreWorld(snapshotWorld(world))).not.toThrow();
  });

  it("reserves a vehicle for exactly one boarding group", () => {
    const world = createWorld({ seed: 38, quirks: { recoverableVehicleStalls: false } });
    spawnGroup(world, { id: "first", faction: "A", template: "squad", position: [0, 0, 0] });
    spawnGroup(world, { id: "second", faction: "A", template: "squad", position: [0, 0, 0] });
    spawnVehicle(world, { id: "v", template: "UAZ469", position: [5, 0, 0], capacity: 6 });
    spawnVehicle(world, { id: "other", template: "UAZ469", position: [5, 0, 0], capacity: 6 });
    stepWorldMany(world, 10);

    beginBoarding(world, "first", "v");

    expect(world.groups.first).toMatchObject({
      status: "boarding",
      mountedVehicleId: "v",
      transitionAtMs: world.timeMs + 27_500,
    });
    expect(world.vehicles.v?.occupiedByGroupId).toBe("first");
    expect(() => restoreWorld(snapshotWorld(world))).not.toThrow();
    const missingReservation = snapshotWorld(world);
    if (missingReservation.vehicles.v) delete missingReservation.vehicles.v.occupiedByGroupId;
    expect(() => restoreWorld(missingReservation)).toThrow("must be reciprocal");
    expect(() => beginBoarding(world, "first", "other")).toThrow("already assigned to vehicle v");
    expect(world.vehicles.other?.occupiedByGroupId).toBeUndefined();
    expect(() => beginBoarding(world, "second", "v")).toThrow("occupied by first");
    expect(world.groups.second).toMatchObject({ status: "idle" });
    expect(world.groups.second?.mountedVehicleId).toBeUndefined();
    expect(world.groups.second?.transitionAtMs).toBeUndefined();

    stepWorldMany(world, 275);

    expect(world.groups.first).toMatchObject({ status: "mounted", mountedVehicleId: "v" });
    expect(world.vehicles.v?.occupiedByGroupId).toBe("first");
    expect(() => restoreWorld(snapshotWorld(world))).not.toThrow();
  });

  it("does not auto-engage unordered groups at 150m", () => {
    const world = createWorld({ seed: 2 });
    spawnGroup(world, {
      id: "a",
      faction: "A",
      template: "squad",
      position: [0, 0, 0],
      strength: 6,
    });
    spawnGroup(world, {
      id: "b",
      faction: "B",
      template: "squad",
      position: [150, 0, 0],
      strength: 4,
    });
    stepWorldMany(world, 1_800);
    expect(world.groups.a?.agents).toHaveLength(6);
    expect(world.groups.b?.agents).toHaveLength(4);
    expect(world.events.some((item) => item.type === "contact")).toBe(false);
  });

  it("mutual attacks stall near 80m and produce attritional casualties", () => {
    const world = createScenario("engagement", 12);
    stepWorldMany(world, 2_000);
    const blue = world.groups.blue_1;
    const red = world.groups.red_1;
    expect(blue).toBeDefined();
    expect(red).toBeDefined();
    if (!blue || !red) return;
    expect(Math.abs(red.position[0] - blue.position[0])).toBeGreaterThanOrEqual(75);
    expect(Math.abs(red.position[0] - blue.position[0])).toBeLessThanOrEqual(85);
    expect(blue.agents.length + red.agents.length).toBeLessThan(10);
  });

  it("does not let a wiped group act again later in the same combat pass", () => {
    const world = createWorld({ seed: 39 });
    spawnGroup(world, {
      id: "a",
      faction: "A",
      template: "squad",
      position: [0, 0, 0],
      strength: 1,
    });
    spawnGroup(world, {
      id: "b",
      faction: "B",
      template: "squad",
      position: [10, 0, 0],
      strength: 6,
    });
    spawnGroup(world, {
      id: "c",
      faction: "B",
      template: "squad",
      position: [20, 0, 0],
      strength: 6,
    });
    stepWorldMany(world, 10);
    issueWaypoint(world, "a", "attack", [20, 0, 0]);
    world.engagements["a:b"] = {
      key: "a:b",
      groupA: "a",
      groupB: "b",
      accumulatedMs: 119_900,
      contactReported: true,
      reportingGroupId: "a",
      targetGroupId: "b",
    };
    world.rngState = 0;

    stepWorld(world);

    expect(world.groups.a).toBeUndefined();
    expect(world.groups.c?.status).toBe("idle");
    expect(world.engagements["a:c"]).toBeUndefined();
    expect(Object.values(world.engagements)).toEqual([]);
    expect(() => restoreWorld(snapshotWorld(world))).not.toThrow();
  });

  it("matches board, drive, and dismount timing", () => {
    const world = createWorld({ seed: 3 });
    spawnGroup(world, {
      id: "g",
      faction: "A",
      template: "squad",
      position: [0, 0, 0],
      strength: 5,
    });
    spawnVehicle(world, { id: "v", template: "UAZ469", position: [5, 0, 0], capacity: 5 });
    stepWorldMany(world, 10);
    beginBoarding(world, "g", "v");
    stepWorldMany(world, 274);
    expect(world.groups.g?.status).toBe("boarding");
    stepWorldMany(world, 1);
    expect(world.groups.g?.status).toBe("mounted");
    issueWaypoint(world, "g", "forced_move", [505, 0, 0]);
    stepWorldMany(world, 180);
    expect(world.vehicles.v?.position[0]).toBeGreaterThanOrEqual(54);
    beginDismount(world, "g");
    stepWorldMany(world, 89);
    expect(world.groups.g?.status).toBe("dismounting");
    stepWorldMany(world, 1);
    expect(world.groups.g?.status).toBe("idle");
  });

  it("models occasional seeded boarding stalls that recover", () => {
    const world = createWorld({ seed: 2 });
    spawnGroup(world, { id: "g", faction: "A", template: "squad", position: [0, 0, 0] });
    spawnVehicle(world, { id: "v", template: "UAZ469", position: [0, 0, 0], capacity: 6 });
    stepWorldMany(world, 10);
    beginBoarding(world, "g", "v");

    expect(world.groups.g?.transitionWasStalled).toBe(true);
    stepWorldMany(world, 350);
    expect(world.groups.g?.status).toBe("mounted");
    expect(world.events.map((item) => item.type)).toEqual(
      expect.arrayContaining(["boarding_stalled", "boarding_recovered", "group_mounted"]),
    );
  });

  it("persists deterministic 15-30 second driving stalls and recovers", () => {
    const setup = (recoverableVehicleStalls: boolean) => {
      const world = createWorld({ seed: 31, quirks: { recoverableVehicleStalls } });
      spawnGroup(world, {
        id: "g",
        faction: "A",
        template: "squad",
        position: [0, 0, 0],
        strength: 5,
      });
      spawnVehicle(world, { id: "v", template: "UAZ469", position: [0, 0, 0], capacity: 5 });
      stepWorldMany(world, 10);
      beginBoarding(world, "g", "v");
      stepWorldMany(world, 400);
      issueWaypoint(world, "g", "forced_move", [2_000, 0, 0]);
      return world;
    };
    const stalled = setup(true);
    const continuous = setup(false);
    stepWorldMany(stalled, 900);
    stepWorldMany(continuous, 900);
    expect(stalled.vehicles.v?.position[0]).toBeLessThan(continuous.vehicles.v?.position[0] ?? 0);
    const restored = restoreWorld(snapshotWorld(stalled));
    stepWorldMany(stalled, 1_100);
    stepWorldMany(restored, 1_100);
    stepWorldMany(continuous, 1_100);

    expect(restored).toEqual(stalled);
    expect(stalled.events.map((item) => item.type)).toEqual(
      expect.arrayContaining(["vehicle_stalled", "vehicle_recovered"]),
    );
    expect(stalled.vehicles.v?.position[0]).toBeGreaterThan(0);
  });

  it("applies geometric slope cost and blocks non-traversable terrain", () => {
    const setup = (nextElevation: number) => {
      const base = createWorld({ seed: 32, terrainWidth: 5, terrainHeight: 5 });
      const samples = Array.from({ length: 25 }, () => 10);
      samples[1 * 5 + 2] = nextElevation;
      const world = { ...base, terrain: { ...base.terrain, samples } };
      spawnGroup(world, { id: "g", faction: "A", template: "squad", position: [10, 0, 10] });
      stepWorldMany(world, 10);
      issueWaypoint(world, "g", "forced_move", [30, 0, 10]);
      return world;
    };
    const flat = setup(10);
    const graded = setup(15);
    const blocked = setup(20);
    stepWorldMany(flat, 10);
    stepWorldMany(graded, 10);
    stepWorldMany(blocked, 10);

    expect(flat.groups.g?.position[0]).toBeCloseTo(12, 6);
    expect(graded.groups.g?.position[0]).toBeGreaterThan(10);
    expect(graded.groups.g?.position[0]).toBeLessThan(flat.groups.g?.position[0] ?? 0);
    expect(blocked.groups.g?.position[0]).toBe(10);
  });

  it("evolves a deterministic 50m+ advancing formation without moving idle agents", () => {
    const world = createWorld({ seed: 33 });
    spawnGroup(world, {
      id: "g",
      faction: "A",
      template: "squad",
      position: [0, 0, 0],
      strength: 6,
    });
    stepWorldMany(world, 10);
    const idleOffsets = structuredClone(world.groups.g?.agents.map((agent) => agent.offset));
    stepWorldMany(world, 100);
    expect(world.groups.g?.agents.map((agent) => agent.offset)).toEqual(idleOffsets);
    issueWaypoint(world, "g", "forced_move", [500, 0, 0]);
    stepWorldMany(world, 300);
    const offsets = world.groups.g?.agents.map((agent) => agent.offset) ?? [];
    const widest = offsets.reduce(
      (maximum, left, leftIndex) =>
        Math.max(
          maximum,
          ...offsets
            .slice(leftIndex + 1)
            .map((right) => Math.hypot(left[0] - right[0], left[2] - right[2])),
        ),
      0,
    );
    expect(offsets).not.toEqual(idleOffsets);
    expect(widest).toBeGreaterThanOrEqual(50);
  });

  it("captures objectives deterministically across snapshot restore", () => {
    const world = createWorld({ seed: 34 });
    spawnGroup(world, {
      id: "blue",
      faction: "BLUFOR",
      template: "squad",
      position: [100, 0, 100],
    });
    stepWorldMany(world, 10);
    upsertObjective(world, {
      id: "alpha",
      name: "Alpha",
      position: [100, 0, 100],
      status: "neutral",
      capture_progress: 0,
    });
    stepWorldMany(world, 150);
    const restored = restoreWorld(snapshotWorld(world));
    stepWorldMany(world, 151);
    stepWorldMany(restored, 151);

    expect(restored).toEqual(world);
    expect(world.objectives.alpha).toMatchObject({
      ownerFaction: "BLUFOR",
      status: "friendly",
      capture_progress: 1,
    });
    expect(world.events.filter((item) => item.type === "objective_captured")).toHaveLength(1);
  });

  it("freezes contested capture and resets progress for a challenger", () => {
    const world = createWorld({ seed: 36 });
    spawnGroup(world, {
      id: "blue",
      faction: "BLUFOR",
      template: "squad",
      position: [100, 0, 100],
    });
    spawnGroup(world, { id: "red", faction: "OPFOR", template: "squad", position: [200, 0, 100] });
    stepWorldMany(world, 10);
    upsertObjective(world, {
      id: "alpha",
      name: "Alpha",
      position: [100, 0, 100],
      status: "neutral",
      capture_progress: 0,
    });
    stepWorldMany(world, 100);
    const blueProgress = world.objectives.alpha?.capture_progress ?? 0;
    expect(blueProgress).toBeGreaterThan(0);

    const red = world.groups.red;
    if (!red) throw new Error("red group missing");
    red.position = [100, 0, 100];
    stepWorldMany(world, 100);
    expect(world.objectives.alpha).toMatchObject({
      status: "contested",
      capture_progress: blueProgress,
      capturingFaction: "BLUFOR",
    });

    const blue = world.groups.blue;
    if (!blue) throw new Error("blue group missing");
    blue.position = [200, 0, 100];
    stepWorldMany(world, 1);
    expect(world.objectives.alpha).toMatchObject({
      status: "contested",
      capturingFaction: "OPFOR",
    });
    expect(world.objectives.alpha?.capture_progress ?? 1).toBeLessThan(blueProgress);
  });

  it("keeps -256 terrain cells out of commander briefing samples", () => {
    const world = createWorld({ seed: 5, terrainWidth: 32, terrainHeight: 32 });
    expect(world.terrain.samples).toContain(-256);
    expect(terrainBriefingSamples(world.terrain)).not.toContain(-256);
  });
});

describe("validated command execution", () => {
  it("preserves spawn behavior and a validated objective target as metadata", () => {
    const world = createWorld({ seed: 21 });
    executeCommand(world, {
      command_id: "objective-create",
      type: "set_objective",
      params: {
        objective_id: "bravo",
        action: "create",
        position: [100, 0, 100],
        status: "enemy",
      },
    });
    executeCommand(
      world,
      {
        command_id: "spawn",
        type: "spawn_group",
        params: {
          template: "infantry_squad",
          position: [0, 0, 0],
          faction: "OPFOR",
          behavior: "flank_left",
          target_objective: "bravo",
        },
      },
      "BLUFOR",
    );

    expect(world.groups.grp_001).toMatchObject({
      faction: "OPFOR",
      behavior: "flank_left",
      targetObjectiveId: "bravo",
    });
    expect(world.groups.grp_001?.order).toBeUndefined();

    const groupIds = Object.keys(world.groups);
    const nextGroupId = world.nextGroupId;
    expect(() =>
      executeCommand(world, {
        command_id: "bad-spawn",
        type: "spawn_group",
        params: {
          template: "infantry_squad",
          position: [0, 0, 0],
          target_objective: "missing",
        },
      }),
    ).toThrow("Unknown objective missing");
    expect(Object.keys(world.groups)).toEqual(groupIds);
    expect(world.nextGroupId).toBe(nextGroupId);
  });

  it("handles objective create, update, assign, and remove as distinct actions", () => {
    const world = createWorld({ seed: 22 });
    spawnGroup(world, { id: "blue", faction: "BLUFOR", template: "squad", position: [0, 0, 0] });
    executeCommand(world, {
      command_id: "create",
      type: "set_objective",
      params: {
        objective_id: "alpha",
        action: "create",
        position: [20, 0, 40],
      },
    });
    expect(world.objectives.alpha).toEqual({
      id: "alpha",
      name: "alpha",
      position: [20, 0, 40],
      status: "neutral",
      capture_progress: 0,
    });

    executeCommand(world, {
      command_id: "update",
      type: "set_objective",
      params: { objective_id: "alpha", action: "update", status: "contested" },
    });
    expect(world.objectives.alpha).toMatchObject({
      position: [20, 0, 40],
      status: "contested",
    });

    executeCommand(world, {
      command_id: "assign",
      type: "set_objective",
      params: { objective_id: "alpha", action: "assign", assignee_group_id: "blue" },
    });
    expect(world.groups.blue).toMatchObject({ targetObjectiveId: "alpha" });
    expect(world.groups.blue?.order).toBeUndefined();

    executeCommand(world, {
      command_id: "remove",
      type: "set_objective",
      params: { objective_id: "alpha", action: "remove" },
    });
    expect(world.objectives.alpha).toBeUndefined();
    expect(world.groups.blue?.targetObjectiveId).toBeUndefined();
  });

  it("rejects invalid objective action inputs before mutation", () => {
    const world = createWorld({ seed: 23 });
    spawnGroup(world, { id: "blue", faction: "BLUFOR", template: "squad", position: [0, 0, 0] });
    const create = {
      command_id: "create",
      type: "set_objective" as const,
      params: {
        objective_id: "alpha",
        action: "create" as const,
        position: [20, 0, 40] as const,
      },
    };
    executeCommand(world, create);

    expect(() => executeCommand(world, create)).toThrow("already exists");
    expect(() =>
      executeCommand(world, {
        command_id: "missing-update",
        type: "set_objective",
        params: { objective_id: "missing", action: "update", status: "friendly" },
      }),
    ).toThrow("Unknown objective missing");
    expect(() =>
      executeCommand(world, {
        command_id: "missing-assignee",
        type: "set_objective",
        params: { objective_id: "alpha", action: "assign" },
      } as unknown as Parameters<typeof executeCommand>[1]),
    ).toThrow("assignee is required");
    expect(() =>
      executeCommand(world, {
        command_id: "bad-status",
        type: "set_objective",
        params: { objective_id: "alpha", action: "update", status: "captured" },
      } as unknown as Parameters<typeof executeCommand>[1]),
    ).toThrow("Unsupported objective status captured");
    expect(world.objectives.alpha).toEqual({
      id: "alpha",
      name: "alpha",
      position: [20, 0, 40],
      status: "neutral",
      capture_progress: 0,
    });
  });

  it("keeps patrols inside their fixed radius and replay deterministic", () => {
    const world = createWorld({ seed: 24 });
    spawnGroup(world, {
      id: "patrol",
      faction: "BLUFOR",
      template: "squad",
      position: [50, 0, 50],
    });
    stepWorldMany(world, 10);
    executeCommand(world, {
      command_id: "patrol",
      type: "patrol_group",
      params: { group_id: "patrol", position: [50, 0, 50], radius: 20 },
    });

    for (let index = 0; index < 2_000; index += 1) {
      stepWorld(world);
      const group = world.groups.patrol;
      if (!group) throw new Error("patrol group missing");
      expect(Math.hypot(group.position[0] - 50, group.position[2] - 50)).toBeLessThanOrEqual(20);
      expect(
        Math.hypot(
          (group.order?.destination[0] ?? 50) - 50,
          (group.order?.destination[2] ?? 50) - 50,
        ),
      ).toBeLessThanOrEqual(20);
    }

    const restored = restoreWorld(snapshotWorld(world));
    stepWorldMany(world, 500);
    stepWorldMany(restored, 500);
    expect(restored).toEqual(world);
  });

  it("keeps sweep distinct while advancing and engaging an encountered enemy", () => {
    const world = createWorld({ seed: 25 });
    spawnGroup(world, { id: "sweep", faction: "BLUFOR", template: "squad", position: [0, 0, 0] });
    spawnGroup(world, { id: "enemy", faction: "OPFOR", template: "squad", position: [100, 0, 0] });
    stepWorldMany(world, 10);
    executeCommand(world, {
      command_id: "sweep",
      type: "sweep_group",
      params: { group_id: "sweep", destination: [200, 0, 0] },
    });
    stepWorldMany(world, 120);

    expect(world.groups.sweep?.order?.kind).toBe("sweep");
    expect(world.groups.sweep?.position[0]).toBeGreaterThan(0);
    expect(world.groups.sweep?.status).toBe("engaged");
  });
});
