import { Badge } from "@cloudflare/kumo/components/badge";
import { Button } from "@cloudflare/kumo/components/button";
import { ArrowSquareOut, Info, ListChecks, Users } from "@phosphor-icons/react";
import type { SimGroup, SimObjective } from "@stavka/sim-core";
import type { ReactNode } from "react";

import type {
  PoligonCommanderState,
  PoligonDecision,
  PoligonLog,
  PoligonState,
} from "../sim-world";

export type InspectorTab = "units" | "decisions" | "usage" | "log";

export const inspectorTabLabels: Record<InspectorTab, string> = {
  units: "Units",
  decisions: "Decisions",
  usage: "Usage",
  log: "Log",
};

export const isInspectorTab = (value: string): value is InspectorTab =>
  Object.hasOwn(inspectorTabLabels, value);

export const formatOrderKind = (kind: string): string => kind.replaceAll("_", " ");

export const formatPosition = (position: SimGroup["position"]): string =>
  `${position[0].toFixed(0)}, ${position[2].toFixed(0)} m`;

const capitalize = (value: string): string => value.charAt(0).toUpperCase() + value.slice(1);

export const SimulationEmpty = ({
  icon,
  title,
  children,
}: {
  readonly icon?: ReactNode;
  readonly title: string;
  readonly children?: ReactNode;
}) => (
  <div className="simulation-empty">
    {icon}
    <strong>{title}</strong>
    {children ? <p>{children}</p> : null}
  </div>
);

const objectiveVariant = (status: SimObjective["status"]) =>
  status === "friendly"
    ? "success"
    : status === "enemy"
      ? "error"
      : status === "contested"
        ? "warning"
        : "secondary";

const SimulationUnitDetail = ({ group }: { readonly group: SimGroup }) => (
  <div className="simulation-unit-detail">
    <dl className="simulation-facts">
      <dt>Template</dt>
      <dd>{group.template}</dd>
      <dt>Strength</dt>
      <dd>
        {group.agents.length} of {group.maxStrength}
      </dd>
      <dt>Order</dt>
      <dd>
        {group.order
          ? `${formatOrderKind(group.order.kind)} to ${formatPosition(group.order.destination)}, radius ${group.order.radius.toFixed(0)} m, issued at step ${group.order.issuedAtTick}`
          : "None"}
      </dd>
      {group.behavior ? (
        <>
          <dt>Behavior</dt>
          <dd>{formatOrderKind(group.behavior)}</dd>
        </>
      ) : null}
      {group.targetObjectiveId ? (
        <>
          <dt>Objective</dt>
          <dd>{group.targetObjectiveId}</dd>
        </>
      ) : null}
      {group.mountedVehicleId ? (
        <>
          <dt>Vehicle</dt>
          <dd>{group.mountedVehicleId}</dd>
        </>
      ) : null}
      <dt>Position</dt>
      <dd>{formatPosition(group.position)}</dd>
    </dl>
  </div>
);

export function SimulationUnitList({
  groups,
  objectives,
  selectedId,
  onSelect,
}: {
  readonly groups: readonly SimGroup[];
  readonly objectives: readonly SimObjective[];
  readonly selectedId: string | undefined;
  readonly onSelect: (groupId: string | undefined) => void;
}) {
  const strength = groups.reduce((sum, group) => sum + group.agents.length, 0);
  const capacity = groups.reduce((sum, group) => sum + group.maxStrength, 0);
  return (
    <>
      <div className="simulation-panel-summary">
        <span>
          <strong>{groups.length}</strong>
          {groups.length === 1 ? "group" : "groups"}
        </span>
        <span>
          <strong>
            {strength}/{capacity}
          </strong>
          strength
        </span>
        <span>
          <strong>{objectives.length}</strong>
          {objectives.length === 1 ? "objective" : "objectives"}
        </span>
      </div>
      {groups.length ? (
        <ul className="simulation-list" aria-label="Groups">
          {groups.map((group) => {
            const selected = group.id === selectedId;
            return (
              <li key={group.id}>
                <button
                  type="button"
                  className="simulation-unit-row"
                  aria-pressed={selected}
                  data-unit-row={group.id}
                  onClick={() => onSelect(selected ? undefined : group.id)}
                >
                  <span className="simulation-unit-title">
                    {group.id}
                    <Badge variant="secondary">{group.faction}</Badge>
                  </span>
                  <span className="simulation-unit-status" data-status={group.status}>
                    {group.status}
                  </span>
                  <span className="simulation-unit-sub">
                    <span>
                      {group.agents.length}/{group.maxStrength} strength
                    </span>
                    <span>{group.order ? formatOrderKind(group.order.kind) : "no order"}</span>
                    <span>{formatPosition(group.position)}</span>
                  </span>
                </button>
                {selected ? <SimulationUnitDetail group={group} /> : null}
              </li>
            );
          })}
        </ul>
      ) : (
        <SimulationEmpty icon={<Users size={22} />} title="No groups in this world">
          Groups appear once the scenario spawns them.
        </SimulationEmpty>
      )}
      {objectives.length ? (
        <>
          <p className="simulation-section-label">Objectives</p>
          <ul className="simulation-list" aria-label="Objectives">
            {objectives.map((objective) => (
              <li key={objective.id} className="simulation-objective-row">
                <strong>{objective.name}</strong>
                <Badge variant={objectiveVariant(objective.status)}>{objective.status}</Badge>
                <span>{Math.round(objective.capture_progress * 100)}% captured</span>
                {objective.ownerFaction ? <span>held by {objective.ownerFaction}</span> : null}
                <span>{formatPosition(objective.position)}</span>
              </li>
            ))}
          </ul>
        </>
      ) : null}
    </>
  );
}

const DECISION_WINDOW = 20;

export function SimulationDecisionList({
  decisions,
  offline,
}: {
  readonly decisions: readonly PoligonDecision[];
  readonly offline: boolean;
}) {
  if (!decisions.length) {
    return (
      <SimulationEmpty icon={<ListChecks size={22} />} title="No decisions recorded">
        {offline
          ? "Offline mode does not request Commander decisions."
          : "Step or resume the simulation to request a Commander decision."}
      </SimulationEmpty>
    );
  }
  const recent = decisions.slice(-DECISION_WINDOW).reverse();
  return (
    <>
      {decisions.length > recent.length ? (
        <div className="simulation-panel-summary">
          <span>
            Latest <strong>{recent.length}</strong>of {decisions.length} decisions
          </span>
        </div>
      ) : null}
      <ol className="simulation-list" aria-label="Commander decisions, latest first">
        {recent.map((item, index) => (
          <li key={item.key} className="simulation-entry">
            <div className="simulation-entry-meta">
              <Badge variant="secondary">{item.faction}</Badge>
              {index === 0 ? <Badge variant="outline">Latest</Badge> : null}
              <span>{item.model}</span>
              <span>{new Date(item.timestamp).toLocaleTimeString()}</span>
            </div>
            <p>{item.summary}</p>
            <div className="simulation-entry-meta">
              <span>{item.latency_ms.toFixed(0)} ms</span>
              <span>${item.cost_usd.toFixed(4)}</span>
            </div>
          </li>
        ))}
      </ol>
    </>
  );
}

export function SimulationEventLog({ logs }: { readonly logs: readonly PoligonLog[] }) {
  if (!logs.length) {
    return (
      <SimulationEmpty icon={<Info size={22} />} title="No session events yet">
        Connection and simulation events will appear here.
      </SimulationEmpty>
    );
  }
  return (
    <ol className="simulation-list" aria-label="Session events, latest first">
      {[...logs].reverse().map((item) => (
        <li key={item.id} className="simulation-entry" data-level={item.level}>
          <div className="simulation-entry-meta">
            <span>T+{item.at.toFixed(1)}s</span>
            <span className="simulation-entry-level">{item.level}</span>
            {item.faction ? <span>{item.faction}</span> : null}
          </div>
          <p>{item.message}</p>
        </li>
      ))}
    </ol>
  );
}

const commanderVariant = (commander: PoligonCommanderState | undefined) =>
  commander?.lastError
    ? "error"
    : !commander?.connected
      ? "secondary"
      : commander.mode === "llm"
        ? "success"
        : "warning";

const commanderNote = (commander: PoligonCommanderState | undefined): string => {
  if (commander?.lastError) return commander.lastError;
  if (!commander?.connected) return "Step or resume to connect this faction to Commander.";
  if (commander.mode === "llm") {
    return `Model configured. Last tick ${commander.lastTickId}. Check recorded results under Decisions and Usage.`;
  }
  return `${capitalize(commander.mode)} decisions. This does not confirm a live model response.`;
};

export function SimulationCommanderStatus({
  state,
  offline,
  factions,
  onInspectSession,
}: {
  readonly state: PoligonState;
  readonly offline: boolean;
  readonly factions: readonly string[];
  readonly onInspectSession: (faction: string) => void;
}) {
  if (offline) {
    return (
      <div className="simulation-commander-row">
        <div className="simulation-commander-status">
          <div>
            <strong>Commander</strong>
            <Badge variant="secondary">Offline simulation</Badge>
          </div>
          <span className="simulation-commander-note">
            This browser runs sim-core locally. No Agent, Commander, or provider request is made.
          </span>
        </div>
      </div>
    );
  }
  return (
    <>
      {factions.map((faction) => {
        const commander = state.commanders[faction];
        return (
          <div className="simulation-commander-row" key={faction}>
            <div className="simulation-commander-status">
              <div>
                <strong>{faction}</strong>{" "}
                <Badge variant={commanderVariant(commander)}>
                  {commander?.connected ? commander.mode : "not connected"}
                </Badge>
              </div>
              <span className="simulation-commander-note">{commanderNote(commander)}</span>
            </div>
            <Button size="sm" onClick={() => onInspectSession(faction)}>
              Inspect {faction} session <ArrowSquareOut size={13} />
            </Button>
          </div>
        );
      })}
    </>
  );
}
