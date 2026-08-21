import { describe, expect, it } from "vitest";

import { commanderPrompt } from "../src/brain/prompts";
import { initialCommanderState } from "../src/state/types";

describe("terrain-aware commander context", () => {
  it("summarizes cover and key features without embedding the full terrain grid", () => {
    const state = {
      ...initialCommanderState(),
      mapBriefing: {
        map_name: "Everon",
        grid_size: 2,
        grid_width: 2,
        grid_height: 2,
        grid_resolution_meters: 10,
        source: "simulator_synthetic" as const,
        classification_version: 7,
        content_hash: "sha256:test-map",
        terrain_grid: [
          {
            grid: [0, 0] as const,
            type: "forest" as const,
            cover: "heavy" as const,
            elevation: 12,
            slope_degrees: 20,
            traversable: true,
          },
          {
            grid: [1, 0] as const,
            type: "road" as const,
            cover: "none" as const,
            elevation: 11,
            slope_degrees: 4,
            traversable: false,
          },
          {
            grid: [0, 1] as const,
            type: "road" as const,
            cover: "none" as const,
            elevation: 10,
            traversable: true,
          },
        ],
        key_features: [
          { name: "Hill 12", grid: [0, 0] as const, type: "high_ground" as const, elevation: 12 },
        ],
      },
    };
    const prompt = commanderPrompt(state, "scheduled_tick");
    expect(prompt).toContain("Everon");
    expect(prompt).toContain("Hill 12");
    expect(prompt).toContain('["heavy",1]');
    expect(prompt).toContain('"blockedCells":1');
    expect(prompt).toContain('"averageSlopeDegrees":12');
    expect(prompt).toContain('"source":"simulator_synthetic"');
    expect(prompt).toContain('"classificationVersion":7');
    expect(prompt).toContain('"contentHash":"sha256:test-map"');
    expect(prompt).toContain('"traversableRoadCorridors":[[0,1]]');
    expect(prompt).toContain("planning estimates, not observed ground truth");
    expect(prompt).not.toContain('"terrain_grid"');
  });
});
