import { createFileRoute, useNavigate, type UseNavigateResult } from "@tanstack/react-router";
import { Badge } from "@cloudflare/kumo/components/badge";
import { Banner } from "@cloudflare/kumo/components/banner";
import { Button } from "@cloudflare/kumo/components/button";
import { Tabs } from "@cloudflare/kumo/components/tabs";
import { Effect, Schema } from "effect";
import { useEffect, useMemo, useRef, useState } from "react";
import { useAgent } from "agents/react";
import {
  Clock,
  Crosshair,
  Pause,
  Play,
  SidebarSimple,
  SkipForward,
  SlidersHorizontal,
  X,
} from "@phosphor-icons/react";

import { CommanderCostDashboard } from "../components/commander-cost-dashboard";
import {
  SimulationCommanderStatus,
  SimulationDecisionList,
  SimulationEventLog,
  SimulationUnitList,
  inspectorTabLabels,
  isInspectorTab,
  type InspectorTab,
} from "../components/simulation-inspector";
import {
  SimulationSetupPanel,
  doctrineLabels,
  hostLabels,
  scenarioTitles,
  type SimulationSetupValue,
} from "../components/simulation-setup";
import { SimulationStage } from "../components/simulation-stage";
import { useOfflineSimHost } from "../offline-sim-host";
import { useRememberSimulation } from "../recent-sessions";
import { simWorldAgentName, commanderSessionId } from "../scenario-identity";
import { SessionAiAuthorization } from "../components/session-ai-authorization";
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

type PoligonSearch = typeof SearchSchema.Type;
type PoligonNavigate = UseNavigateResult<"/">;
type AccessMode = "loading" | "operator" | "spectator" | "offline";
type MobileView = "map" | "panel";

export const Route = createFileRoute("/simulations")({
  validateSearch: Schema.toStandardSchemaV1(SearchSchema),
  component: PoligonPage,
});

function PoligonPage() {
  const search = Route.useSearch();
  useRememberSimulation({ ...search, timeScale: search.time_scale }, "OPFOR", search.host);
  useRememberSimulation(
    { ...search, timeScale: search.time_scale },
    "BLUFOR",
    search.host,
    search.mode === "versus",
  );
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
  const [accessMode, setAccessMode] = useState<AccessMode>("loading");
  const [controlError, setControlError] = useState<string>();
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let active = true;
    setAccessMode("loading");
    void agent.stub.getCapabilities().then(
      ({ canOperate }) => {
        if (active) setAccessMode(canOperate ? "operator" : "spectator");
      },
      (error: unknown) => {
        if (active) {
          setAccessMode("spectator");
          setControlError(
            error instanceof Error ? error.message : "Unable to read simulation permissions",
          );
        }
      },
    );
    return () => {
      active = false;
    };
  }, [agent]);
  useEffect(() => {
    if (accessMode !== "operator") return;
    void agent.stub
      .configure({
        scenario: search.scenario,
        seed: search.seed,
        doctrine: search.doctrine,
        timeScale: search.time_scale,
        mode: search.mode,
      })
      .catch((error: unknown) =>
        setControlError(error instanceof Error ? error.message : "Unable to configure simulation"),
      );
  }, [
    accessMode,
    agent,
    search.scenario,
    search.seed,
    search.doctrine,
    search.time_scale,
    search.mode,
  ]);
  const runControl = (operation: Promise<unknown>) => {
    setControlError(undefined);
    setBusy(true);
    void operation
      .catch((error: unknown) =>
        setControlError(error instanceof Error ? error.message : "Simulation control failed"),
      )
      .finally(() => setBusy(false));
  };
  if (!agent.state) {
    return <SimulationConnecting search={search} accessMode={accessMode} error={controlError} />;
  }
  return (
    <SimulationWorkspace
      state={agent.state}
      search={search}
      navigate={navigate}
      accessMode={accessMode}
      busy={busy}
      controlError={controlError}
      onPausedChange={(paused) => runControl(agent.stub.setPaused(paused))}
      onStep={() => runControl(agent.stub.stepOnce())}
      onReset={() => runControl(agent.stub.resetScenario())}
    />
  );
};

const OfflinePoligonPage = ({
  search,
  navigate,
}: {
  readonly search: PoligonSearch;
  readonly navigate: PoligonNavigate;
}) => {
  const { state, setPaused, stepOnce, reset } = useOfflineSimHost({
    scenario: search.scenario,
    seed: search.seed,
    doctrine: search.doctrine,
    timeScale: search.time_scale,
    mode: search.mode,
  });
  return (
    <SimulationWorkspace
      state={state}
      search={search}
      navigate={navigate}
      accessMode="offline"
      busy={false}
      onPausedChange={setPaused}
      onStep={stepOnce}
      onReset={reset}
    />
  );
};

/** The run identity: everything that selects a reproducible simulation instance. */
const SimulationIdentity = ({
  scenario,
  seed,
  doctrine,
  mode,
  timeScale,
  host,
  faction,
}: {
  readonly scenario: PoligonSearch["scenario"];
  readonly seed: number;
  readonly doctrine: string;
  readonly mode: PoligonSearch["mode"];
  readonly timeScale: number;
  readonly host: PoligonSearch["host"];
  readonly faction?: string | undefined;
}) => (
  <div className="simulation-identity">
    <h2>{scenarioTitles[scenario]}</h2>
    <p className="simulation-identity-meta">
      <span>Seed {seed}</span>
      <span aria-hidden="true">·</span>
      <span>{doctrineLabels[doctrine] ?? doctrine} doctrine</span>
      <span aria-hidden="true">·</span>
      <span>
        {mode === "versus"
          ? "Versus: OPFOR vs BLUFOR"
          : faction
            ? `Single commander: ${faction}`
            : "Single commander"}
      </span>
      <span aria-hidden="true">·</span>
      <span>×{timeScale} time scale</span>
      <span aria-hidden="true">·</span>
      <span>{hostLabels[host]} host</span>
    </p>
  </div>
);

const accessBadge = (accessMode: AccessMode) =>
  accessMode === "operator" || accessMode === "offline" ? null : (
    <Badge variant={accessMode === "spectator" ? "warning" : "secondary"}>
      {accessMode === "loading" ? "Checking access" : "Read-only"}
    </Badge>
  );

const SimulationConnecting = ({
  search,
  accessMode,
  error,
}: {
  readonly search: PoligonSearch;
  readonly accessMode: AccessMode;
  readonly error: string | undefined;
}) => (
  <div className="poligon-shell simulation-workspace">
    <header className="simulation-topbar">
      <SimulationIdentity
        scenario={search.scenario}
        seed={search.seed}
        doctrine={search.doctrine}
        mode={search.mode}
        timeScale={search.time_scale}
        host={search.host}
      />
      <div className="simulation-topbar-actions">{accessBadge(accessMode)}</div>
    </header>
    {error ? (
      <div className="simulation-notices">
        <Banner variant="error" title="Connection failed" description={error} />
      </div>
    ) : null}
    <div className="simulation-connecting" role="status">
      <Crosshair size={28} />
      <strong>Connecting to simulation</strong>
      <p>Opening the saved state and checking your control permissions.</p>
    </div>
  </div>
);

function SimulationWorkspace({
  state,
  search,
  navigate,
  accessMode,
  busy,
  controlError,
  onPausedChange,
  onStep,
  onReset,
}: {
  readonly state: PoligonState;
  readonly search: PoligonSearch;
  readonly navigate: PoligonNavigate;
  readonly accessMode: AccessMode;
  readonly busy: boolean;
  readonly controlError?: string | undefined;
  readonly onPausedChange: (paused: boolean) => void;
  readonly onStep: () => void;
  readonly onReset?: (() => void) | undefined;
}) {
  const [tab, setTab] = useState<InspectorTab>("units");
  const [setupOpen, setSetupOpen] = useState(false);
  const [panelCollapsed, setPanelCollapsed] = useState(false);
  const [mobileView, setMobileView] = useState<MobileView>("map");
  const [selectedId, setSelectedId] = useState<string>();
  const [navigationError, setNavigationError] = useState<string>();
  const panelBodyRef = useRef<HTMLDivElement>(null);
  const setupButtonRef = useRef<HTMLButtonElement>(null);
  const groups = useMemo(() => Object.values(state.world.groups), [state.world.groups]);
  const objectives = useMemo(() => Object.values(state.world.objectives), [state.world.objectives]);
  const canOperate = accessMode === "operator" || accessMode === "offline";
  const offline = search.host === "offline";
  const factions = state.mode === "versus" ? ["OPFOR", "BLUFOR"] : [state.faction];
  const running = !state.paused;
  const notice = controlError ?? navigationError;
  const mobileMode = mobileView === "map" ? "map" : setupOpen ? "setup" : "inspect";

  const go = (next: Partial<PoligonSearch>) => {
    const merged = { ...search, ...next };
    setNavigationError(undefined);
    void navigate({
      to: "/simulations",
      search: {
        ...merged,
        seed: String(merged.seed),
        time_scale: String(merged.time_scale) as "1" | "10" | "100",
      },
    }).catch((error: unknown) =>
      setNavigationError(error instanceof Error ? error.message : "Navigation failed"),
    );
  };
  const openSetup = () => {
    setSetupOpen(true);
    setPanelCollapsed(false);
    setMobileView("panel");
  };
  const closeSetup = () => {
    setSetupOpen(false);
    window.requestAnimationFrame(() => {
      const button = setupButtonRef.current;
      if (button && button.offsetParent !== null) button.focus();
      else panelBodyRef.current?.focus();
    });
  };
  const showSelectedDetails = () => {
    setSetupOpen(false);
    setPanelCollapsed(false);
    setTab("units");
    setMobileView("panel");
    window.requestAnimationFrame(() => {
      const row = selectedId
        ? panelBodyRef.current?.querySelector<HTMLElement>(
            `[data-unit-row="${CSS.escape(selectedId)}"]`,
          )
        : undefined;
      (row ?? panelBodyRef.current)?.focus();
    });
  };
  const loadScenario = (value: SimulationSetupValue) => {
    go({ ...value, time_scale: Number(value.time_scale) as 1 | 10 | 100 });
    setSetupOpen(false);
    setMobileView("map");
  };
  useEffect(() => {
    if (setupOpen) panelBodyRef.current?.focus();
  }, [setupOpen]);

  return (
    <div
      className="poligon-shell simulation-workspace"
      data-view={mobileView}
      data-panel={panelCollapsed ? "collapsed" : "open"}
      onKeyDown={(event) => {
        if (event.key === "Escape" && setupOpen) {
          event.preventDefault();
          closeSetup();
        }
      }}
    >
      <header className="simulation-topbar">
        <SimulationIdentity
          scenario={state.scenario}
          seed={state.seed}
          doctrine={state.doctrine}
          mode={state.mode}
          timeScale={state.timeScale}
          host={search.host}
          faction={state.faction}
        />
        <div className="simulation-topbar-actions">
          {accessBadge(accessMode)}
          <Button
            ref={setupButtonRef}
            className="simulation-desktop-only"
            aria-expanded={setupOpen}
            {...(setupOpen ? { "aria-controls": "simulation-setup-panel" } : {})}
            icon={<SlidersHorizontal size={15} />}
            onClick={setupOpen ? closeSetup : openSetup}
          >
            Scenario…
          </Button>
        </div>
      </header>
      {notice || accessMode === "spectator" ? (
        <div className="simulation-notices">
          {notice ? (
            <Banner variant="error" title="Simulation controls" description={notice} />
          ) : null}
          {accessMode === "spectator" ? (
            <Banner
              variant="alert"
              title="Read-only simulation"
              description="This connection has spectator access. Operator permission is required to run, reset, or change the scenario."
            />
          ) : null}
        </div>
      ) : null}
      <div className="simulation-runbar">
        <div className="simulation-runstate">
          <Badge appearance="dot" variant={running ? "success" : "neutral"}>
            {running ? "Running" : offline ? "Paused offline" : "Paused"}
          </Badge>
          <span className="simulation-clock">
            <Clock size={13} aria-hidden="true" />
            <strong>T+{(state.world.timeMs / 1000).toFixed(1)}s</strong>
          </span>
          <span>{state.world.tick} fixed steps</span>
        </div>
        <fieldset
          disabled={!canOperate || busy}
          className="simulation-runcontrols"
          aria-label="Run controls"
        >
          <Button
            variant={state.paused ? "primary" : "secondary"}
            loading={busy}
            onClick={() => onPausedChange(!state.paused)}
          >
            {state.paused ? <Play size={15} weight="fill" /> : <Pause size={15} weight="fill" />}
            {state.paused ? "Resume" : "Pause"}
          </Button>
          <Button onClick={onStep} disabled={!state.paused}>
            <SkipForward size={15} /> Step
          </Button>
        </fieldset>
        <div className="simulation-runbar-end">
          <Button
            variant="ghost"
            shape="square"
            aria-label={panelCollapsed ? "Show inspector panel" : "Hide inspector panel"}
            aria-pressed={!panelCollapsed}
            icon={<SidebarSimple size={17} />}
            onClick={() => setPanelCollapsed((value) => !value)}
          />
        </div>
      </div>
      <div className="simulation-modebar">
        <Tabs
          variant="segmented"
          tabs={[
            { value: "map", label: "Map", className: "flex-1 justify-center" },
            { value: "inspect", label: "Inspect", className: "flex-1 justify-center" },
            { value: "setup", label: "Setup", className: "flex-1 justify-center" },
          ]}
          value={mobileMode}
          onValueChange={(value) => {
            if (value === "map") setMobileView("map");
            else if (value === "inspect") {
              setSetupOpen(false);
              setMobileView("panel");
            } else if (value === "setup") openSetup();
          }}
        />
      </div>
      <div className="simulation-body">
        <SimulationStage
          state={state}
          camera={search.camera}
          onCameraChange={(camera) => go({ camera })}
          selectedId={selectedId}
          onSelect={setSelectedId}
          onShowDetails={showSelectedDetails}
        />
        <aside className="simulation-panel" aria-label="Inspector">
          <div className="simulation-panel-head">
            {setupOpen ? (
              <>
                <span className="simulation-panel-title">
                  <SlidersHorizontal size={15} /> Scenario setup
                </span>
                <Button
                  variant="ghost"
                  shape="square"
                  size="sm"
                  aria-label="Close scenario setup"
                  icon={<X size={15} />}
                  onClick={closeSetup}
                />
              </>
            ) : (
              <Tabs
                variant="segmented"
                size="sm"
                tabs={[
                  {
                    value: "units",
                    label: (
                      <>
                        {inspectorTabLabels.units}
                        <span className="simulation-count">{groups.length}</span>
                      </>
                    ),
                  },
                  {
                    value: "decisions",
                    label: (
                      <>
                        {inspectorTabLabels.decisions}
                        <span className="simulation-count">{state.decisions.length}</span>
                      </>
                    ),
                  },
                  { value: "usage", label: inspectorTabLabels.usage },
                  { value: "log", label: inspectorTabLabels.log },
                ]}
                value={tab}
                onValueChange={(value) => {
                  if (isInspectorTab(value)) setTab(value);
                }}
              />
            )}
          </div>
          <div
            className="simulation-panel-body"
            ref={panelBodyRef}
            tabIndex={-1}
            {...(setupOpen
              ? { id: "simulation-setup-panel", "aria-label": "Scenario setup" }
              : { role: "tabpanel", "aria-label": `${inspectorTabLabels[tab]} panel` })}
          >
            {setupOpen ? (
              <SimulationSetupPanel
                formKey={`${state.scenario}-${state.seed}-${state.doctrine}-${state.timeScale}-${state.mode}-${search.host}`}
                defaultValues={{
                  ...search,
                  time_scale: String(search.time_scale) as "1" | "10" | "100",
                }}
                seed={state.seed}
                canOperate={canOperate}
                busy={busy}
                onSubmit={loadScenario}
                onReset={onReset}
                onReplayImport={() => void navigate({ to: "/replays" })}
              />
            ) : tab === "units" ? (
              <SimulationUnitList
                groups={groups}
                objectives={objectives}
                selectedId={selectedId}
                onSelect={setSelectedId}
              />
            ) : tab === "decisions" ? (
              <SimulationDecisionList decisions={state.decisions} offline={offline} />
            ) : tab === "usage" ? (
              <div className="simulation-panel-section">
                <CommanderCostDashboard
                  sources={factions.map((faction) => ({
                    faction,
                    aggregates: state.commanders[faction]?.costAggregates ?? [],
                  }))}
                />
              </div>
            ) : (
              <SimulationEventLog logs={state.logs} />
            )}
          </div>
          <footer className="simulation-panel-foot" aria-label="Commander status">
            {!offline && canOperate
              ? factions.map((faction) => (
                  <SessionAiAuthorization
                    key={faction}
                    session={{
                      session_id: commanderSessionId({
                        scenario: state.scenario,
                        seed: state.seed,
                        doctrine: state.doctrine,
                        timeScale: state.timeScale,
                        mode: state.mode,
                        faction,
                      }),
                      mission_epoch: 1,
                      faction,
                    }}
                  />
                ))
              : null}
            <SimulationCommanderStatus state={state} offline={offline} factions={factions} />
          </footer>
        </aside>
      </div>
    </div>
  );
}
