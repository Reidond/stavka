import { useCallback, useEffect, useRef, useState } from "react";
import { createScenario, snapshotWorld, stepWorldMany } from "@stavka/sim-core";

import type { ScenarioIdentity } from "./scenario-identity";
import type { PoligonState } from "./sim-world";

export const OFFLINE_STEP_CHUNK_SIZE = 50;

type YieldControl = () => Promise<void>;

const assertPositiveStepCount = (steps: number): void => {
  if (!Number.isInteger(steps) || steps < 1) {
    throw new Error("Offline simulation steps must be a positive integer");
  }
};

const yieldToBrowser: YieldControl = () =>
  new Promise((resolve) => {
    window.setTimeout(resolve, 0);
  });

export const createOfflineSimState = (identity: ScenarioIdentity): PoligonState => ({
  version: 2,
  scenario: identity.scenario,
  seed: identity.seed,
  faction: "OPFOR",
  doctrine: identity.doctrine,
  mode: identity.mode,
  paused: true,
  timeScale: identity.timeScale,
  world: createScenario(identity.scenario, identity.seed),
  commanders: {},
  linkCheckpoints: {},
  pendingCommanderEvents: {},
  logs: [
    {
      id: "offline_000001",
      at: 0,
      level: "info",
      message: "Browser-local host ready; Agent and Commander networking disabled.",
    },
  ],
  decisions: [],
  seenDecisionKeys: [],
  nextLogId: 2,
});

export const stepOfflineSimState = (state: PoligonState, steps = 1): PoligonState => {
  assertPositiveStepCount(steps);
  const world = snapshotWorld(state.world);
  stepWorldMany(world, steps);
  return { ...state, world };
};

/**
 * Advances one deterministic batch while regularly returning control to the browser.
 * The world is published once, after every fixed 100 ms step in the batch has completed.
 */
export const stepOfflineSimStateCooperatively = async (
  state: PoligonState,
  steps: number,
  yieldControl: YieldControl = yieldToBrowser,
  chunkSize = OFFLINE_STEP_CHUNK_SIZE,
): Promise<PoligonState> => {
  assertPositiveStepCount(steps);
  if (!Number.isInteger(chunkSize) || chunkSize < 1) {
    throw new Error("Offline simulation chunk size must be a positive integer");
  }

  const world = snapshotWorld(state.world);
  let completed = 0;
  while (completed < steps) {
    const chunk = Math.min(chunkSize, steps - completed);
    stepWorldMany(world, chunk);
    completed += chunk;
    if (completed < steps) await yieldControl();
  }
  return { ...state, world };
};

export interface OfflineSimHost {
  readonly state: PoligonState;
  readonly setPaused: (paused: boolean) => void;
  readonly stepOnce: () => void;
  readonly reset: () => void;
}

/** Browser-only host. Mount with a deterministic identity key when selectors change. */
export const useOfflineSimHost = (identity: ScenarioIdentity): OfflineSimHost => {
  const [state, setState] = useState(() => createOfflineSimState(identity));
  const stateRef = useRef(state);
  stateRef.current = state;

  useEffect(() => {
    if (state.paused) return;
    let cancelled = false;
    let timeout: number | undefined;
    let nextDeadline = performance.now() + 1_000;

    const scheduleNext = (): void => {
      const delay = Math.max(0, nextDeadline - performance.now());
      timeout = window.setTimeout(() => void advance(), delay);
    };

    const advance = async (): Promise<void> => {
      const base = stateRef.current;
      const next = await stepOfflineSimStateCooperatively(
        base,
        10 * base.timeScale,
        yieldToBrowser,
      );
      if (cancelled) return;

      // A pause, reset, or manual step that landed during the batch wins over stale work.
      setState((current) => (current === base && !current.paused ? next : current));
      nextDeadline += 1_000;
      scheduleNext();
    };

    scheduleNext();
    return () => {
      cancelled = true;
      if (timeout !== undefined) window.clearTimeout(timeout);
    };
  }, [state.paused]);

  const setPaused = useCallback((paused: boolean) => {
    setState((current) => ({ ...current, paused }));
  }, []);

  const stepOnce = useCallback(() => {
    const base = stateRef.current;
    // Match one resume quantum (10 × timeScale fixed steps) and yield between
    // chunks so ×100 Step clicks cannot monopolize the browser event loop.
    // Playwright locator actionability can still time out under WebGL load; DOM
    // clicks and cooperative yielding keep the simulation itself responsive.
    void stepOfflineSimStateCooperatively(base, 10 * base.timeScale).then((next) => {
      setState((current) => (current === base ? { ...next, paused: true } : current));
    });
  }, []);

  const reset = useCallback(() => {
    setState(createOfflineSimState(identity));
  }, [identity.doctrine, identity.mode, identity.scenario, identity.seed, identity.timeScale]);

  return { state, setPaused, stepOnce, reset };
};
