import { Canvas, useThree } from "@react-three/fiber";
import type { SimWorldState } from "@stavka/sim-core";
import { useEffect, useMemo } from "react";
import * as THREE from "three";
import { OrbitControls as ThreeOrbitControls } from "three/examples/jsm/controls/OrbitControls.js";

import { poligonVisualizationPalette } from "./poligon-ui";

const MAX_POLAR_ANGLE = Math.PI / 2.1;

export const attachEventDrivenOrbitControls = (
  camera: THREE.Camera,
  domElement: HTMLElement,
  invalidate: () => void,
): (() => void) => {
  const controls = new ThreeOrbitControls(camera, domElement);
  controls.target.set(0, 0, 0);
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

const EventDrivenOrbitControls = () => {
  const { camera, gl, invalidate } = useThree();
  useEffect(
    () => attachEventDrivenOrbitControls(camera, gl.domElement, invalidate),
    [camera, gl.domElement, invalidate],
  );
  return null;
};

const Terrain = ({ world }: { readonly world: SimWorldState }) => {
  const geometry = useMemo(() => {
    const { terrain } = world;
    const width = terrain.width * terrain.cellSizeMeters;
    const height = terrain.height * terrain.cellSizeMeters;
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
  const offsetX = (world.terrain.width * world.terrain.cellSizeMeters) / 2;
  const offsetZ = (world.terrain.height * world.terrain.cellSizeMeters) / 2;
  return (
    <>
      {Object.values(world.groups).map((group) => {
        const friendly = group.faction === faction;
        const position: [number, number, number] = [
          group.position[0] - offsetX,
          10,
          group.position[2] - offsetZ,
        ];
        return (
          <group key={group.id} position={position}>
            <mesh castShadow>
              <cylinderGeometry args={[4, 4, 8, 10]} />
              <meshStandardMaterial
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
}) => (
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
    className="min-h-136 bg-kumo-contrast"
  >
    <ambientLight intensity={1.5} />
    <directionalLight position={[200, 400, 100]} intensity={2.5} castShadow />
    <Terrain world={world} />
    <Units world={world} faction={faction} />
    <gridHelper
      args={[640, 32, poligonVisualizationPalette.grid, poligonVisualizationPalette.grid]}
      position={[0, 1, 0]}
    />
    <EventDrivenOrbitControls />
  </Canvas>
);
