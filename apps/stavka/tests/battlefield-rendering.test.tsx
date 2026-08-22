import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { createScenario } from "@stavka/sim-core";

const controlsRuntime = vi.hoisted(() => ({
  camera: {},
  domElement: {},
  instances: [] as unknown[],
  invalidate: vi.fn(),
}));

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
  }),
}));

const { Battlefield, attachEventDrivenOrbitControls } =
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
