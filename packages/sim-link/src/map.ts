import { computeMapBriefingContentHash, type MapBriefing } from "@stavka/protocol";
import { MAX_TRAVERSABLE_SLOPE_DEGREES, type SimWorldState } from "@stavka/sim-core";

type MapCell = MapBriefing["terrain_grid"][number];
type KeyFeature = MapBriefing["key_features"][number];

export const SIMULATOR_TERRAIN_CLASSIFICATION_VERSION = 1 as const;

const coordinateNoise = (seed: number, x: number, z: number): number => {
  let value = (seed ^ Math.imul(x + 1, 0x9e37_79b1) ^ Math.imul(z + 1, 0x85eb_ca77)) >>> 0;
  value ^= value >>> 16;
  value = Math.imul(value, 0x7feb_352d) >>> 0;
  value ^= value >>> 15;
  value = Math.imul(value, 0x846c_a68b) >>> 0;
  value ^= value >>> 16;
  return (value >>> 0) / 0x1_0000_0000;
};

const terrainElevation = (world: SimWorldState, x: number, z: number): number | undefined => {
  if (x < 0 || z < 0 || x >= world.terrain.width || z >= world.terrain.height) {
    return undefined;
  }
  const elevation = world.terrain.samples[z * world.terrain.width + x];
  return elevation === undefined || elevation === -256 ? undefined : elevation;
};

const localSlope = (world: SimWorldState, x: number, z: number, elevation: number): number => {
  const neighbors = [
    terrainElevation(world, x - 1, z),
    terrainElevation(world, x + 1, z),
    terrainElevation(world, x, z - 1),
    terrainElevation(world, x, z + 1),
  ].filter((value): value is number => value !== undefined);
  return neighbors.reduce(
    (steepest, neighbor) =>
      Math.max(steepest, Math.abs(elevation - neighbor) / world.terrain.cellSizeMeters),
    0,
  );
};

const classifyCell = (
  world: SimWorldState,
  x: number,
  z: number,
  elevation: number,
  water: boolean,
  settlement: readonly [number, number],
  settlementRadius: number,
): MapCell => {
  const [settlementX, settlementZ] = settlement;
  const distanceToSettlement = Math.hypot(x - settlementX, z - settlementZ);
  const urban = !water && distanceToSettlement <= settlementRadius;
  const road = !water && !urban && (x === settlementX || z === settlementZ);
  const vegetation = coordinateNoise(world.seed, x, z);
  const forest = !water && !urban && !road && vegetation < 0.34;
  const type: MapCell["type"] = water
    ? "water"
    : urban
      ? "urban"
      : road
        ? "road"
        : forest
          ? "forest"
          : "field";
  const cover: MapCell["cover"] = urban
    ? "urban"
    : forest
      ? vegetation < 0.17
        ? "heavy"
        : "light"
      : "none";
  const slope = localSlope(world, x, z, elevation);
  const exactSlopeDegrees = (Math.atan(slope) * 180) / Math.PI;
  const slopeDegrees = Math.round(exactSlopeDegrees * 10) / 10;
  return {
    grid: [x, z],
    type,
    cover,
    elevation,
    slope_degrees: slopeDegrees,
    traversable: !water && exactSlopeDegrees <= MAX_TRAVERSABLE_SLOPE_DEGREES,
  };
};

const featureAt = (name: string, type: KeyFeature["type"], cell: MapCell): KeyFeature => ({
  name,
  grid: cell.grid,
  type,
  elevation: cell.elevation,
});

/**
 * Builds deterministic simulator terrain metadata. These classifications are
 * synthetic planning cues; real Arma terrain extraction remains a separate gate.
 */
export const createMapBriefing = (
  world: SimWorldState,
  mapName = "Poligon Procedural",
): MapBriefing => {
  const settlementRadius = Math.max(
    1,
    Math.floor(Math.min(world.terrain.width, world.terrain.height) / 12),
  );
  const settlement: readonly [number, number] = [
    Math.floor(world.terrain.width / 2),
    Math.floor(world.terrain.height / 2),
  ];
  const terrain_grid: MapCell[] = [];

  for (let z = 0; z < world.terrain.height; z += 1) {
    for (let x = 0; x < world.terrain.width; x += 1) {
      const elevation = terrainElevation(world, x, z);
      if (elevation === undefined) continue;
      terrain_grid.push(classifyCell(world, x, z, elevation, false, settlement, settlementRadius));
    }
  }

  const highest = terrain_grid.reduce<MapCell | undefined>(
    (current, cell) =>
      current === undefined || cell.elevation > current.elevation ? cell : current,
    undefined,
  );
  const settlementCell = terrain_grid
    .filter((cell) => cell.type === "urban")
    .filter(
      (cell) =>
        highest === undefined ||
        cell.grid[0] !== highest.grid[0] ||
        cell.grid[1] !== highest.grid[1],
    )
    .sort((left, right) => {
      const leftDistance = Math.hypot(left.grid[0] - settlement[0], left.grid[1] - settlement[1]);
      const rightDistance = Math.hypot(
        right.grid[0] - settlement[0],
        right.grid[1] - settlement[1],
      );
      return (
        Number(right.traversable) - Number(left.traversable) ||
        leftDistance - rightDistance ||
        left.grid[1] - right.grid[1] ||
        left.grid[0] - right.grid[0]
      );
    })[0];
  const cellsByGrid = new Map(
    terrain_grid.map((cell) => [`${cell.grid[0]}:${cell.grid[1]}`, cell]),
  );
  const usedFeatureLocations = new Set(
    [highest, settlementCell]
      .filter((cell): cell is MapCell => cell !== undefined)
      .map((cell) => `${cell.grid[0]}:${cell.grid[1]}`),
  );
  const chokepoint = terrain_grid
    .filter(
      (cell) =>
        cell.traversable &&
        !usedFeatureLocations.has(`${cell.grid[0]}:${cell.grid[1]}`) &&
        cell.grid[0] > 0 &&
        cell.grid[1] > 0 &&
        cell.grid[0] < world.terrain.width - 1 &&
        cell.grid[1] < world.terrain.height - 1,
    )
    .map((cell) => {
      const neighbors = [
        cellsByGrid.get(`${cell.grid[0] - 1}:${cell.grid[1]}`),
        cellsByGrid.get(`${cell.grid[0] + 1}:${cell.grid[1]}`),
        cellsByGrid.get(`${cell.grid[0]}:${cell.grid[1] - 1}`),
        cellsByGrid.get(`${cell.grid[0]}:${cell.grid[1] + 1}`),
      ];
      const restriction = neighbors.reduce(
        (score, neighbor) =>
          score +
          (neighbor === undefined || !neighbor.traversable
            ? 2
            : neighbor.cover === "heavy" || neighbor.cover === "urban"
              ? 1
              : 0),
        0,
      );
      const restricted = (neighbor: MapCell | undefined): boolean =>
        neighbor === undefined ||
        !neighbor.traversable ||
        neighbor.cover === "heavy" ||
        neighbor.cover === "urban";
      return {
        cell,
        restriction,
        isChokepoint:
          ([neighbors[2], neighbors[3]].every((neighbor) => neighbor?.traversable === true) &&
            [neighbors[0], neighbors[1]].every(restricted)) ||
          ([neighbors[0], neighbors[1]].every((neighbor) => neighbor?.traversable === true) &&
            [neighbors[2], neighbors[3]].every(restricted)),
      };
    })
    .filter((candidate) => candidate.isChokepoint)
    .sort(
      (left, right) =>
        right.restriction - left.restriction ||
        left.cell.grid[1] - right.cell.grid[1] ||
        left.cell.grid[0] - right.cell.grid[0],
    )[0]?.cell;
  const key_features: KeyFeature[] = [];
  if (highest) key_features.push(featureAt("Highest point", "high_ground", highest));
  if (settlementCell)
    key_features.push(featureAt("Central settlement", "settlement", settlementCell));
  if (chokepoint) key_features.push(featureAt("Restricted approach", "chokepoint", chokepoint));

  const briefing: Omit<MapBriefing, "content_hash"> = {
    map_name: mapName,
    grid_size: Math.max(world.terrain.width, world.terrain.height),
    grid_width: world.terrain.width,
    grid_height: world.terrain.height,
    grid_resolution_meters: world.terrain.cellSizeMeters,
    source: "simulator_synthetic",
    classification_version: SIMULATOR_TERRAIN_CLASSIFICATION_VERSION,
    terrain_grid,
    key_features,
  };
  return {
    ...briefing,
    content_hash: computeMapBriefingContentHash(briefing),
  };
};
