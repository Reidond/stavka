import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { Button } from "@cloudflare/kumo/components/button";
import { Crosshair, Minus, Plus } from "@phosphor-icons/react";
import type { SimWorldState } from "@stavka/sim-core";
import { poligonVisualizationPalette as palette } from "./poligon-ui";

/** Colours used by the 2D map on its dark surface. Exported so overlays can match them. */
export const tacticalMapColors = {
  friendly: "#38bdf8",
  hostile: "#fb7185",
  surface: "#101d2c",
  chrome: "#a9bbcf",
  label: "#f1f5f9",
  muted: "#9cacc0",
} as const;

/** Fit units, objectives and destinations, including collinear scenarios. */
export const tacticalBounds = (world: SimWorldState) => {
  const positions = [
    ...Object.values(world.groups).flatMap((group) =>
      group.order ? [group.position, group.order.destination] : [group.position],
    ),
    ...Object.values(world.vehicles).map((vehicle) => vehicle.position),
    ...Object.values(world.objectives).map((objective) => objective.position),
  ];
  const xs = positions.map((position) => position[0]);
  const zs = positions.map((position) => position[2]);
  const minX = xs.length ? Math.min(...xs) : 0,
    maxX = xs.length ? Math.max(...xs) : 1;
  const minZ = zs.length ? Math.min(...zs) : 0,
    maxZ = zs.length ? Math.max(...zs) : 1;
  const span = Math.max(250, maxX - minX, maxZ - minZ) * 1.55;
  return { centerX: (minX + maxX) / 2, centerZ: (minZ + maxZ) / 2, span };
};

/** Zoom and pan relative to the auto-fitted battlefield bounds, in world metres. */
export interface TacticalMapView {
  readonly zoom: number;
  readonly panX: number;
  readonly panZ: number;
}

export const fittedTacticalView: TacticalMapView = { zoom: 1, panX: 0, panZ: 0 };

/** Viewport pixels plus the fitted bounds every projection derives from. */
export interface TacticalMapFrame {
  readonly width: number;
  readonly height: number;
  readonly centerX: number;
  readonly centerZ: number;
  readonly span: number;
}

const MIN_ZOOM = 0.5;
const MAX_ZOOM = 4;
const DRAG_THRESHOLD_PX = 4;
const KEY_PAN_PX = 48;
const BUTTON_ZOOM_STEP = 1.25;

const clampZoom = (zoom: number): number => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom));
const clampPan = (value: number, span: number): number => Math.min(span, Math.max(-span, value));
const frameScale = (frame: TacticalMapFrame, zoom: number): number =>
  (Math.min(frame.width, frame.height) * zoom) / frame.span;

/** Zoom around a viewport point so the terrain under the pointer stays put. */
export const zoomTacticalView = (
  view: TacticalMapView,
  frame: TacticalMapFrame,
  factor: number,
  point?: { readonly x: number; readonly y: number },
): TacticalMapView => {
  const zoom = clampZoom(view.zoom * factor);
  if (zoom === view.zoom) return view;
  const dx = (point?.x ?? frame.width / 2) - frame.width / 2;
  const dy = (point?.y ?? frame.height / 2) - frame.height / 2;
  const before = frameScale(frame, view.zoom);
  const after = frameScale(frame, zoom);
  const worldX = frame.centerX + view.panX + dx / before;
  const worldZ = frame.centerZ + view.panZ - dy / before;
  return {
    zoom,
    panX: clampPan(worldX - dx / after - frame.centerX, frame.span),
    panZ: clampPan(worldZ + dy / after - frame.centerZ, frame.span),
  };
};

/** Move the view by a pixel delta (positive x drags the terrain to the right). */
export const panTacticalView = (
  view: TacticalMapView,
  frame: TacticalMapFrame,
  dxPx: number,
  dyPx: number,
): TacticalMapView => {
  const scale = frameScale(frame, view.zoom);
  return {
    ...view,
    panX: clampPan(view.panX - dxPx / scale, frame.span),
    panZ: clampPan(view.panZ + dyPx / scale, frame.span),
  };
};

interface Gesture {
  startX: number;
  startY: number;
  moved: boolean;
  lastMidX?: number;
  lastMidY?: number;
  lastDistance?: number;
}

export function TacticalMap({
  world,
  faction,
  selectedId,
  onSelect,
}: {
  readonly world: SimWorldState;
  readonly faction: string;
  /** Controlled selection shared with the inspector. */
  readonly selectedId?: string | undefined;
  readonly onSelect?: ((groupId: string | undefined) => void) | undefined;
}) {
  const gridId = useId();
  const arrowId = useId();
  const container = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 1000, height: 600 });
  const [view, setView] = useState<TacticalMapView>(fittedTacticalView);
  const [dragging, setDragging] = useState(false);
  const bounds = tacticalBounds(world);
  const frame: TacticalMapFrame = {
    width: size.width,
    height: size.height,
    centerX: bounds.centerX,
    centerZ: bounds.centerZ,
    span: bounds.span,
  };
  const frameRef = useRef(frame);
  frameRef.current = frame;
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const gesture = useRef<Gesture | null>(null);
  const suppressClick = useRef(false);

  useEffect(() => {
    const element = container.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry && entry.contentRect.width > 0 && entry.contentRect.height > 0)
        setSize({ width: entry.contentRect.width, height: entry.contentRect.height });
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const element = container.current;
    if (!element) return;
    // React registers wheel listeners as passive, so a native listener is required to stop the
    // wheel from scrolling the surrounding pane while zooming the map.
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const rect = element.getBoundingClientRect();
      const delta = event.deltaMode === 1 ? event.deltaY * 16 : event.deltaY;
      const factor = Math.min(2, Math.max(0.5, Math.exp(-delta * 0.002)));
      setView((current) =>
        zoomTacticalView(current, frameRef.current, factor, {
          x: event.clientX - rect.left,
          y: event.clientY - rect.top,
        }),
      );
    };
    element.addEventListener("wheel", onWheel, { passive: false });
    return () => element.removeEventListener("wheel", onWheel);
  }, []);

  const scale = frameScale(frame, view.zoom);
  const centerX = bounds.centerX + view.panX;
  const centerZ = bounds.centerZ + view.panZ;
  const projectX = (value: number) => size.width / 2 + (value - centerX) * scale;
  const projectZ = (value: number) => size.height / 2 - (value - centerZ) * scale;
  const groups = Object.values(world.groups);
  const terrain = useMemo(() => {
    const cells = [];
    const { width, height, cellSizeMeters, samples } = world.terrain;
    for (let z = 0; z < height; z += 4)
      for (let x = 0; x < width; x += 4) {
        const elevation = samples[z * width + x] ?? -256;
        cells.push({
          x: x * cellSizeMeters,
          z: z * cellSizeMeters,
          size: 4 * cellSizeMeters,
          elevation,
        });
      }
    return cells;
  }, [world.terrain]);

  const fit = () => {
    setView(fittedTacticalView);
    onSelect?.(undefined);
  };
  const zoomBy = (factor: number) =>
    setView((current) => zoomTacticalView(current, frameRef.current, factor));

  const localPoint = (event: ReactPointerEvent<HTMLDivElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  };
  const endPointer = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!pointers.current.delete(event.pointerId)) return;
    if (event.currentTarget.hasPointerCapture(event.pointerId))
      event.currentTarget.releasePointerCapture(event.pointerId);
    const remaining = [...pointers.current.values()];
    const current = gesture.current;
    if (remaining.length === 0) {
      if (current?.moved) {
        suppressClick.current = true;
        window.setTimeout(() => {
          suppressClick.current = false;
        }, 0);
      }
      gesture.current = null;
      setDragging(false);
      return;
    }
    if (current && remaining.length === 1 && remaining[0]) {
      gesture.current = { startX: remaining[0].x, startY: remaining[0].y, moved: true };
    }
  };
  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.pointerType === "mouse" && event.button !== 0) return;
    const point = localPoint(event);
    pointers.current.set(event.pointerId, point);
    if (pointers.current.size === 1) {
      gesture.current = { startX: point.x, startY: point.y, moved: false };
      return;
    }
    const [first, second] = [...pointers.current.values()];
    if (!first || !second) return;
    gesture.current = {
      startX: point.x,
      startY: point.y,
      moved: true,
      lastMidX: (first.x + second.x) / 2,
      lastMidY: (first.y + second.y) / 2,
      lastDistance: Math.hypot(first.x - second.x, first.y - second.y),
    };
    for (const pointerId of pointers.current.keys()) {
      if (!event.currentTarget.hasPointerCapture(pointerId))
        event.currentTarget.setPointerCapture(pointerId);
    }
    setDragging(true);
  };
  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const previous = pointers.current.get(event.pointerId);
    const current = gesture.current;
    if (!previous || !current) return;
    const point = localPoint(event);
    pointers.current.set(event.pointerId, point);
    const active = [...pointers.current.values()];
    const [first, second] = active;
    if (first && second) {
      const midX = (first.x + second.x) / 2;
      const midY = (first.y + second.y) / 2;
      const distance = Math.hypot(first.x - second.x, first.y - second.y);
      if (current.lastDistance !== undefined && current.lastDistance > 0) {
        const factor = distance / current.lastDistance;
        const dx = midX - (current.lastMidX ?? midX);
        const dy = midY - (current.lastMidY ?? midY);
        setView((state) =>
          panTacticalView(
            zoomTacticalView(state, frameRef.current, factor, { x: midX, y: midY }),
            frameRef.current,
            dx,
            dy,
          ),
        );
      }
      current.lastMidX = midX;
      current.lastMidY = midY;
      current.lastDistance = distance;
      return;
    }
    if (!current.moved) {
      if (Math.hypot(point.x - current.startX, point.y - current.startY) < DRAG_THRESHOLD_PX)
        return;
      current.moved = true;
      event.currentTarget.setPointerCapture(event.pointerId);
      setDragging(true);
      setView((state) =>
        panTacticalView(
          state,
          frameRef.current,
          point.x - current.startX,
          point.y - current.startY,
        ),
      );
      return;
    }
    setView((state) =>
      panTacticalView(state, frameRef.current, point.x - previous.x, point.y - previous.y),
    );
  };
  const onClickCapture = (event: ReactMouseEvent<HTMLDivElement>) => {
    if (!suppressClick.current) return;
    event.preventDefault();
    event.stopPropagation();
    suppressClick.current = false;
  };
  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const pan = (dx: number, dy: number) =>
      setView((state) => panTacticalView(state, frameRef.current, dx, dy));
    switch (event.key) {
      case "ArrowLeft":
        pan(KEY_PAN_PX, 0);
        break;
      case "ArrowRight":
        pan(-KEY_PAN_PX, 0);
        break;
      case "ArrowUp":
        pan(0, KEY_PAN_PX);
        break;
      case "ArrowDown":
        pan(0, -KEY_PAN_PX);
        break;
      case "+":
      case "=":
        zoomBy(BUTTON_ZOOM_STEP);
        break;
      case "-":
      case "_":
        zoomBy(1 / BUTTON_ZOOM_STEP);
        break;
      case "0":
        fit();
        break;
      default:
        return;
    }
    event.preventDefault();
  };

  const scaleBarPx = 80;
  const scaleRight = size.width - 16;
  const scaleY = size.height - 18;
  return (
    <div
      className="simulation-map-viewport"
      ref={container}
      role="group"
      aria-label="Map viewport. Drag to pan; arrow keys pan; plus and minus zoom; zero fits the battlefield."
      tabIndex={0}
      data-dragging={dragging ? "true" : undefined}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endPointer}
      onPointerCancel={endPointer}
      onClickCapture={onClickCapture}
      onKeyDown={onKeyDown}
    >
      <svg
        viewBox={`0 0 ${size.width} ${size.height}`}
        role="img"
        aria-label="Tactical map with live unit positions"
        className="block size-full"
      >
        <title>Unit positions, terrain elevation and active orders</title>
        <defs>
          <pattern id={gridId} width="60" height="60" patternUnits="userSpaceOnUse">
            <path d="M 60 0 L 0 0 0 60" fill="none" stroke="#33475d" strokeWidth="0.7" />
          </pattern>
          <marker
            id={arrowId}
            viewBox="0 0 10 10"
            refX="7"
            refY="5"
            markerWidth="5"
            markerHeight="5"
            orient="auto-start-reverse"
          >
            <path d="M 0 0 L 10 5 L 0 10 z" fill={palette.objective} />
          </marker>
        </defs>
        <rect width={size.width} height={size.height} fill={tacticalMapColors.surface} />
        {terrain.map((cell) => (
          <rect
            key={`${cell.x}:${cell.z}`}
            x={projectX(cell.x)}
            y={projectZ(cell.z + cell.size)}
            width={cell.size * scale + 0.2}
            height={cell.size * scale + 0.2}
            fill={cell.elevation === -256 ? "#17324b" : "#425e54"}
            opacity={cell.elevation === -256 ? 0.5 : 0.18 + cell.elevation / 650}
          />
        ))}
        <rect width={size.width} height={size.height} fill={`url(#${gridId})`} />
        {groups
          .filter((group) => group.order)
          .map((group) => (
            <g key={`order:${group.id}`}>
              <path
                d={`M ${projectX(group.position[0])} ${projectZ(group.position[2])} L ${projectX(group.order!.destination[0])} ${projectZ(group.order!.destination[2])}`}
                stroke={palette.objective}
                strokeWidth="1.8"
                strokeDasharray="7 6"
                opacity="0.65"
                markerEnd={`url(#${arrowId})`}
              />
            </g>
          ))}
        {Object.values(world.objectives).map((objective) => (
          <g
            key={objective.id}
            transform={`translate(${projectX(objective.position[0])},${projectZ(objective.position[2])})`}
          >
            <path d="M 0 -12 L 12 0 L 0 12 L -12 0 Z" fill={palette.objective} />
            <text y="30" textAnchor="middle" fill="#e2e8f0" fontSize="13">
              {objective.name}
            </text>
          </g>
        ))}
        {Object.values(world.vehicles).map((vehicle) => (
          <g
            key={vehicle.id}
            transform={`translate(${projectX(vehicle.position[0])},${projectZ(vehicle.position[2]) - 32})`}
          >
            <rect x="-8" y="-6" width="16" height="12" rx="2" fill="#cbd5e1" />
            <text x="15" y="5" fill="#cbd5e1" fontSize="12">
              {vehicle.template}
            </text>
          </g>
        ))}
        {groups.map((group) => {
          const color =
            group.faction === faction ? tacticalMapColors.friendly : tacticalMapColors.hostile;
          const selected = selectedId === group.id;
          return (
            <g
              key={group.id}
              data-unit={group.id}
              transform={`translate(${projectX(group.position[0])},${projectZ(group.position[2])})`}
              role="button"
              tabIndex={0}
              aria-label={`Select ${group.id}, ${group.faction}, ${group.agents.length} units`}
              aria-pressed={selected}
              onClick={() => onSelect?.(group.id)}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  event.stopPropagation();
                  onSelect?.(group.id);
                }
              }}
              className="stavka-map-unit"
            >
              <circle r={selected ? 25 : 21} fill={color} opacity={selected ? 0.28 : 0.12} />
              {selected ? (
                <circle
                  r="29"
                  fill="none"
                  stroke={color}
                  strokeWidth="1.5"
                  strokeDasharray="4 3"
                  opacity="0.9"
                />
              ) : null}
              <rect
                x="-12"
                y="-9"
                width="24"
                height="18"
                rx="3"
                fill={tacticalMapColors.surface}
                stroke={color}
                strokeWidth="2"
              />
              <path d="M -7 -5 L 7 5 M 7 -5 L -7 5" stroke={color} strokeWidth="1.4" />
              <text y="-31" textAnchor="middle" fill={color} fontSize="12" fontWeight="600">
                {group.faction}
              </text>
              <text
                y="37"
                textAnchor="middle"
                fill={tacticalMapColors.label}
                fontSize="15"
                fontWeight="600"
              >
                {group.id}
              </text>
              <text y="56" textAnchor="middle" fill={tacticalMapColors.muted} fontSize="12">
                {group.agents.length}/{group.maxStrength} · {group.status}
              </text>
            </g>
          );
        })}
        <g aria-hidden="true">
          <g transform={`translate(${scaleRight - scaleBarPx - 34} ${scaleY - 4})`}>
            <path d="M 0 -8 L -6 9 L 0 4 L 6 9 Z" fill={tacticalMapColors.chrome} />
            <text x="0" y="-12" fill={tacticalMapColors.chrome} textAnchor="middle" fontSize="11">
              N
            </text>
          </g>
          <path
            d={`M ${scaleRight - scaleBarPx} ${scaleY - 6} v 6 h ${scaleBarPx} v -6`}
            fill="none"
            stroke={tacticalMapColors.chrome}
            strokeWidth="1.5"
          />
          <text
            x={scaleRight - scaleBarPx / 2}
            y={scaleY - 11}
            textAnchor="middle"
            fill={tacticalMapColors.chrome}
            fontSize="11"
          >
            {Math.round(scaleBarPx / scale)} m
          </text>
        </g>
      </svg>
      <div
        className="simulation-map-overlay simulation-map-overlay-end"
        role="group"
        aria-label="Zoom"
      >
        <Button
          variant="ghost"
          shape="square"
          aria-label="Zoom out"
          icon={<Minus size={16} />}
          onClick={() => zoomBy(1 / BUTTON_ZOOM_STEP)}
        />
        <Button
          variant="ghost"
          shape="square"
          aria-label="Fit battlefield"
          icon={<Crosshair size={17} />}
          onClick={fit}
        />
        <Button
          variant="ghost"
          shape="square"
          aria-label="Zoom in"
          icon={<Plus size={16} />}
          onClick={() => zoomBy(BUTTON_ZOOM_STEP)}
        />
      </div>
    </div>
  );
}
