import { Canvas, useThree } from "@react-three/fiber";
import { Html } from "@react-three/drei/web/Html";
import type { SimWorldState } from "@stavka/sim-core";
import { useEffect, useMemo, useState } from "react";
import { Button } from "@cloudflare/kumo/components/button";
import { Crosshair } from "@phosphor-icons/react";
import * as THREE from "three";
import { OrbitControls as ThreeOrbitControls } from "three/examples/jsm/controls/OrbitControls.js";

import { poligonVisualizationPalette } from "./poligon-ui";

const MAX_POLAR_ANGLE = Math.PI / 2.1;

export const attachEventDrivenOrbitControls = (
  camera: THREE.Camera,
  domElement: HTMLElement,
  invalidate: () => void,
  target = new THREE.Vector3(),
): (() => void) => {
  const controls = new ThreeOrbitControls(camera, domElement);
  controls.target.set(target.x, target.y, target.z);
  controls.maxPolarAngle = MAX_POLAR_ANGLE;
  controls.enableDamping = false;
  controls.addEventListener("change", invalidate);
  controls.update();
  invalidate();

  return () => {
    controls.removeEventListener("change", invalidate);
    controls.dispose();
  };
};

export const battlefieldFocus = (world: SimWorldState) => {
  const positions = [
    ...Object.values(world.groups).flatMap((group) =>
      group.order ? [group.position, group.order.destination] : [group.position],
    ),
    ...Object.values(world.vehicles).map((vehicle) => vehicle.position),
    ...Object.values(world.objectives).map((objective) => objective.position),
  ];
  if (!positions.length) return undefined;
  const xs = positions.map((position) => position[0]);
  const zs = positions.map((position) => position[2]);
  const minX = Math.min(...xs),
    maxX = Math.max(...xs),
    minZ = Math.min(...zs),
    maxZ = Math.max(...zs);
  return {
    target: new THREE.Vector3(
      (minX + maxX - (world.terrain.width - 1) * world.terrain.cellSizeMeters) / 2,
      0,
      (minZ + maxZ - (world.terrain.height - 1) * world.terrain.cellSizeMeters) / 2,
    ),
    radius: Math.hypot(Math.max(100, (maxX - minX) / 2), Math.max(100, (maxZ - minZ) / 2), 40),
  };
};

export const fitBattlefieldCamera = (
  camera: THREE.Camera,
  size: { readonly width: number; readonly height: number },
  terrain: SimWorldState["terrain"],
  focus?: { readonly target: THREE.Vector3; readonly radius: number },
) => {
  const halfWidth = ((terrain.width - 1) * terrain.cellSizeMeters) / 2;
  const halfDepth = ((terrain.height - 1) * terrain.cellSizeMeters) / 2;
  const radius = focus?.radius ?? Math.hypot(halfWidth, halfDepth, 40);
  const target = focus?.target ?? new THREE.Vector3();
  const direction = new THREE.Vector3(1, 1.2, 1).normalize();
  if (camera instanceof THREE.PerspectiveCamera) {
    camera.aspect = size.width / Math.max(1, size.height);
    const vertical = THREE.MathUtils.degToRad(camera.fov);
    const horizontal = 2 * Math.atan(Math.tan(vertical / 2) * camera.aspect);
    const distance = (radius / Math.sin(Math.min(vertical, horizontal) / 2)) * 1.12;
    camera.position.copy(direction.multiplyScalar(distance).add(target));
    camera.near = 1;
    camera.far = distance + radius * 3;
    camera.updateProjectionMatrix();
  } else if (camera instanceof THREE.OrthographicCamera) {
    camera.left = -size.width / 2;
    camera.right = size.width / 2;
    camera.top = size.height / 2;
    camera.bottom = -size.height / 2;
    camera.zoom = Math.min(size.width, size.height) / (radius * 2.24);
    camera.position.copy(direction.multiplyScalar(radius * 3).add(target));
    camera.near = 1;
    camera.far = radius * 6;
    camera.updateProjectionMatrix();
  }
  camera.lookAt(target);
  camera.updateMatrixWorld();
  return target;
};

const EventDrivenOrbitControls = ({
  world,
  revision,
}: {
  readonly world: SimWorldState;
  readonly revision: number;
}) => {
  const { camera, gl, invalidate, size } = useThree();
  useEffect(() => {
    const target = fitBattlefieldCamera(camera, size, world.terrain, battlefieldFocus(world));
    return attachEventDrivenOrbitControls(camera, gl.domElement, invalidate, target);
  }, [
    camera,
    gl.domElement,
    invalidate,
    size.width,
    size.height,
    world.terrain.width,
    world.terrain.height,
    world.terrain.cellSizeMeters,
    revision,
  ]);
  return null;
};

const Terrain = ({ world }: { readonly world: SimWorldState }) => {
  const geometry = useMemo(() => {
    const { terrain } = world;
    const width = (terrain.width - 1) * terrain.cellSizeMeters;
    const height = (terrain.height - 1) * terrain.cellSizeMeters;
    const plane = new THREE.PlaneGeometry(width, height, terrain.width - 1, terrain.height - 1);
    const position = plane.attributes.position;
    if (position) {
      for (let index = 0; index < position.count; index += 1) {
        const sample = terrain.samples[index] ?? 0;
        position.setZ(index, sample === -256 ? -8 : sample * 0.12);
      }
      position.needsUpdate = true;
    }
    plane.computeVertexNormals();
    return plane;
  }, [
    world.terrain.cellSizeMeters,
    world.terrain.contentHash,
    world.terrain.height,
    world.terrain.width,
  ]);
  useEffect(() => () => geometry.dispose(), [geometry]);
  return (
    <mesh geometry={geometry} rotation={[-Math.PI / 2, 0, 0]} receiveShadow>
      <meshStandardMaterial
        color={poligonVisualizationPalette.terrain}
        wireframe
        opacity={0.86}
        transparent
      />
    </mesh>
  );
};

const Units = ({ world, faction }: { readonly world: SimWorldState; readonly faction: string }) => {
  const offsetX = ((world.terrain.width - 1) * world.terrain.cellSizeMeters) / 2;
  const offsetZ = ((world.terrain.height - 1) * world.terrain.cellSizeMeters) / 2;
  return (
    <>
      {Object.values(world.groups).map((group) => {
        const friendly = group.faction === faction;
        const gridX = Math.floor(group.position[0] / world.terrain.cellSizeMeters);
        const gridZ = Math.floor(group.position[2] / world.terrain.cellSizeMeters);
        const sample = world.terrain.samples[gridZ * world.terrain.width + gridX] ?? 0;
        const elevation = sample === -256 ? -8 : sample * 0.12;
        const position: [number, number, number] = [
          group.position[0] - offsetX,
          elevation + 12,
          group.position[2] - offsetZ,
        ];
        return (
          <group key={group.id} position={position}>
            <Html position={[0, 24, 0]} center style={{ pointerEvents: "none" }}>
              <div
                className="rounded-md bg-kumo-contrast/90 px-2 py-1 text-center text-xs whitespace-nowrap text-kumo-inverse"
                data-3d-unit={group.id}
              >
                <strong>{group.id}</strong>
                <span className="block text-[10px]">
                  {group.faction} · {group.agents.length}/{group.maxStrength}
                </span>
              </div>
            </Html>
            <mesh castShadow>
              <cylinderGeometry args={[7, 7, 12, 10]} />
              <meshBasicMaterial
                color={
                  friendly
                    ? poligonVisualizationPalette.friendly
                    : poligonVisualizationPalette.hostile
                }
              />
            </mesh>
            {group.status === "engaged" ? (
              <mesh rotation={[-Math.PI / 2, 0, 0]}>
                <ringGeometry args={[8, 11, 24]} />
                <meshBasicMaterial
                  color={poligonVisualizationPalette.hostile}
                  transparent
                  opacity={0.7}
                />
              </mesh>
            ) : null}
            {group.order ? (
              <mesh
                position={[
                  group.order.destination[0] - group.position[0],
                  2,
                  group.order.destination[2] - group.position[2],
                ]}
              >
                <coneGeometry args={[3, 8, 8]} />
                <meshStandardMaterial color={poligonVisualizationPalette.objective} />
              </mesh>
            ) : null}
          </group>
        );
      })}
    </>
  );
};

export const Battlefield = ({
  world,
  faction,
  camera,
}: {
  readonly world: SimWorldState;
  readonly faction: string;
  readonly camera: "ortho" | "perspective";
}) => {
  const [revision, setRevision] = useState(0);
  return (
    <div className="relative size-full">
      <Canvas
        key={camera}
        orthographic={camera === "ortho"}
        camera={
          camera === "ortho"
            ? { position: [280, 360, 280], zoom: 1.25 }
            : { position: [280, 280, 280], fov: 48 }
        }
        shadows="percentage"
        frameloop="demand"
        dpr={[1, 1.5]}
        className="bg-kumo-contrast"
      >
        <ambientLight intensity={1.5} />
        <directionalLight position={[200, 400, 100]} intensity={2.5} castShadow />
        <Terrain world={world} />
        <Units world={world} faction={faction} />
        <EventDrivenOrbitControls world={world} revision={revision} />
      </Canvas>
      <div className="absolute top-3 right-3">
        <Button size="sm" onClick={() => setRevision((value) => value + 1)}>
          <Crosshair size={15} /> Fit battlefield
        </Button>
      </div>
    </div>
  );
};
