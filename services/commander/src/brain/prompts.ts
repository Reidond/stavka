import { doctrinePrompt, getDoctrine } from "@stavka/doctrine";
import type { GameSnapshot } from "@stavka/protocol";

import type { CommanderSessionState } from "../state/types";

export const commanderPrompt = (state: CommanderSessionState, trigger: string): string => {
  const doctrine = getDoctrine(state.doctrine);
  const mapBriefing = state.mapBriefing;
  const terrainCells = mapBriefing?.terrain_grid ?? [];
  const slopes = terrainCells.flatMap((cell) =>
    cell.slope_degrees === undefined ? [] : [cell.slope_degrees],
  );
  const terrain = mapBriefing
    ? {
        map: mapBriefing.map_name,
        provenance: {
          source: mapBriefing.source ?? "unknown",
          classificationVersion: mapBriefing.classification_version ?? null,
          contentHash: mapBriefing.content_hash ?? null,
        },
        gridDimensions: [
          mapBriefing.grid_width ?? mapBriefing.grid_size,
          mapBriefing.grid_height ?? mapBriefing.grid_size,
        ],
        gridResolutionMeters: mapBriefing.grid_resolution_meters,
        keyFeatures: mapBriefing.key_features.slice(0, 20).map((feature) => ({
          ...feature,
          positionMeters: [
            feature.grid[0] * mapBriefing.grid_resolution_meters,
            feature.grid[1] * mapBriefing.grid_resolution_meters,
          ],
        })),
        terrainSummary: Object.entries(
          terrainCells.reduce<Record<string, number>>((summary, cell) => {
            summary[cell.type] = (summary[cell.type] ?? 0) + 1;
            return summary;
          }, {}),
        ).sort(([left], [right]) => left.localeCompare(right)),
        coverSummary: Object.entries(
          terrainCells.reduce<Record<string, number>>((summary, cell) => {
            summary[cell.cover] = (summary[cell.cover] ?? 0) + 1;
            return summary;
          }, {}),
        ).sort(([left], [right]) => left.localeCompare(right)),
        mobility: {
          traversableCells: terrainCells.filter((cell) => cell.traversable).length,
          blockedCells: terrainCells.filter((cell) => !cell.traversable).length,
          averageSlopeDegrees:
            slopes.length === 0
              ? null
              : slopes.reduce((total, slope) => total + slope, 0) / slopes.length,
          maximumSlopeDegrees: slopes.length === 0 ? null : Math.max(...slopes),
        },
        traversableRoadCorridors: terrainCells
          .filter((cell) => cell.type === "road" && cell.traversable)
          .slice(0, 12)
          .map((cell) => cell.grid),
        defensibleCells: terrainCells
          .filter((cell) => cell.traversable && (cell.cover === "heavy" || cell.cover === "urban"))
          .sort((left, right) => right.elevation - left.elevation)
          .slice(0, 12)
          .map((cell) => ({
            grid: cell.grid,
            elevation: cell.elevation,
            cover: cell.cover,
            slopeDegrees: cell.slope_degrees ?? null,
          })),
      }
    : null;
  return [
    "You are Stavka, the strategic commander. Return only the requested structured decision.",
    doctrinePrompt(doctrine, state.difficulty.effective),
    `Trigger: ${trigger}.`,
    `Budget: ${state.budget.manpower.toFixed(1)} manpower, ${state.budget.vehiclePool} vehicles, hard cap ${state.budget.maxActiveUnits} groups.`,
    `Terrain briefing: ${JSON.stringify(terrain)}`,
    mapBriefing?.source === "simulator_synthetic"
      ? "Terrain provenance is simulator_synthetic: treat corridors and features as planning estimates, not observed ground truth."
      : "Terrain provenance is extracted or unknown; respect the supplied classification metadata.",
    "Never invent group IDs. Explicit orders are required for combat. Preserve fog of war: use only known_enemies and sergeant reports.",
    "Use chokepoints, cover, slope, and traversability when choosing routes and defensive positions.",
    `Working state: ${JSON.stringify(state.snapshot ?? null)}`,
    `Pending command ledger: ${JSON.stringify(state.pendingCommands.slice(-50))}`,
    `Short-term reports: ${JSON.stringify(state.memory.shortTerm.reports.slice(-20))}`,
    `Short-term events: ${JSON.stringify(state.memory.shortTerm.events.slice(-30))}`,
    `Compacted short-term observations: ${JSON.stringify(state.memory.shortTerm.summaries.slice(-50))}`,
    `Recent commander and sergeant summaries: ${JSON.stringify(state.memory.shortTerm.decisions.slice(-30))}`,
    `Recent command outcomes: ${JSON.stringify((state.memory.shortTerm.outcomes ?? []).slice(-30))}`,
  ].join("\n");
};

export const sergeantPrompt = (
  groupId: string,
  report: unknown,
  snapshot: GameSnapshot | undefined,
): string =>
  [
    `You are the tactical sergeant for group ${groupId}.`,
    "Return zero or more validated orders for this group only. Do not command other groups or spawn units.",
    `Report: ${JSON.stringify(report)}`,
    `Authorized local context: ${JSON.stringify(snapshot ?? null)}`,
  ].join("\n");
