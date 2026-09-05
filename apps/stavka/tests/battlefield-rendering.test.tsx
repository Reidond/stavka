import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { createScenario } from "@stavka/sim-core";
import * as THREE from "three";

const controlsRuntime = vi.hoisted(() => ({
  camera: {},
  domElement: {},
  instances: [] as unknown[],
  invalidate: vi.fn(),
}));

vi.mock("@react-three/drei/web/Html", () => ({ Html: () => null }));

vi.mock("three/examples/jsm/controls/OrbitControls.js", () => ({
  OrbitControls: class {
    readonly target = { set: vi.fn() };
    maxPolarAngle = Number.POSITIVE_INFINITY;
    enableDamping = true;
    readonly listeners = new Map<string, () => void>();
    readonly addEventListener = vi.fn((name: string, listener: () => void) => {
      this.listeners.set(name, listener);
    });
    readonly removeEventListener = vi.fn((name: string, listener: () => void) => {
      if (this.listeners.get(name) === listener) this.listeners.delete(name);
    });
    readonly update = vi.fn();
    readonly dispose = vi.fn();

    constructor(
      readonly camera: unknown,
      readonly domElement: unknown,
    ) {
      controlsRuntime.instances.push(this);
    }
  },
}));

vi.mock("@react-three/fiber", () => ({
  Canvas: ({
    orthographic,
    camera,
    frameloop,
    shadows,
    children,
  }: {
    readonly orthographic?: boolean;
    readonly camera?: { readonly fov?: number; readonly zoom?: number };
    readonly frameloop?: string;
    readonly shadows?: string;
    readonly children: unknown;
  }) => (
    <div
      data-testid="canvas"
      data-orthographic={String(orthographic)}
      data-camera-fov={camera?.fov}
      data-camera-zoom={camera?.zoom}
      data-frameloop={frameloop}
      data-shadows={shadows}
    >
      {children as never}
    </div>
  ),
  useThree: () => ({
    camera: controlsRuntime.camera,
    gl: { domElement: controlsRuntime.domElement },
    invalidate: controlsRuntime.invalidate,
    size: { width: 1000, height: 600 },
  }),
}));

const { Battlefield, attachEventDrivenOrbitControls, fitBattlefieldCamera, battlefieldFocus } =
  await import("../src/components/battlefield");

interface MockOrbitControls {
  readonly camera: unknown;
  readonly domElement: unknown;
  readonly target: { readonly set: ReturnType<typeof vi.fn> };
  readonly maxPolarAngle: number;
  readonly enableDamping: boolean;
  readonly listeners: Map<string, () => void>;
  readonly addEventListener: ReturnType<typeof vi.fn>;
  readonly removeEventListener: ReturnType<typeof vi.fn>;
  readonly update: ReturnType<typeof vi.fn>;
  readonly dispose: ReturnType<typeof vi.fn>;
}

describe("Poligon battlefield rendering", () => {
  it("centers unit positions within the focused view", () => {
    const world = createScenario("engagement", 12);
    const camera = new THREE.PerspectiveCamera(48);
    fitBattlefieldCamera(
      camera,
      { width: 800, height: 460 },
      world.terrain,
      battlefieldFocus(world),
    );
    for (const group of Object.values(world.groups)) {
      const point = new THREE.Vector3(
        group.position[0] - ((world.terrain.width - 1) * world.terrain.cellSizeMeters) / 2,
        12,
        group.position[2] - ((world.terrain.height - 1) * world.terrain.cellSizeMeters) / 2,
      ).project(camera);
      expect(Math.abs(point.x)).toBeLessThan(0.7);
      expect(Math.abs(point.y)).toBeLessThan(0.7);
    }
  });
  it("keeps terrain corners in the frustum after desktop and mobile resize", () => {
    const terrain = createScenario("engagement", 12).terrain;
    const x = ((terrain.width - 1) * terrain.cellSizeMeters) / 2;
    const z = ((terrain.height - 1) * terrain.cellSizeMeters) / 2;
    for (const camera of [new THREE.PerspectiveCamera(48), new THREE.OrthographicCamera()]) {
      for (const size of [
        { width: 1000, height: 400 },
        { width: 340, height: 360 },
      ]) {
        fitBattlefieldCamera(camera, size, terrain);
        for (const px of [-x, x])
          for (const pz of [-z, z]) {
            const projected = new THREE.Vector3(px, 0, pz).project(camera);
            expect(Math.abs(projected.x)).toBeLessThan(1);
            expect(Math.abs(projected.y)).toBeLessThan(1);
            expect(Math.abs(projected.z)).toBeLessThan(1);
          }
      }
    }
  });
  it("renders on demand instead of running a permanent animation loop", () => {
    const markup = renderToStaticMarkup(
      <Battlefield world={createScenario("engagement", 12)} faction="OPFOR" camera="ortho" />,
    );

    expect(markup).toContain('data-frameloop="demand"');
    expect(markup).toContain('data-shadows="percentage"');
    expect(markup).toContain('data-orthographic="true"');
    expect(markup).toContain('data-camera-zoom="1.25"');
  });

  it("uses the Canvas perspective camera without importing a second control wrapper", () => {
    const markup = renderToStaticMarkup(
      <Battlefield world={createScenario("engagement", 12)} faction="OPFOR" camera="perspective" />,
    );

    expect(markup).toContain('data-orthographic="false"');
    expect(markup).toContain('data-camera-fov="48"');
  });

  it("invalidates only from control changes and removes every listener on cleanup", () => {
    controlsRuntime.instances.length = 0;
    controlsRuntime.invalidate.mockClear();
    const cleanup = attachEventDrivenOrbitControls(
      controlsRuntime.camera as never,
      controlsRuntime.domElement as never,
      controlsRuntime.invalidate,
    );
    const controls = controlsRuntime.instances[0] as MockOrbitControls;

    expect(controls.camera).toBe(controlsRuntime.camera);
    expect(controls.domElement).toBe(controlsRuntime.domElement);
    expect(controls.target.set).toHaveBeenCalledWith(0, 0, 0);
    expect(controls.maxPolarAngle).toBeCloseTo(Math.PI / 2.1);
    expect(controls.enableDamping).toBe(false);
    expect(controls.update).toHaveBeenCalledOnce();
    expect(controls.addEventListener).toHaveBeenCalledWith("change", controlsRuntime.invalidate);
    expect(controlsRuntime.invalidate).toHaveBeenCalledOnce();

    controls.listeners.get("change")?.();
    expect(controlsRuntime.invalidate).toHaveBeenCalledTimes(2);

    cleanup();
    expect(controls.removeEventListener).toHaveBeenCalledWith("change", controlsRuntime.invalidate);
    expect(controls.listeners.has("change")).toBe(false);
    expect(controls.dispose).toHaveBeenCalledOnce();
  });
});
