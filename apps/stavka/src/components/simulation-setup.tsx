import { Button } from "@cloudflare/kumo/components/button";
import { ArrowCounterClockwise, ArrowSquareOut } from "@phosphor-icons/react";
import { Schema } from "effect";

import { PoligonSettingsForm, type PoligonFormField } from "./poligon-ui";

export const scenarioTitles = {
  engagement: "Six versus Four",
  movement: "Forced Move Drill",
  mechanized: "Mechanized Lifecycle",
} as const;

export const doctrineLabels: Partial<Record<string, string>> = {
  balanced: "Balanced",
  aggressive: "Aggressive",
  defensive: "Defensive",
};

export const hostLabels = {
  agent: "Cloud agent",
  offline: "Browser offline",
} as const;

export const SetupFormSchema = Schema.Struct({
  scenario: Schema.Literals(["movement", "engagement", "mechanized"]),
  seed: Schema.Number.check(
    Schema.isInt(),
    Schema.isBetween({ minimum: 1, maximum: 2_147_483_647 }),
  ),
  time_scale: Schema.Literals(["1", "10", "100"]),
  camera: Schema.Literals(["ortho", "perspective"]),
  doctrine: Schema.Literals(["balanced", "aggressive", "defensive"]),
  mode: Schema.Literals(["single", "versus"]),
  host: Schema.Literals(["agent", "offline"]),
});
export type SimulationSetupValue = typeof SetupFormSchema.Type;

const scenarioFields: readonly PoligonFormField[] = [
  {
    name: "scenario",
    label: "Scenario",
    type: "select",
    options: [
      { value: "engagement", label: scenarioTitles.engagement },
      { value: "movement", label: scenarioTitles.movement },
      { value: "mechanized", label: scenarioTitles.mechanized },
    ],
  },
  { name: "seed", label: "Seed", type: "number" },
  {
    name: "time_scale",
    label: "Time scale (session configuration)",
    type: "select",
    options: [
      { value: "1", label: "×1" },
      { value: "10", label: "×10" },
      { value: "100", label: "×100" },
    ],
  },
  {
    name: "doctrine",
    label: "Doctrine",
    type: "select",
    options: [
      { value: "balanced", label: "Balanced" },
      { value: "aggressive", label: "Aggressive" },
      { value: "defensive", label: "Defensive" },
    ],
  },
  {
    name: "mode",
    label: "Commanders",
    type: "select",
    options: [
      { value: "single", label: "Single commander" },
      { value: "versus", label: "Versus (OPFOR and BLUFOR)" },
    ],
  },
  {
    name: "host",
    label: "Simulation host",
    type: "select",
    options: [
      { value: "agent", label: hostLabels.agent },
      { value: "offline", label: hostLabels.offline },
    ],
  },
];

export function SimulationSetupPanel({
  formKey,
  defaultValues,
  seed,
  canOperate,
  busy,
  onSubmit,
  onReset,
  onReplayImport,
}: {
  readonly formKey: string;
  readonly defaultValues: SimulationSetupValue;
  readonly seed: number;
  readonly canOperate: boolean;
  readonly busy: boolean;
  readonly onSubmit: (value: SimulationSetupValue) => void;
  readonly onReset?: (() => void) | undefined;
  readonly onReplayImport: () => void;
}) {
  return (
    <div className="simulation-setup">
      <p className="simulation-setup-note">
        Scenario, seed, doctrine, time scale, and commander mode form the reproducible run identity.
        Loading opens the simulation with that identity; the current run keeps its saved state.
      </p>
      <fieldset disabled={!canOperate || busy}>
        <PoligonSettingsForm
          key={formKey}
          schema={SetupFormSchema}
          defaultValues={defaultValues}
          fields={scenarioFields}
          submitLabel="Load scenario"
          onSubmit={onSubmit}
        />
      </fieldset>
      {canOperate ? null : (
        <p className="simulation-setup-note">
          Spectator access: loading another scenario and resetting are disabled.
        </p>
      )}
      <div className="simulation-setup-actions">
        {onReset ? (
          <Button
            size="sm"
            disabled={!canOperate || busy}
            icon={<ArrowCounterClockwise size={14} />}
            onClick={onReset}
          >
            Reset run to seed {seed}
          </Button>
        ) : null}
        <Button
          size="sm"
          variant="ghost"
          icon={<ArrowSquareOut size={14} />}
          onClick={onReplayImport}
        >
          Open replay import
        </Button>
      </div>
    </div>
  );
}
