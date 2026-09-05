import type {
  CommanderCostAggregate,
  CommandResult,
  DecisionLogEntry,
  GameSnapshot,
  SessionExport,
} from "@stavka/protocol";
import { Button } from "@cloudflare/kumo/components/button";
import { LayerCard } from "@cloudflare/kumo/components/layer-card";
import type { ColumnDef } from "@tanstack/react-table";
import { useEffect, useRef, useState } from "react";

import {
  PoligonDataTable,
  PoligonFigure,
  PoligonLogFeed,
  poligonVisualizationPalette,
} from "./poligon-ui";
import { reconstructReplayFrames, type ReplayFrame } from "../replay-state";

export interface ReplayTimelineEntry {
  readonly id: string;
  readonly timestamp: string;
  readonly cause: string;
  readonly decision: string;
  readonly commands: readonly string[];
  readonly outcomes: readonly string[];
}

export type ReplayCostRow = CommanderCostAggregate & {
  readonly key: string;
  readonly sessionId: string;
  readonly faction: string;
};

export interface ReplayTacticalMarker {
  readonly key: string;
  readonly kind: "friendly" | "objective" | "known_enemy";
  readonly label: string;
  readonly x: number;
  readonly z: number;
  readonly detail: string;
}

export const projectReplayTacticalMarkers = (
  snapshot: GameSnapshot,
): readonly ReplayTacticalMarker[] => [
  ...snapshot.friendly_groups.map((group) => ({
    key: `friendly:${group.id}`,
    kind: "friendly" as const,
    label: group.id,
    x: group.position[0],
    z: group.position[2],
    detail: `${group.status} · ${group.strength.current}/${group.strength.max}`,
  })),
  ...snapshot.objectives.map((objective) => ({
    key: `objective:${objective.id}`,
    kind: "objective" as const,
    label: objective.name,
    x: objective.position[0],
    z: objective.position[2],
    detail: `${objective.status} · ${Math.round(objective.capture_progress * 100)}%`,
  })),
  ...snapshot.known_enemies.map((enemy) => ({
    key: `known-enemy:${enemy.id}`,
    kind: "known_enemy" as const,
    label: enemy.id,
    x: enemy.last_known_position[0],
    z: enemy.last_known_position[2],
    detail: `${enemy.confidence} · ${enemy.age_seconds.toFixed(0)}s old`,
  })),
];

const markerColor = (kind: ReplayTacticalMarker["kind"]): string =>
  kind === "friendly"
    ? poligonVisualizationPalette.friendly
    : kind === "known_enemy"
      ? poligonVisualizationPalette.hostile
      : poligonVisualizationPalette.objective;

const ReplayTacticalState = ({ frame }: { readonly frame: ReplayFrame }) => {
  const map = useRef<SVGSVGElement>(null);
  const [mapWidth, setMapWidth] = useState(600);
  useEffect(() => {
    if (!map.current) return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setMapWidth(entry.contentRect.width);
    });
    observer.observe(map.current);
    return () => observer.disconnect();
  }, []);
  const labelSize = 13 / Math.max(0.1, Math.min(mapWidth / 600, 1));
  const markers = projectReplayTacticalMarkers(frame.snapshot);
  const xValues = markers.map((marker) => marker.x);
  const zValues = markers.map((marker) => marker.z);
  const minimumX = Math.min(...xValues, 0);
  const maximumX = Math.max(...xValues, 1);
  const minimumZ = Math.min(...zValues, 0);
  const maximumZ = Math.max(...zValues, 1);
  const span = Math.max(100, maximumX - minimumX, maximumZ - minimumZ);
  const projectX = (value: number): number =>
    300 + ((value - (minimumX + maximumX) / 2) / span) * 250;
  const projectZ = (value: number): number =>
    170 - ((value - (minimumZ + maximumZ) / 2) / span) * 250;

  return (
    <div className="grid gap-3 lg:grid-cols-[minmax(0,2fr)_minmax(16rem,1fr)]">
      <svg
        ref={map}
        viewBox="0 0 600 340"
        role="img"
        aria-label={`Reconstructed tactical state at tick ${frame.tickId}`}
        className="stavka-replay-map"
      >
        <title>{`Tick ${frame.tickId} reconstructed friendly, objective, and known-enemy positions`}</title>
        <defs>
          <pattern id="replay-grid" width="30" height="30" patternUnits="userSpaceOnUse">
            <path d="M 30 0 H 0 V 30" fill="none" stroke="#33475d" strokeWidth="0.6" />
          </pattern>
        </defs>
        <rect width="600" height="340" fill="url(#replay-grid)" />
        {markers.map((marker) => {
          const x = projectX(marker.x);
          const y = projectZ(marker.z);
          const color = markerColor(marker.kind);
          return (
            <g key={marker.key} data-marker={marker.key}>
              <title>{`${marker.label} · X ${marker.x.toFixed(0)} · Z ${marker.z.toFixed(0)} · ${marker.detail}`}</title>
              {marker.kind === "objective" ? (
                <rect x={x - 9} y={y - 9} width={18} height={18} fill={color} />
              ) : marker.kind === "known_enemy" ? (
                <path
                  d={`M ${x} ${y - 11} L ${x + 11} ${y + 9} L ${x - 11} ${y + 9} Z`}
                  fill={color}
                />
              ) : (
                <circle cx={x} cy={y} r={9} fill={color} />
              )}
              <text x={x} y={y + 30} textAnchor="middle" fill="#e2e8f0" fontSize={labelSize}>
                {marker.label}
              </text>
            </g>
          );
        })}
      </svg>
      <div className="space-y-3">
        <div className="grid grid-cols-2 gap-2 text-xs">
          <span>Mission time</span>
          <strong>{frame.snapshot.mission.time_elapsed_seconds.toFixed(1)}s</strong>
          <span>Friendly groups</span>
          <strong>{frame.snapshot.friendly_groups.length}</strong>
          <span>Known enemies</span>
          <strong>{frame.snapshot.known_enemies.length}</strong>
          <span>Objectives</span>
          <strong>{frame.snapshot.objectives.length}</strong>
          <span>Manpower</span>
          <strong>{frame.snapshot.resources.manpower}</strong>
        </div>
        <ul aria-label="Selected replay state entities" className="m-0 space-y-1 p-0 text-xs">
          {markers.map((marker) => (
            <li key={marker.key} className="list-none border-t border-kumo-hairline pt-1">
              <strong>{marker.label}</strong> · X {marker.x.toFixed(0)} · Z {marker.z.toFixed(0)} ·{" "}
              {marker.detail}
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
};

const ReplayStateProgression = ({ frames }: { readonly frames: readonly ReplayFrame[] }) => {
  const [selectedIndex, setSelectedIndex] = useState(Math.max(0, frames.length - 1));
  const frame = frames[selectedIndex] ?? frames.at(-1);
  if (!frame) {
    return (
      <PoligonFigure caption="No canonical full snapshot was archived">
        <p className="m-0 p-4 text-sm">No replay state frames are available.</p>
      </PoligonFigure>
    );
  }

  return (
    <PoligonFigure
      caption={`Tick ${frame.tickId} · ${frame.kind} · ${frame.source} state · ${selectedIndex + 1}/${frames.length}`}
    >
      <section className="space-y-3 p-3" aria-label="Reconstructed replay world progression">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex flex-wrap gap-2">
            <span>{frame.kind}</span>
            <span>{frame.source}</span>
            <span>{frame.events.length} events</span>
            <span>{frame.commandResults.length} results</span>
          </div>
          <div className="flex gap-2">
            <Button
              size="sm"
              disabled={selectedIndex === 0}
              onClick={() => setSelectedIndex((current) => Math.max(0, current - 1))}
            >
              Previous state
            </Button>
            <Button
              size="sm"
              disabled={selectedIndex >= frames.length - 1}
              onClick={() =>
                setSelectedIndex((current) => Math.min(frames.length - 1, current + 1))
              }
            >
              Next state
            </Button>
          </div>
        </div>
        <ReplayTacticalState frame={frame} />
      </section>
    </PoligonFigure>
  );
};

const integerFormat = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });
const formatInteger = (value: number): string => integerFormat.format(value);
const formatCost = (value: number): string => `$${value.toFixed(4)}`;

const formatOutcome = (result: CommandResult): string =>
  `${result.command_id} · ${result.status}${result.reason ? ` · ${result.reason}` : ""}`;

export const buildReplayTimeline = (replay: SessionExport): readonly ReplayTimelineEntry[] => {
  const outcomes = new Map<string, CommandResult[]>();
  for (const tick of replay.archive.ticks) {
    for (const result of tick.request.command_results) {
      const current = outcomes.get(result.command_id) ?? [];
      outcomes.set(result.command_id, [...current, result]);
    }
  }

  return replay.logs.map((log: DecisionLogEntry) => {
    const parsedIds = new Set(log.output.parsedCommands.map((command) => command.command_id));
    const commandIds = [...parsedIds, ...log.commandsIssued.filter((id) => !parsedIds.has(id))];
    return {
      id: log.id,
      timestamp: log.timestamp,
      cause: `${log.trigger} · ${log.input.events.length} input event(s)`,
      decision: log.output.summary,
      commands: [
        ...log.output.parsedCommands.map((command) => `${command.command_id} · ${command.type}`),
        ...log.commandsIssued.filter((id) => !parsedIds.has(id)).map((id) => `${id} · issued`),
      ],
      outcomes: commandIds.flatMap((id) => (outcomes.get(id) ?? []).map(formatOutcome)),
    };
  });
};

export const aggregateReplayCosts = (replay: SessionExport): readonly ReplayCostRow[] => {
  const grouped = new Map<string, ReplayCostRow>();
  for (const aggregate of replay.cost_aggregates) {
    const key = JSON.stringify([
      replay.session.session_id,
      replay.session.faction,
      aggregate.agent_tier,
      aggregate.model,
    ]);
    const current = grouped.get(key);
    grouped.set(key, {
      key,
      sessionId: replay.session.session_id,
      faction: replay.session.faction,
      agent_tier: aggregate.agent_tier,
      model: aggregate.model,
      calls: (current?.calls ?? 0) + aggregate.calls,
      input_tokens: (current?.input_tokens ?? 0) + aggregate.input_tokens,
      output_tokens: (current?.output_tokens ?? 0) + aggregate.output_tokens,
      cost_usd: (current?.cost_usd ?? 0) + aggregate.cost_usd,
    });
  }
  return [...grouped.values()].sort(
    (left, right) =>
      left.sessionId.localeCompare(right.sessionId) ||
      left.faction.localeCompare(right.faction) ||
      left.agent_tier.localeCompare(right.agent_tier) ||
      left.model.localeCompare(right.model),
  );
};

const costColumns: ColumnDef<ReplayCostRow, unknown>[] = [
  { accessorKey: "sessionId", header: "Session" },
  {
    accessorKey: "faction",
    header: "Faction",
    cell: ({ row }) => <span>{row.original.faction}</span>,
  },
  {
    id: "agent",
    header: "Agent / model",
    cell: ({ row }) => (
      <div className="min-w-36">
        <span>{row.original.agent_tier}</span>
        <span className="mt-1 block text-xs text-kumo-subtle">{row.original.model}</span>
      </div>
    ),
  },
  {
    accessorKey: "calls",
    header: "Calls",
    cell: ({ row }) => <span>{formatInteger(row.original.calls)}</span>,
  },
  {
    id: "tokens",
    header: "Tokens",
    cell: ({ row }) => (
      <span>
        {formatInteger(row.original.input_tokens + row.original.output_tokens)}
        <span className="block text-xs text-kumo-subtle">
          {formatInteger(row.original.input_tokens)} in ·{" "}
          {formatInteger(row.original.output_tokens)} out
        </span>
      </span>
    ),
  },
  {
    accessorKey: "cost_usd",
    header: "Cost",
    cell: ({ row }) => <span>{formatCost(row.original.cost_usd)}</span>,
  },
];

export const ReplayDashboard = ({
  replay,
  view = "all",
  showSummary = true,
}: {
  readonly replay: SessionExport;
  readonly view?: "all" | "timeline" | "state" | "usage";
  readonly showSummary?: boolean;
}) => {
  const timeline = buildReplayTimeline(replay);
  const costs = aggregateReplayCosts(replay);
  const frames = reconstructReplayFrames(replay);

  return (
    <div className="space-y-4">
      {showSummary ? (
        <LayerCard className="flex flex-wrap items-center gap-2 p-3">
          <span>{replay.session.session_id}</span>
          <span>{replay.session.faction}</span>
          <span>{replay.session.doctrine}</span>
          <span>{replay.session.mode}</span>
          <span className="text-xs text-kumo-subtle">Exported {replay.session.exported_at}</span>
        </LayerCard>
      ) : null}

      {view === "all" || view === "state" ? (
        <ReplayStateProgression
          key={`${replay.session.session_id}:${replay.session.exported_at}`}
          frames={frames}
        />
      ) : null}

      {view === "all" || view === "timeline" ? (
        <PoligonFigure
          caption={`${timeline.length} decisions · ${replay.archive.ticks.length} ticks · ${replay.archive.events.length} archived events`}
        >
          <section className="space-y-3 p-3" aria-label="Cause to outcome replay timeline">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h2 className="m-0 text-sm font-semibold text-kumo-strong">Decision timeline</h2>
              <div className="flex items-center gap-1 text-xs" aria-label="Timeline stages">
                <span>Cause</span>
                <span aria-hidden="true">→</span>
                <span>Decision</span>
                <span aria-hidden="true">→</span>
                <span>Commands</span>
                <span aria-hidden="true">→</span>
                <span>Outcomes</span>
              </div>
            </div>
            <PoligonLogFeed
              items={timeline}
              getKey={(item) => item.id}
              renderItem={(item) => (
                <article className="space-y-2">
                  <p className="m-0 text-xs text-kumo-subtle">{item.timestamp}</p>
                  <p className="m-0">
                    <strong>Cause</strong> · {item.cause}
                  </p>
                  <p className="m-0">
                    <strong>Decision</strong> · {item.decision || "No summary recorded"}
                  </p>
                  <p className="m-0">
                    <strong>Commands</strong> · {item.commands.join("; ") || "No commands issued"}
                  </p>
                  <p className="m-0">
                    <strong>Outcomes</strong> · {item.outcomes.join("; ") || "No archived outcome"}
                  </p>
                </article>
              )}
              height={420}
            />
          </section>
        </PoligonFigure>
      ) : null}

      {view === "all" || view === "usage" ? (
        <PoligonFigure caption="Grouped by session, faction, agent tier, and model">
          <section className="space-y-3 p-3" aria-label="Replay cost breakdown">
            <h2 className="m-0 text-sm font-semibold text-kumo-strong">Calls, tokens, and cost</h2>
            <PoligonDataTable
              data={costs}
              columns={costColumns}
              emptyLabel="No model usage recorded in this export"
              getRowId={(row) => row.key}
            />
          </section>
        </PoligonFigure>
      ) : null}
    </div>
  );
};
