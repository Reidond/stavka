import type { TerrainGrid } from "./types";
import { nextRandom } from "./prng";

export const hashTerrainSamples = (
  samples: readonly number[],
  width: number,
  height: number,
  cellSizeMeters: number,
): string => {
  const canonical = JSON.stringify([2, width, height, cellSizeMeters, samples]);
  let primary = 0x811c_9dc5;
  let secondary = 0x9e37_79b9;
  for (let index = 0; index < canonical.length; index += 1) {
    const code = canonical.charCodeAt(index);
    primary = Math.imul(primary ^ code, 0x0100_0193) >>> 0;
    secondary = Math.imul(secondary ^ ((code + index) >>> 0), 0x5bd1_e995) >>> 0;
  }
  return `terrain-v2-${width}x${height}x${cellSizeMeters}-${primary
    .toString(16)
    .padStart(8, "0")}${secondary.toString(16).padStart(8, "0")}`;
};

export const createTerrain = (seed: number, width = 64, height = 64): TerrainGrid => {
  const samples: number[] = [];
  let state = seed >>> 0;
  for (let z = 0; z < height; z += 1) {
    for (let x = 0; x < width; x += 1) {
      const [noise, next] = nextRandom(state);
      state = next;
      const nx = x / Math.max(1, width - 1) - 0.5;
      const nz = z / Math.max(1, height - 1) - 0.5;
      const island = 1 - Math.min(1, Math.sqrt(nx * nx + nz * nz) * 1.8);
      const elevation = island < 0.08 ? -256 : Math.round((island * 180 + noise * 12) * 10) / 10;
      samples.push(elevation);
    }
  }
  return {
    width,
    height,
    cellSizeMeters: 10,
    samples,
    contentHash: hashTerrainSamples(samples, width, height, 10),
  };
};

export const terrainBriefingSamples = (terrain: TerrainGrid): number[] =>
  terrain.samples.filter((sample) => sample !== -256);
