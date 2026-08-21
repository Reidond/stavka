import { describe, expect, it } from "vitest";
import { createScenario, stepWorldMany } from "@stavka/sim-core";

describe("Poligon hosted stepping contract", () => {
  it("batches 10 fixed steps per simulated second", () => {
    const world = createScenario("movement", 9);
    const before = world.timeMs;
    stepWorldMany(world, 10 * 100);
    expect(world.timeMs - before).toBe(100_000);
    expect(world.groups.blue_1?.position[0]).toBeGreaterThan(180);
  });
});
