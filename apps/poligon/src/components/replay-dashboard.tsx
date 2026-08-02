import type {
  CommanderCostAggregate,
  CommandResult,
  DecisionLogEntry,
  GameSnapshot,
  SessionExport,
} from "@stavka/protocol";
import {
  Button,
  DataTable,
  FigureFrame,
  LogFeed,
  mapSheetColors,
  StatusChip,
  type ColumnDef,
} from "@stavka/ui";
import { useState } from "react";

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
    ? mapSheetColors.ultramarine
    : kind === "known_enemy"
      ? mapSheetColors.carmine
      : mapSheetColors.olive;

const ReplayTacticalState = ({ frame }: { readonly frame: ReplayFrame }) => {
  const markers = projectReplayTacticalMarkers(frame.snapshot);
  const xValues = markers.map((marker) => marker.x);
  const zValues = markers.map((marker) => marker.z);
  const minimumX = Math.min(...xValues, 0);
  const maximumX = Math.max(...xValues, 1);
  const minimumZ = Math.min(...zValues, 0);
  const maximumZ = Math.max(...zValues, 1);
  const projectX = (value: number): number =>
    8 + ((value - minimumX) / Math.max(1, maximumX - minimumX)) * 84;
  const projectZ = (value: number): number =>
    92 - ((value - minimumZ) / Math.max(1, maximumZ - minimumZ)) * 84;

  return (
    <div className="grid gap-3 lg:grid-cols-[minmax(0,2fr)_minmax(16rem,1fr)]">
      <svg
        viewBox="0 0 100 100"
        role="img"
        aria-label={`Reconstructed tactical state at tick ${frame.tickId}`}
        className="min-h-72 w-full border border-contour bg-paper"
      >
        <title>{`Tick ${frame.tickId} reconstructed friendly, objective, and known-enemy positions`}</title>
        <path d="M 8 92 H 92 M 8 92 V 8" fill="none" stroke={mapSheetColors.contour} />
        {markers.map((marker) => {
          const x = projectX(marker.x);
          const y = projectZ(marker.z);
          const color = markerColor(marker.kind);
          return (
            <g key={marker.key} data-marker={marker.key}>
              <title>{`${marker.label} · X ${marker.x.toFixed(0)} · Z ${marker.z.toFixed(0)} · ${marker.detail}`}</title>
              {marker.kind === "objective" ? (
                <rect x={x - 2.5} y={y - 2.5} width={5} height={5} fill={color} />
              ) : marker.kind === "known_enemy" ? (
                <path
                  d={`M ${x} ${y - 3} L ${x + 3} ${y + 3} L ${x - 3} ${y + 3} Z`}
                  fill={color}
                />
              ) : (
                <circle cx={x} cy={y} r={3} fill={color} />
              )}
            </g>
          );
        })}
      </svg>
      <div className="space-y-3">
        <div className="grid grid-cols-2 gap-2 font-data text-xs">
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
            <li key={marker.key} className="list-none border-t border-contour pt-1">
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
      <FigureFrame caption="No canonical full snapshot was archived">
        <p className="m-0 p-4 text-sm">No replay state frames are available.</p>
      </FigureFrame>
    );
  }

  return (
    <FigureFrame
      caption={`Tick ${frame.tickId} · ${frame.kind} · ${frame.source} state · ${selectedIndex + 1}/${frames.length}`}
    >
      <section className="space-y-3 p-3" aria-label="Reconstructed replay world progression">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex flex-wrap gap-2">
            <StatusChip>{frame.kind}</StatusChip>
            <StatusChip>{frame.source}</StatusChip>
            <StatusChip>{frame.events.length} events</StatusChip>
            <StatusChip>{frame.commandResults.length} results</StatusChip>
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
    </FigureFrame>
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
    cell: ({ row }) => <StatusChip>{row.original.faction}</StatusChip>,
  },
  {
    id: "agent",
    header: "Agent / model",
    cell: ({ row }) => (
      <div className="min-w-36">
        <StatusChip>{row.original.agent_tier}</StatusChip>
        <span className="mt-1 block font-data text-xs">{row.original.model}</span>
      </div>
    ),
  },
  {
    accessorKey: "calls",
    header: "Calls",
    cell: ({ row }) => <span className="font-data">{formatInteger(row.original.calls)}</span>,
  },
  {
    id: "tokens",
    header: "Tokens",
    cell: ({ row }) => (
      <span className="font-data">
        {formatInteger(row.original.input_tokens + row.original.output_tokens)}
        <span className="block text-[0.65rem] text-ink/60">
          {formatInteger(row.original.input_tokens)} in ·{" "}
          {formatInteger(row.original.output_tokens)} out
        </span>
      </span>
    ),
  },
  {
    accessorKey: "cost_usd",
    header: "Cost",
    cell: ({ row }) => <span className="font-data">{formatCost(row.original.cost_usd)}</span>,
  },
];

export const ReplayDashboard = ({ replay }: { readonly replay: SessionExport }) => {
  const timeline = buildReplayTimeline(replay);
  const costs = aggregateReplayCosts(replay);
  const frames = reconstructReplayFrames(replay);

  return (
    <div className="space-y-4">
      <section className="stavka-panel flex flex-wrap items-center gap-2 p-3">
        <StatusChip>{replay.session.session_id}</StatusChip>
        <StatusChip>{replay.session.faction}</StatusChip>
        <StatusChip>{replay.session.doctrine}</StatusChip>
        <StatusChip>{replay.session.mode}</StatusChip>
        <span className="font-data text-xs">Exported {replay.session.exported_at}</span>
      </section>

      <ReplayStateProgression
        key={`${replay.session.session_id}:${replay.session.exported_at}`}
        frames={frames}
      />

      <FigureFrame
        caption={`${timeline.length} decisions · ${replay.archive.ticks.length} ticks · ${replay.archive.events.length} archived events`}
      >
        <section className="space-y-3 p-3" aria-label="Cause to outcome replay timeline">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="m-0 font-display text-2xl uppercase">Decision timeline</h2>
            <div className="flex items-center gap-1 font-data text-xs" aria-label="Timeline stages">
              <StatusChip>Cause</StatusChip>
              <span aria-hidden="true">→</span>
              <StatusChip>Decision</StatusChip>
              <span aria-hidden="true">→</span>
              <StatusChip>Commands</StatusChip>
              <span aria-hidden="true">→</span>
              <StatusChip>Outcomes</StatusChip>
            </div>
          </div>
          <LogFeed
            items={timeline}
            getKey={(item) => item.id}
            renderItem={(item) => (
              <article className="space-y-2">
                <p className="m-0 font-data text-xs">{item.timestamp}</p>
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
      </FigureFrame>

      <FigureFrame caption="Grouped by session, faction, agent tier, and model">
        <section className="space-y-3 p-3" aria-label="Replay cost breakdown">
          <h2 className="m-0 font-display text-2xl uppercase">Calls, tokens, and cost</h2>
          <DataTable
            data={costs}
            columns={costColumns}
            emptyLabel="No model usage recorded in this export"
            getRowId={(row) => row.key}
          />
        </section>
      </FigureFrame>
    </div>
  );
};
