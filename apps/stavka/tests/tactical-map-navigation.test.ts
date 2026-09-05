import { describe, expect, it } from "vitest";
import {
  fittedTacticalView,
  panTacticalView,
  zoomTacticalView,
  type TacticalMapFrame,
  type TacticalMapView,
} from "../src/components/tactical-map";

const frame: TacticalMapFrame = {
  width: 900,
  height: 500,
  centerX: 600,
  centerZ: 300,
  span: 1000,
};
const worldAt = (view: TacticalMapView, point: { x: number; y: number }) => {
  const scale = (Math.min(frame.width, frame.height) * view.zoom) / frame.span;
  return {
    x: frame.centerX + view.panX + (point.x - frame.width / 2) / scale,
    z: frame.centerZ + view.panZ - (point.y - frame.height / 2) / scale,
  };
};

describe("tactical map navigation", () => {
  it("keeps the world position under the pointer stable when zooming", () => {
    const point = { x: 710, y: 160 };
    const view = { zoom: 1, panX: 80, panZ: -40 };
    const before = worldAt(view, point);
    const after = worldAt(zoomTacticalView(view, frame, 1.25, point), point);
    expect(after.x).toBeCloseTo(before.x);
    expect(after.z).toBeCloseTo(before.z);
  });

  it("converts a drag in pixels to world movement at the current zoom", () => {
    expect(panTacticalView(fittedTacticalView, frame, 30, 20)).toEqual({
      zoom: 1,
      panX: -60,
      panZ: 40,
    });
    expect(panTacticalView({ ...fittedTacticalView, zoom: 2 }, frame, 30, 20)).toEqual({
      zoom: 2,
      panX: -30,
      panZ: 20,
    });
  });

  it("bounds navigation and permits returning from either zoom limit", () => {
    const max = zoomTacticalView(fittedTacticalView, frame, 100);
    const min = zoomTacticalView(fittedTacticalView, frame, 0.001);
    expect(max.zoom).toBe(4);
    expect(min.zoom).toBe(0.5);
    expect(zoomTacticalView(max, frame, 0.8).zoom).toBeLessThan(max.zoom);
    expect(zoomTacticalView(min, frame, 1.25).zoom).toBeGreaterThan(min.zoom);
    expect(panTacticalView(fittedTacticalView, frame, 1e6, -1e6)).toEqual({
      zoom: 1,
      panX: -frame.span,
      panZ: -frame.span,
    });
  });
});
