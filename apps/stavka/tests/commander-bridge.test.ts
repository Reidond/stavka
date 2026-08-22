import { describe, expect, it, vi } from "vitest";
import type { MapBriefing } from "@stavka/protocol";
import { createScenario, snapshotWorld } from "@stavka/sim-core";
import type { TickOutcome } from "@stavka/sim-link";

import {
  connectAndBriefCommander,
  mergeFactionCommandEffects,
  runCommanderTick,
} from "../src/commander-bridge";

describe("Poligon commander bridge", () => {
  it("connects before uploading the generated terrain briefing exactly once", async () => {
    const calls: string[] = [];
    const briefings: MapBriefing[] = [];
    const link = {
      connect: vi.fn(async () => {
        calls.push("connect");
      }),
      uploadMap: vi.fn(async (briefing: MapBriefing) => {
        calls.push("uploadMap");
        briefings.push(briefing);
      }),
    };

    await connectAndBriefCommander(link, createScenario("movement", 9), "Test Range");

    expect(calls).toEqual(["connect", "uploadMap"]);
    expect(link.connect).toHaveBeenCalledOnce();
    expect(link.uploadMap).toHaveBeenCalledOnce();
    expect(briefings[0]).toMatchObject({
      map_name: "Test Range",
      grid_resolution_meters: 10,
    });
    expect(briefings[0]?.terrain_grid.length).toBeGreaterThan(0);
  });

  it("respects tick hints in the hosted loop while forcing manual ticks", async () => {
    const world = createScenario("engagement", 12);
    const forcedOutcome = { request: { type: "full" } } as unknown as TickOutcome;
    const link = {
      tick: vi.fn(async () => forcedOutcome),
      tickIfDue: vi.fn(async () => undefined),
    };

    await expect(runCommanderTick(link, world, false)).resolves.toBeUndefined();
    expect(link.tickIfDue).toHaveBeenCalledWith(world);
    expect(link.tick).not.toHaveBeenCalled();

    await expect(runCommanderTick(link, world, true)).resolves.toBe(forcedOutcome);
    expect(link.tick).toHaveBeenCalledWith(world);
  });

  it("merges only the commander's faction changes into the shared world", () => {
    const world = createScenario("engagement", 12);
    const commandWorld = snapshotWorld(world);
    const originalBlue = [...(world.groups.blue_1?.position ?? [])];
    if (commandWorld.groups.red_1) commandWorld.groups.red_1.position = [111, 0, 0];
    if (commandWorld.groups.blue_1) commandWorld.groups.blue_1.position = [999, 0, 0];
    const outcome = {
      response: { commands: [] },
      commandResults: [],
    } as unknown as TickOutcome;

    mergeFactionCommandEffects(world, commandWorld, "OPFOR", outcome);

    expect(world.groups.red_1?.position).toEqual([111, 0, 0]);
    expect(world.groups.blue_1?.position).toEqual(originalBlue);
  });
});
