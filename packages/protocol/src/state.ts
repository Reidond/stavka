import { Schema } from "effect";

import { Vector3 } from "./commands";

const NonEmptyString = Schema.String.pipe(Schema.check(Schema.isTrimmed(), Schema.isNonEmpty()));
const FiniteNumber = Schema.Number.pipe(Schema.check(Schema.isFinite()));
const NonNegativeFinite = FiniteNumber.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(0)));
const Natural = NonNegativeFinite.pipe(Schema.check(Schema.isInt()));

export const Strength = Schema.Struct({ current: Natural, max: Natural }).check(
  Schema.makeFilter((strength) =>
    strength.current <= strength.max
      ? undefined
      : { path: ["current"], issue: "current strength cannot exceed maximum strength" },
  ),
);
export type Strength = typeof Strength.Type;

export const MissionState = Schema.Struct({
  id: NonEmptyString,
  epoch: Natural,
  name: NonEmptyString,
  map: NonEmptyString,
  time_elapsed_seconds: NonNegativeFinite,
  player_count: Schema.Struct({ friendly: Natural, enemy: Natural }),
});
export type MissionState = typeof MissionState.Type;

export const ObjectiveState = Schema.Struct({
  id: NonEmptyString,
  name: NonEmptyString,
  position: Vector3,
  status: Schema.Literals(["friendly", "enemy", "neutral", "contested"]),
  capture_progress: NonNegativeFinite.pipe(Schema.check(Schema.isLessThanOrEqualTo(1))),
});
export type ObjectiveState = typeof ObjectiveState.Type;

export const GroupStatus = Schema.Literals([
  "initializing",
  "idle",
  "moving",
  "engaged",
  "defending",
  "patrolling",
  "boarding",
  "mounted",
  "dismounting",
]);
export type GroupStatus = typeof GroupStatus.Type;

export const FriendlyGroupState = Schema.Struct({
  id: NonEmptyString,
  faction: NonEmptyString,
  template: NonEmptyString,
  position: Vector3,
  strength: Strength,
  behavior: NonEmptyString,
  status: GroupStatus,
  last_sitrep: Schema.optional(NonEmptyString),
  mounted_vehicle_id: Schema.optional(NonEmptyString),
});
export type FriendlyGroupState = typeof FriendlyGroupState.Type;

export const KnownEnemyState = Schema.Struct({
  id: NonEmptyString,
  reported_by: NonEmptyString,
  type: Schema.Literals(["infantry", "vehicle", "unknown"]),
  estimated_count: Natural,
  last_known_position: Vector3,
  confidence: Schema.Literals(["confirmed", "probable", "possible", "stale"]),
  age_seconds: NonNegativeFinite,
});
export type KnownEnemyState = typeof KnownEnemyState.Type;

export const ResourceState = Schema.Struct({
  manpower: NonNegativeFinite,
  vehicle_pool: Natural,
  reinforcement_cooldown_seconds: NonNegativeFinite,
  max_active_units: Natural,
});
export type ResourceState = typeof ResourceState.Type;

const duplicateEntityIdIssues = (
  items: ReadonlyArray<{ readonly id: string }>,
  collection: string,
): Schema.FilterIssue[] => {
  const issues: Schema.FilterIssue[] = [];
  const ids = new Set<string>();
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index];
    if (!item) continue;
    if (ids.has(item.id)) {
      issues.push({
        path: [collection, index, "id"],
        issue: `entity ids must be unique within ${collection}`,
      });
    }
    ids.add(item.id);
  }
  return issues;
};

const duplicateStringIdIssues = (
  ids: ReadonlyArray<string>,
  collection: string,
): Schema.FilterIssue[] => {
  const issues: Schema.FilterIssue[] = [];
  const seen = new Set<string>();
  for (let index = 0; index < ids.length; index += 1) {
    const id = ids[index];
    if (id === undefined) continue;
    if (seen.has(id)) {
      issues.push({
        path: [collection, index],
        issue: `entity ids must be unique within ${collection}`,
      });
    }
    seen.add(id);
  }
  return issues;
};

const vectorEquals = (left: typeof Vector3.Type, right: typeof Vector3.Type): boolean =>
  left[0] === right[0] && left[1] === right[1] && left[2] === right[2];

export const GameSnapshot = Schema.Struct({
  mission: MissionState,
  objectives: Schema.Array(ObjectiveState),
  friendly_groups: Schema.Array(FriendlyGroupState),
  known_enemies: Schema.Array(KnownEnemyState),
  resources: ResourceState,
}).check(
  Schema.makeFilter((snapshot) => [
    ...duplicateEntityIdIssues(snapshot.objectives, "objectives"),
    ...duplicateEntityIdIssues(snapshot.friendly_groups, "friendly_groups"),
    ...duplicateEntityIdIssues(snapshot.known_enemies, "known_enemies"),
  ]),
);
export type GameSnapshot = typeof GameSnapshot.Type;

export const GroupMovement = Schema.Struct({ id: NonEmptyString, position: Vector3 });

export const StateDelta = Schema.Struct({
  mission: Schema.optional(MissionState),
  groups_upserted: Schema.Array(FriendlyGroupState),
  groups_moved: Schema.Array(GroupMovement),
  groups_destroyed: Schema.Array(NonEmptyString),
  objectives_upserted: Schema.Array(ObjectiveState),
  objectives_removed: Schema.optional(Schema.Array(NonEmptyString)),
  known_enemies_upserted: Schema.Array(KnownEnemyState),
  known_enemies_expired: Schema.Array(NonEmptyString),
  resources: Schema.optional(ResourceState),
}).check(
  Schema.makeFilter((delta) => {
    const issues: Schema.FilterIssue[] = [
      ...duplicateEntityIdIssues(delta.groups_upserted, "groups_upserted"),
      ...duplicateEntityIdIssues(delta.groups_moved, "groups_moved"),
      ...duplicateStringIdIssues(delta.groups_destroyed, "groups_destroyed"),
      ...duplicateEntityIdIssues(delta.objectives_upserted, "objectives_upserted"),
      ...duplicateStringIdIssues(delta.objectives_removed ?? [], "objectives_removed"),
      ...duplicateEntityIdIssues(delta.known_enemies_upserted, "known_enemies_upserted"),
      ...duplicateStringIdIssues(delta.known_enemies_expired, "known_enemies_expired"),
    ];

    const upsertedGroups = new Map(delta.groups_upserted.map((group) => [group.id, group]));
    const movedGroups = new Map(delta.groups_moved.map((movement) => [movement.id, movement]));
    for (let index = 0; index < delta.groups_moved.length; index += 1) {
      const movement = delta.groups_moved[index];
      if (!movement) continue;
      const upserted = upsertedGroups.get(movement.id);
      if (upserted !== undefined && !vectorEquals(upserted.position, movement.position)) {
        issues.push({
          path: ["groups_moved", index, "position"],
          issue: "group movement conflicts with the upserted position in the same delta",
        });
      }
    }

    for (let index = 0; index < delta.groups_destroyed.length; index += 1) {
      const groupId = delta.groups_destroyed[index];
      if (groupId === undefined) continue;
      if (upsertedGroups.has(groupId) || movedGroups.has(groupId)) {
        issues.push({
          path: ["groups_destroyed", index],
          issue: "destroyed group cannot also be upserted or moved in the same delta",
        });
      }
    }
    return issues;
  }),
);
export type StateDelta = typeof StateDelta.Type;

const MapGridCoordinate = Schema.Number.pipe(
  Schema.check(Schema.isFinite(), Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)),
);
const MapDimension = MapGridCoordinate.pipe(Schema.check(Schema.isGreaterThan(0)));
const MapResolution = Schema.Number.pipe(Schema.check(Schema.isFinite(), Schema.isGreaterThan(0)));
const MapElevation = Schema.Number.pipe(
  Schema.check(
    Schema.isFinite(),
    Schema.makeFilter((elevation) => elevation !== -256, {
      message: "-256 terrain sentinel must not be serialized",
    }),
  ),
);
const MapSlopeDegrees = Schema.Number.pipe(
  Schema.check(Schema.isFinite(), Schema.isBetween({ minimum: 0, maximum: 90 })),
);
const MapName = Schema.String.pipe(Schema.check(Schema.isTrimmed(), Schema.isNonEmpty()));
const MapGridPosition = Schema.Tuple([MapGridCoordinate, MapGridCoordinate]);

export const MapTerrainType = Schema.Literals(["forest", "road", "urban", "field", "water"]);
export type MapTerrainType = typeof MapTerrainType.Type;

export const MapCoverType = Schema.Literals(["none", "light", "heavy", "urban"]);
export type MapCoverType = typeof MapCoverType.Type;

export const MapFeatureType = Schema.Literals(["high_ground", "chokepoint", "settlement"]);
export type MapFeatureType = typeof MapFeatureType.Type;

export const MapBriefingSource = Schema.Literals(["simulator_synthetic", "arma_extracted"]);
export type MapBriefingSource = typeof MapBriefingSource.Type;

export const MapCell = Schema.Struct({
  grid: MapGridPosition,
  type: MapTerrainType,
  cover: MapCoverType,
  elevation: MapElevation,
  slope_degrees: Schema.optional(MapSlopeDegrees),
  traversable: Schema.Boolean,
});

export const MapKeyFeature = Schema.Struct({
  name: MapName,
  grid: MapGridPosition,
  type: MapFeatureType,
  elevation: Schema.optional(MapElevation),
});

export interface MapBriefingHashInput {
  readonly map_name: string;
  readonly grid_width: number;
  readonly grid_height: number;
  readonly grid_resolution_meters: number;
  readonly source: MapBriefingSource;
  readonly classification_version: number;
  readonly terrain_grid: ReadonlyArray<typeof MapCell.Type>;
  readonly key_features: ReadonlyArray<typeof MapKeyFeature.Type>;
}

const hashCanonicalMapContent = (content: string): string => {
  let primary = 0x811c_9dc5;
  let secondary = 0x9e37_79b9;
  for (let index = 0; index < content.length; index += 1) {
    const code = content.charCodeAt(index);
    primary = Math.imul(primary ^ code, 0x0100_0193) >>> 0;
    secondary = Math.imul(secondary ^ ((code + index) >>> 0), 0x5bd1_e995) >>> 0;
  }
  return `${primary.toString(16).padStart(8, "0")}${secondary.toString(16).padStart(8, "0")}`;
};

const compareMapText = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

/**
 * Stable cache identity for a complete classified map briefing. Cell and
 * feature order do not affect the digest; dimensions, classifier provenance,
 * and every planning field do.
 */
export const computeMapBriefingContentHash = (briefing: MapBriefingHashInput): string => {
  const cells = [...briefing.terrain_grid]
    .sort(
      (left, right) =>
        left.grid[1] - right.grid[1] ||
        left.grid[0] - right.grid[0] ||
        compareMapText(left.type, right.type),
    )
    .map((cell) => [
      cell.grid[0],
      cell.grid[1],
      cell.type,
      cell.cover,
      cell.elevation,
      cell.slope_degrees ?? null,
      cell.traversable,
    ]);
  const features = [...briefing.key_features]
    .sort(
      (left, right) =>
        left.grid[1] - right.grid[1] ||
        left.grid[0] - right.grid[0] ||
        compareMapText(left.type, right.type) ||
        compareMapText(left.name, right.name),
    )
    .map((feature) => [
      feature.grid[0],
      feature.grid[1],
      feature.type,
      feature.name,
      feature.elevation ?? null,
    ]);
  const canonical = JSON.stringify([
    "stavka-map-briefing-v1",
    briefing.map_name,
    briefing.grid_width,
    briefing.grid_height,
    briefing.grid_resolution_meters,
    briefing.source,
    briefing.classification_version,
    cells,
    features,
  ]);
  return `stavka-map-v1-${hashCanonicalMapContent(canonical)}`;
};

export const MapBriefing = Schema.Struct({
  map_name: MapName,
  grid_size: MapDimension,
  grid_width: MapDimension,
  grid_height: MapDimension,
  grid_resolution_meters: MapResolution,
  source: MapBriefingSource,
  classification_version: MapDimension,
  content_hash: MapName,
  terrain_grid: Schema.Array(MapCell),
  key_features: Schema.Array(MapKeyFeature),
}).check(
  Schema.makeFilter((briefing) => {
    const issues: Schema.FilterIssue[] = [];
    const gridWidth = briefing.grid_width;
    const gridHeight = briefing.grid_height;
    if (briefing.grid_size !== Math.max(gridWidth, gridHeight)) {
      issues.push({
        path: ["grid_size"],
        issue: "grid_size must equal the larger explicit grid dimension",
      });
    }
    const expectedHash = computeMapBriefingContentHash(briefing);
    if (briefing.content_hash !== expectedHash) {
      issues.push({
        path: ["content_hash"],
        issue: "content_hash does not match the canonical classified map briefing",
      });
    }
    const cells = new Set<string>();
    for (let index = 0; index < briefing.terrain_grid.length; index += 1) {
      const cell = briefing.terrain_grid[index];
      if (!cell) continue;
      if (cell.grid[0] >= gridWidth || cell.grid[1] >= gridHeight) {
        issues.push({
          path: ["terrain_grid", index, "grid"],
          issue: "terrain grid coordinate is outside grid_size",
        });
      }
      const key = `${cell.grid[0]}:${cell.grid[1]}`;
      if (cells.has(key)) {
        issues.push({
          path: ["terrain_grid", index, "grid"],
          issue: "terrain grid coordinate is duplicated",
        });
      }
      if (cell.type === "water" && (cell.cover !== "none" || cell.traversable)) {
        issues.push({
          path: ["terrain_grid", index],
          issue: "water cells must have no cover and be non-traversable",
        });
      }
      if (cell.cover === "urban" && cell.type !== "urban") {
        issues.push({
          path: ["terrain_grid", index, "cover"],
          issue: "urban cover is only valid for urban terrain",
        });
      }
      if (
        cell.type !== "road" &&
        cell.traversable &&
        cell.slope_degrees !== undefined &&
        cell.slope_degrees > 35
      ) {
        issues.push({
          path: ["terrain_grid", index, "traversable"],
          issue: "non-road cells above 35 degrees cannot be traversable",
        });
      }
      cells.add(key);
    }
    for (let index = 0; index < briefing.key_features.length; index += 1) {
      const feature = briefing.key_features[index];
      if (feature && (feature.grid[0] >= gridWidth || feature.grid[1] >= gridHeight)) {
        issues.push({
          path: ["key_features", index, "grid"],
          issue: "key feature coordinate is outside grid_size",
        });
      } else if (feature && !cells.has(`${feature.grid[0]}:${feature.grid[1]}`)) {
        issues.push({
          path: ["key_features", index, "grid"],
          issue: "key feature must reference a serialized terrain cell",
        });
      }
    }
    const featureLocations = new Set<string>();
    for (let index = 0; index < briefing.key_features.length; index += 1) {
      const feature = briefing.key_features[index];
      if (!feature) continue;
      const key = `${feature.grid[0]}:${feature.grid[1]}`;
      if (featureLocations.has(key)) {
        issues.push({
          path: ["key_features", index, "grid"],
          issue: "key feature coordinate is duplicated",
        });
      }
      featureLocations.add(key);
    }
    return issues;
  }),
);
export type MapBriefing = typeof MapBriefing.Type;

export const decodeMapBriefing = Schema.decodeUnknownSync(MapBriefing, {
  onExcessProperty: "error",
});
