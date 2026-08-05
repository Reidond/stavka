import { useQuery } from "@tanstack/react-query";
import { createFileRoute, useNavigate, type UseNavigateResult } from "@tanstack/react-router";
import { Effect, Schema } from "effect";
import { useEffect, useMemo, useState } from "react";
import { useAgent } from "agents/react";
import {
  DataTable,
  Button,
  FigureFrame,
  LogFeed,
  MapLegend,
  OrderCallout,
  SchemaForm,
  Stamp,
  StatusChip,
  TimeScrubber,
  type ColumnDef,
} from "@stavka/ui";
import type { SimGroup } from "@stavka/sim-core";

import { Battlefield } from "../components/battlefield";
import { CommanderCostDashboard } from "../components/commander-cost-dashboard";
import { useOfflineSimHost } from "../offline-sim-host";
import { simWorldAgentName } from "../scenario-identity";
import type { PoligonState, SimWorld } from "../sim-world";

const SearchSeed = Schema.Union([Schema.Number, Schema.NumberFromString]).check(
  Schema.isInt(),
  Schema.isBetween({ minimum: 1, maximum: 2_147_483_647 }),
);

const SearchTimeScale = Schema.Union([
  Schema.Literals([1, 10, 100]),
  Schema.Literals(["1", "10", "100"]).transform([1, 10, 100]),
]);

const SearchSchema = Schema.Struct({
  scenario: Schema.Literals(["movement", "engagement", "mechanized"]).pipe(
    Schema.withDecodingDefaultType(Effect.succeed("engagement")),
  ),
  seed: SearchSeed.pipe(Schema.withDecodingDefaultType(Effect.succeed(12))),
  time_scale: SearchTimeScale.pipe(Schema.withDecodingDefaultType(Effect.succeed(10))),
  camera: Schema.Literals(["ortho", "perspective"]).pipe(
    Schema.withDecodingDefaultType(Effect.succeed("ortho")),
  ),
  doctrine: Schema.Literals(["balanced", "aggressive", "defensive"]).pipe(
    Schema.withDecodingDefaultType(Effect.succeed("balanced")),
  ),
  mode: Schema.Literals(["single", "versus"]).pipe(
    Schema.withDecodingDefaultType(Effect.succeed("single")),
  ),
  host: Schema.Literals(["agent", "offline"]).pipe(
    Schema.withDecodingDefaultType(Effect.succeed("agent")),
  ),
});

export const decodePoligonSearch = Schema.decodeUnknownSync(SearchSchema);

const FormSchema = Schema.Struct({
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

export const Route = createFileRoute("/")({
  validateSearch: Schema.toStandardSchemaV1(SearchSchema),
  component: PoligonPage,
});

const groupColumns: ColumnDef<SimGroup, unknown>[] = [
  { accessorKey: "id", header: "Group" },
  { accessorKey: "faction", header: "Faction" },
  { accessorKey: "status", header: "Status" },
  {
    id: "strength",
    header: "Strength",
    cell: ({ row }) => `${row.original.agents.length}/${row.original.maxStrength}`,
  },
  {
    id: "position",
    header: "Position",
    cell: ({ row }) => row.original.position.map((value) => value.toFixed(0)).join(" · "),
  },
];

type PoligonSearch = typeof SearchSchema.Type;
type PoligonNavigate = UseNavigateResult<"/">;

function PoligonPage() {
  const search = Route.useSearch();
  const navigate = useNavigate({ from: "/" });
  return <PoligonHost search={search} navigate={navigate} />;
}

export const PoligonHost = ({
  search,
  navigate,
}: {
  readonly search: PoligonSearch;
  readonly navigate: PoligonNavigate;
}) =>
  search.host === "offline" ? (
    <OfflinePoligonPage
      key={`offline-${search.scenario}-${search.seed}-${search.doctrine}-${search.time_scale}-${search.mode}`}
      search={search}
      navigate={navigate}
    />
  ) : (
    <AgentPoligonPage search={search} navigate={navigate} />
  );

const AgentPoligonPage = ({
  search,
  navigate,
}: {
  readonly search: PoligonSearch;
  readonly navigate: PoligonNavigate;
}) => {
  const name = simWorldAgentName({
    scenario: search.scenario,
    seed: search.seed,
    doctrine: search.doctrine,
    timeScale: search.time_scale,
    mode: search.mode,
  });
  const agent = useAgent<SimWorld, PoligonState>({ agent: "sim-world", name });
  const state = agent.state;
  const [accessMode, setAccessMode] = useState<"loading" | "operator" | "spectator">("loading");
  const [controlError, setControlError] = useState<string>();
  const canOperate = accessMode === "operator";
  const health = useQuery({
    queryKey: ["poligon-health"],
    queryFn: async () => {
      const response = await fetch("/healthz");
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return response.json() as Promise<{ ok: boolean; fixed_step_ms: number }>;
    },
  });

  useEffect(() => {
    let active = true;
    setAccessMode("loading");
    void agent.stub.getCapabilities().then(
      ({ canOperate: permitted }) => {
        if (active) setAccessMode(permitted ? "operator" : "spectator");
      },
      (error: unknown) => {
        if (!active) return;
        setAccessMode("spectator");
        setControlError(
          error instanceof Error ? error.message : "Unable to read simulation capabilities",
        );
      },
    );
    return () => {
      active = false;
    };
  }, [agent]);

  useEffect(() => {
    if (!canOperate) return;
    void agent.stub
      .configure({
        scenario: search.scenario,
        seed: search.seed,
        doctrine: search.doctrine,
        timeScale: search.time_scale as 1 | 10 | 100,
        mode: search.mode,
      })
      .catch((error: unknown) => {
        setControlError(error instanceof Error ? error.message : "Unable to configure simulation");
      });
  }, [
    agent,
    canOperate,
    search.doctrine,
    search.mode,
    search.scenario,
    search.seed,
    search.time_scale,
  ]);

  const runControl = (operation: Promise<unknown>): void => {
    setControlError(undefined);
    void operation.catch((error: unknown) => {
      setControlError(error instanceof Error ? error.message : "Simulation control failed");
    });
  };

  const updateTimeScale = (speed: number): void => {
    setControlError(undefined);
    void navigate({
      search: {
        scenario: search.scenario,
        seed: String(search.seed),
        time_scale: String(speed) as "1" | "10" | "100",
        camera: search.camera,
        doctrine: search.doctrine,
        mode: search.mode,
        host: search.host,
      },
    }).catch((error: unknown) => {
      setControlError(error instanceof Error ? error.message : "Unable to update scenario URL");
    });
  };

  const groups = useMemo(() => (state ? Object.values(state.world.groups) : []), [state]);
  if (!state) {
    return (
      <main className="poligon-shell">
        <Stamp tone="pending">Connecting to SimWorld</Stamp>
      </main>
    );
  }
  const commanderFactions = state.mode === "versus" ? ["OPFOR", "BLUFOR"] : [state.faction];

  return (
    <main className="poligon-shell">
      <header className="mb-4 flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="stavka-grid-label m-0">Stavka / proving ground / {name}</p>
          <h1 className="m-0 font-display text-5xl tracking-tight uppercase">Poligon</h1>
        </div>
        <div className="flex flex-wrap items-center justify-end gap-2">
          <Button size="sm" onClick={() => void navigate({ to: "/replay" })}>
            Replay import
          </Button>
          <StatusChip tone={accessMode === "operator" ? "works" : "pending"}>
            {accessMode === "loading" ? "checking access" : accessMode}
          </StatusChip>
          <StatusChip tone={health.data?.ok ? "works" : "pending"}>100 ms fixed step</StatusChip>
          {commanderFactions.map((faction) => {
            const commander = state.commanders[faction];
            return (
              <StatusChip key={faction} tone={commander?.connected ? "works" : "broken"}>
                {faction}{" "}
                {commander?.connected
                  ? `${commander.mode}${commander.doctrine ? ` / ${commander.doctrine}` : ""}`
                  : "offline"}
              </StatusChip>
            );
          })}
        </div>
      </header>

      <div className="poligon-layout">
        <section className="min-w-0 space-y-4">
          <FigureFrame
            caption={`${state.scenario} · seed ${state.seed} · ${state.world.tick} fixed steps`}
          >
            <div className="relative min-h-136">
              <Battlefield world={state.world} faction={state.faction} camera={search.camera} />
              <div className="pointer-events-none absolute top-3 left-3 space-y-1">
                <Stamp tone={state.paused ? "pending" : "works"}>
                  {state.paused ? "Paused" : `Running ×${state.timeScale}`}
                </Stamp>
              </div>
            </div>
          </FigureFrame>
          <MapLegend
            items={[
              { label: state.faction, tone: "friendly" },
              { label: "opposition", tone: "enemy" },
              { label: "terrain", tone: "terrain" },
              { label: "waypoint", tone: "objective" },
            ]}
          />
          <fieldset disabled={!canOperate} className="m-0 border-0 p-0">
            <TimeScrubber
              paused={state.paused}
              speed={state.timeScale}
              time={state.world.timeMs / 1_000}
              maxTime={Math.max(120, state.world.timeMs / 1_000)}
              onPausedChange={(paused) => runControl(agent.stub.setPaused(paused))}
              onStep={() => runControl(agent.stub.stepOnce())}
              onSpeedChange={updateTimeScale}
            />
          </fieldset>
          <DataTable data={groups} columns={groupColumns} getRowId={(group) => group.id} />
        </section>

        <aside className="space-y-4">
          <section className="stavka-panel p-4">
            <h2 className="mt-0 font-display text-2xl uppercase">Reproduction case</h2>
            <fieldset disabled={!canOperate} className="m-0 border-0 p-0">
              <SchemaForm
                schema={FormSchema}
                defaultValues={{
                  scenario: search.scenario,
                  seed: search.seed,
                  time_scale: String(search.time_scale) as "1" | "10" | "100",
                  camera: search.camera,
                  doctrine: search.doctrine,
                  mode: search.mode,
                  host: search.host,
                }}
                fields={[
                  {
                    name: "scenario",
                    label: "Scenario",
                    type: "select",
                    options: [
                      { value: "movement", label: "Forced Move Drill" },
                      { value: "engagement", label: "Six versus Four" },
                      { value: "mechanized", label: "Mechanized Lifecycle" },
                    ],
                  },
                  { name: "seed", label: "Seed", type: "number" },
                  {
                    name: "time_scale",
                    label: "Time scale",
                    type: "select",
                    options: [
                      { value: "1", label: "×1" },
                      { value: "10", label: "×10" },
                      { value: "100", label: "×100" },
                    ],
                  },
                  {
                    name: "camera",
                    label: "Camera",
                    type: "select",
                    options: [
                      { value: "ortho", label: "Orthographic" },
                      { value: "perspective", label: "Perspective" },
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
                    label: "Commander mode",
                    type: "select",
                    options: [
                      { value: "single", label: "Single commander" },
                      { value: "versus", label: "Commander versus commander" },
                    ],
                  },
                  {
                    name: "host",
                    label: "Simulation host",
                    type: "select",
                    options: [
                      { value: "agent", label: "Durable Agent" },
                      { value: "offline", label: "Browser offline" },
                    ],
                  },
                ]}
                submitLabel="Load exact case"
                onSubmit={async (value) => {
                  await navigate({
                    search: {
                      scenario: String(value.scenario) as "movement" | "engagement" | "mechanized",
                      seed: String(value.seed),
                      time_scale: String(value.time_scale) as "1" | "10" | "100",
                      camera: String(value.camera) as "ortho" | "perspective",
                      doctrine: String(value.doctrine) as "balanced" | "aggressive" | "defensive",
                      mode: String(value.mode) as "single" | "versus",
                      host: String(value.host) as "agent" | "offline",
                    },
                  });
                }}
              />
            </fieldset>
          </section>

          {controlError ? (
            <OrderCallout title="Simulation controls" priority="urgent">
              {controlError}
            </OrderCallout>
          ) : null}

          {commanderFactions.map((faction) => {
            const commander = state.commanders[faction];
            return commander?.lastError ? (
              <OrderCallout key={faction} title={`${faction} commander`} priority="urgent">
                {commander.lastError}
              </OrderCallout>
            ) : (
              <OrderCallout key={faction} title={`${faction} commander`}>
                {commander?.connected
                  ? `Tick ${commander.lastTickId}; next-hint ${commander.tickRateHint} ms.`
                  : "Set COMMANDER_URL and COMMANDER_API_KEY to close the full loop."}
              </OrderCallout>
            );
          })}

          <CommanderCostDashboard
            sources={commanderFactions.map((faction) => {
              const aggregates = state.commanders[faction]?.costAggregates;
              return {
                faction,
                ...(aggregates === undefined ? {} : { aggregates }),
              };
            })}
          />

          <section>
            <h2 className="font-display text-2xl uppercase">Decision feed</h2>
            <LogFeed
              items={state.decisions}
              getKey={(item) => item.key}
              renderItem={(item) => (
                <div className="space-y-1">
                  <strong className="block">
                    {item.faction} · {item.summary}
                  </strong>
                  <span className="block font-data text-xs">
                    {item.timestamp} · {item.model} · {item.latency_ms.toFixed(0)} ms · $
                    {item.cost_usd.toFixed(4)}
                  </span>
                </div>
              )}
              height={280}
            />
          </section>

          <section>
            <h2 className="font-display text-2xl uppercase">Local link log</h2>
            <LogFeed
              items={state.logs}
              getKey={(item) => item.id}
              renderItem={(item) => (
                <span>
                  <strong>T+{item.at.toFixed(1)}</strong> · {item.level.toUpperCase()} ·{" "}
                  {item.faction ? `${item.faction} · ` : ""}
                  {item.message}
                </span>
              )}
              height={360}
            />
          </section>
        </aside>
      </div>
    </main>
  );
};

const OfflinePoligonPage = ({
  search,
  navigate,
}: {
  readonly search: PoligonSearch;
  readonly navigate: PoligonNavigate;
}) => {
  const identity = {
    scenario: search.scenario,
    seed: search.seed,
    doctrine: search.doctrine,
    timeScale: search.time_scale,
    mode: search.mode,
  } as const;
  const name = `${simWorldAgentName(identity)}-browser`;
  const { state, setPaused, stepOnce, reset } = useOfflineSimHost(identity);
  const [controlError, setControlError] = useState<string>();
  const groups = useMemo(() => Object.values(state.world.groups), [state.world.groups]);

  const updateTimeScale = (speed: number): void => {
    setControlError(undefined);
    void navigate({
      search: {
        scenario: search.scenario,
        seed: String(search.seed),
        time_scale: String(speed) as "1" | "10" | "100",
        camera: search.camera,
        doctrine: search.doctrine,
        mode: search.mode,
        host: "offline",
      },
    }).catch((error: unknown) => {
      setControlError(error instanceof Error ? error.message : "Unable to update scenario URL");
    });
  };

  return (
    <main className="poligon-shell">
      <header className="mb-4 flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="stavka-grid-label m-0">Stavka / proving ground / {name}</p>
          <h1 className="m-0 font-display text-5xl tracking-tight uppercase">Poligon</h1>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" onClick={() => void navigate({ to: "/replay" })}>
            Replay import
          </Button>
          <StatusChip tone="works">browser offline</StatusChip>
          <StatusChip tone="works">100 ms local fixed step</StatusChip>
          <StatusChip tone="pending">no commander / no network</StatusChip>
        </div>
      </header>

      <div className="poligon-layout">
        <section className="min-w-0 space-y-4">
          <FigureFrame
            caption={`${state.scenario} · seed ${state.seed} · ${state.world.tick} fixed steps · browser host`}
          >
            <div className="relative min-h-136">
              <Battlefield world={state.world} faction={state.faction} camera={search.camera} />
              <div className="pointer-events-none absolute top-3 left-3 space-y-1">
                <Stamp tone={state.paused ? "pending" : "works"}>
                  {state.paused ? "Paused offline" : `Running offline ×${state.timeScale}`}
                </Stamp>
              </div>
            </div>
          </FigureFrame>
          <MapLegend
            items={[
              { label: state.faction, tone: "friendly" },
              { label: "opposition", tone: "enemy" },
              { label: "terrain", tone: "terrain" },
              { label: "waypoint", tone: "objective" },
            ]}
          />
          <TimeScrubber
            paused={state.paused}
            speed={state.timeScale}
            time={state.world.timeMs / 1_000}
            maxTime={Math.max(120, state.world.timeMs / 1_000)}
            onPausedChange={setPaused}
            onStep={stepOnce}
            onSpeedChange={updateTimeScale}
          />
          <div className="flex justify-end">
            <Button onClick={reset}>Reset exact seed</Button>
          </div>
          <DataTable data={groups} columns={groupColumns} getRowId={(group) => group.id} />
        </section>

        <aside className="space-y-4">
          <OrderCallout title="Browser-local simulation">
            Deterministic sim-core runs in this tab. Agent WebSocket and Commander networking are
            disabled.
          </OrderCallout>

          {controlError ? (
            <OrderCallout title="Offline controls" priority="urgent">
              {controlError}
            </OrderCallout>
          ) : null}

          <section className="stavka-panel p-4">
            <h2 className="mt-0 font-display text-2xl uppercase">Reproduction case</h2>
            <SchemaForm
              schema={FormSchema}
              defaultValues={{
                scenario: search.scenario,
                seed: search.seed,
                time_scale: String(search.time_scale) as "1" | "10" | "100",
                camera: search.camera,
                doctrine: search.doctrine,
                mode: search.mode,
                host: search.host,
              }}
              fields={[
                {
                  name: "scenario",
                  label: "Scenario",
                  type: "select",
                  options: [
                    { value: "movement", label: "Forced Move Drill" },
                    { value: "engagement", label: "Six versus Four" },
                    { value: "mechanized", label: "Mechanized Lifecycle" },
                  ],
                },
                { name: "seed", label: "Seed", type: "number" },
                {
                  name: "time_scale",
                  label: "Time scale",
                  type: "select",
                  options: [
                    { value: "1", label: "×1" },
                    { value: "10", label: "×10" },
                    { value: "100", label: "×100" },
                  ],
                },
                {
                  name: "camera",
                  label: "Camera",
                  type: "select",
                  options: [
                    { value: "ortho", label: "Orthographic" },
                    { value: "perspective", label: "Perspective" },
                  ],
                },
                {
                  name: "doctrine",
                  label: "Doctrine identity",
                  type: "select",
                  options: [
                    { value: "balanced", label: "Balanced" },
                    { value: "aggressive", label: "Aggressive" },
                    { value: "defensive", label: "Defensive" },
                  ],
                },
                {
                  name: "mode",
                  label: "Scenario identity mode",
                  type: "select",
                  options: [
                    { value: "single", label: "Single" },
                    { value: "versus", label: "Versus" },
                  ],
                },
                {
                  name: "host",
                  label: "Simulation host",
                  type: "select",
                  options: [
                    { value: "agent", label: "Durable Agent" },
                    { value: "offline", label: "Browser offline" },
                  ],
                },
              ]}
              submitLabel="Load exact case"
              onSubmit={async (value) => {
                await navigate({
                  search: {
                    scenario: String(value.scenario) as "movement" | "engagement" | "mechanized",
                    seed: String(value.seed),
                    time_scale: String(value.time_scale) as "1" | "10" | "100",
                    camera: String(value.camera) as "ortho" | "perspective",
                    doctrine: String(value.doctrine) as "balanced" | "aggressive" | "defensive",
                    mode: String(value.mode) as "single" | "versus",
                    host: String(value.host) as "agent" | "offline",
                  },
                });
              }}
            />
          </section>

          <section>
            <h2 className="font-display text-2xl uppercase">Local simulation log</h2>
            <LogFeed
              items={state.logs}
              getKey={(item) => item.id}
              renderItem={(item) => (
                <span>
                  <strong>T+{item.at.toFixed(1)}</strong> · {item.level.toUpperCase()} ·{" "}
                  {item.message}
                </span>
              )}
              height={240}
            />
          </section>
        </aside>
      </div>
    </main>
  );
};
