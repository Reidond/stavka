import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import {
  createScenario,
  createWorld,
  issueWaypoint,
  spawnGroup,
  stepWorldMany,
} from "../../packages/sim-core/src/index";

export const workloads = [
  "movement",
  "engagement",
  "mechanized",
  "groups-30",
  "groups-40",
  "groups-50",
] as const;
export const setup = (name: (typeof workloads)[number], seed = 12) => {
  if (!name.startsWith("groups-")) return createScenario(name, seed);
  const count = Number(name.slice(7));
  const world = createWorld({ seed });
  for (let index = 0; index < count; index += 1) {
    const id = `group_${index}`;
    const faction = index % 2 === 0 ? "BLUFOR" : "OPFOR";
    spawnGroup(world, {
      id,
      faction,
      template: "infantry_squad",
      position: [(index % 10) * 25, 0, Math.floor(index / 10) * 25],
      strength: 6,
    });
    issueWaypoint(world, id, index % 3 === 0 ? "sweep" : "attack", [125, 0, 50]);
  }
  return world;
};

export const benchmark = () =>
  workloads.map((name) => {
    stepWorldMany(setup(name), 1_000);
    const times: number[] = [];
    let digest = "";
    for (let run = 0; run < 7; run += 1) {
      const world = setup(name);
      const start = performance.now();
      stepWorldMany(world, 10_000);
      times.push(performance.now() - start);
      digest = createHash("sha256").update(JSON.stringify(world)).digest("hex");
    }
    times.sort((a, b) => a - b);
    return {
      workload: name,
      steps: 10_000,
      medianMs: Number(times[3]!.toFixed(2)),
      minMs: Number(times[0]!.toFixed(2)),
      digest,
    };
  });
