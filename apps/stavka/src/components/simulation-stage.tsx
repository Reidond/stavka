import { lazy, Suspense } from "react";
import { Badge } from "@cloudflare/kumo/components/badge";
import { Button } from "@cloudflare/kumo/components/button";
import { X } from "@phosphor-icons/react";
import type { SimGroup } from "@stavka/sim-core";

import type { PoligonState } from "../sim-world";
import { formatOrderKind } from "./simulation-inspector";
import { TacticalMap } from "./tactical-map";

const Battlefield = lazy(() =>
  import("./battlefield").then((module) => ({ default: module.Battlefield })),
);

export type SimulationCamera = "ortho" | "perspective";

const SelectionCallout = ({
  group,
  onClear,
  onDetails,
}: {
  readonly group: SimGroup;
  readonly onClear: () => void;
  readonly onDetails: () => void;
}) => (
  <div
    className="stavka-map-detail simulation-map-callout"
    role="group"
    aria-label={`Selected group ${group.id}`}
  >
    <div className="simulation-callout-head">
      <strong>{group.id}</strong>
      <Badge variant="secondary">{group.faction}</Badge>
      <Button
        variant="ghost"
        shape="square"
        size="sm"
        aria-label="Clear selection"
        icon={<X size={14} />}
        onClick={onClear}
      />
    </div>
    <div className="simulation-callout-facts">
      <span>{group.status}</span>
      <span>
        {group.agents.length}/{group.maxStrength} strength
      </span>
      <span>{group.order ? `order: ${formatOrderKind(group.order.kind)}` : "no order"}</span>
    </div>
    <div className="simulation-callout-actions">
      <Button size="sm" onClick={onDetails}>
        Details
      </Button>
    </div>
  </div>
);

/** The battlefield surface: 2D map or 3D view plus the overlays that belong on the map itself. */
export function SimulationStage({
  state,
  camera,
  onCameraChange,
  selectedId,
  onSelect,
  onShowDetails,
}: {
  readonly state: PoligonState;
  readonly camera: SimulationCamera;
  readonly onCameraChange: (camera: SimulationCamera) => void;
  readonly selectedId: string | undefined;
  readonly onSelect: (groupId: string | undefined) => void;
  readonly onShowDetails: () => void;
}) {
  const selected = selectedId ? state.world.groups[selectedId] : undefined;
  return (
    <section className="simulation-stage" aria-label="Battlefield">
      <div className="stavka-panel simulation-map-frame">
        <div className="simulation-map-view">
          {camera === "ortho" ? (
            <TacticalMap
              world={state.world}
              faction={state.faction}
              selectedId={selectedId}
              onSelect={onSelect}
            />
          ) : (
            <Suspense
              fallback={<div className="simulation-map-loading">Loading 3D battlefield…</div>}
            >
              <Battlefield world={state.world} faction={state.faction} camera="perspective" />
            </Suspense>
          )}
        </div>
        <div
          className="simulation-map-overlay simulation-map-overlay-start"
          role="group"
          aria-label="Map view"
        >
          <Button
            variant={camera === "ortho" ? "secondary" : "ghost"}
            aria-pressed={camera === "ortho"}
            onClick={() => onCameraChange("ortho")}
          >
            2D map
          </Button>
          <Button
            variant={camera === "perspective" ? "secondary" : "ghost"}
            aria-pressed={camera === "perspective"}
            onClick={() => onCameraChange("perspective")}
          >
            3D view
          </Button>
        </div>
        {selected && camera === "ortho" ? (
          <SelectionCallout
            group={selected}
            onClear={() => onSelect(undefined)}
            onDetails={onShowDetails}
          />
        ) : null}
      </div>
    </section>
  );
}
