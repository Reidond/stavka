import { Schema } from "effect";

import { DoctrineName, ScenarioName, SimulationMode, TimeScale } from "./sim-world-contract";

export interface ScenarioIdentity {
  readonly scenario: ScenarioName;
  readonly seed: number;
  readonly doctrine: DoctrineName;
  readonly timeScale: TimeScale;
  readonly mode: SimulationMode;
}

const ScenarioIdentitySchema = Schema.Struct({
  scenario: ScenarioName,
  seed: Schema.Number.check(
    Schema.isInt(),
    Schema.isBetween({ minimum: 1, maximum: 2_147_483_647 }),
  ),
  doctrine: DoctrineName,
  timeScale: TimeScale,
  mode: SimulationMode,
});

const decodeScenarioIdentity = Schema.decodeUnknownSync(ScenarioIdentitySchema);

/** Every simulation-affecting URL selector gets an isolated Durable Object. */
export const simWorldAgentName = (identity: ScenarioIdentity): string =>
  [
    identity.scenario,
    identity.seed,
    identity.doctrine,
    `x${identity.timeScale}`,
    identity.mode,
  ].join("-");

/** Decode the canonical Agent identity. Invalid or non-canonical names fail closed. */
export const parseSimWorldAgentName = (name: string): ScenarioIdentity => {
  try {
    const [scenario, encodedSeed, doctrine, encodedTimeScale, mode, ...extra] = name.split("-");
    if (extra.length > 0 || encodedTimeScale?.startsWith("x") !== true) {
      throw new Error("Invalid segment count");
    }
    const identity = decodeScenarioIdentity({
      scenario,
      seed: Number(encodedSeed),
      doctrine,
      timeScale: Number(encodedTimeScale.slice(1)),
      mode,
    });
    if (simWorldAgentName(identity) !== name) throw new Error("Non-canonical identity");
    return identity;
  } catch {
    throw new Error(`Invalid SimWorld agent name: ${name}`);
  }
};

/** Commander sessions also include faction because it changes visibility and command ownership. */
export const commanderSessionId = (
  identity: ScenarioIdentity & { readonly faction: string },
): string =>
  [
    "poligon",
    identity.scenario,
    identity.seed,
    encodeURIComponent(identity.faction.toLowerCase()),
    identity.doctrine,
    `x${identity.timeScale}`,
    identity.mode,
  ].join("-");
