import { afterEach, describe, expect, it, vi } from "vitest";

import {
  OFFLINE_STEP_CHUNK_SIZE,
  createOfflineSimState,
  stepOfflineSimState,
  stepOfflineSimStateCooperatively,
} from "../src/offline-sim-host";

const identity = {
  scenario: "engagement",
  seed: 12,
  doctrine: "balanced",
  timeScale: 10,
  mode: "single",
} as const;

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("offline simulation host", () => {
  it("creates and advances identical identities deterministically", () => {
    const left = createOfflineSimState(identity);
    const right = createOfflineSimState(identity);

    expect(left).toEqual(right);
    expect(stepOfflineSimState(left, 25)).toEqual(stepOfflineSimState(right, 25));
  });

  it("uses the same 100 ms fixed step and never creates commander state", () => {
    const initial = createOfflineSimState(identity);
    const stepped = stepOfflineSimState(initial);

    expect(stepped.world.tick).toBe(initial.world.tick + 1);
    expect(stepped.world.timeMs).toBe(initial.world.timeMs + 100);
    expect(stepped.commanders).toEqual({});
    expect(stepped.linkCheckpoints).toEqual({});
    expect(stepped.logs[0]?.message).toContain("Agent and Commander networking disabled");
  });

  it("does not call fetch or open a WebSocket while creating and stepping", () => {
    const fetchSpy = vi.fn();
    const webSocketSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    vi.stubGlobal("WebSocket", webSocketSpy);

    stepOfflineSimState(createOfflineSimState(identity), 10);

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(webSocketSpy).not.toHaveBeenCalled();
  });

  it("cooperatively advances x100 in bounded chunks without changing fixed-step results", async () => {
    const initial = createOfflineSimState({ ...identity, timeScale: 100 });
    const yieldControl = vi.fn(async () => {});

    const cooperative = await stepOfflineSimStateCooperatively(initial, 10 * 100, yieldControl);
    const synchronous = stepOfflineSimState(initial, 10 * 100);

    expect(cooperative).toEqual(synchronous);
    expect(cooperative.world.tick - initial.world.tick).toBe(1_000);
    expect(cooperative.world.timeMs - initial.world.timeMs).toBe(100_000);
    expect(yieldControl).toHaveBeenCalledTimes(Math.ceil(1_000 / OFFLINE_STEP_CHUNK_SIZE) - 1);
  });

  it("treats one offline Step as a cooperative resume quantum at the selected time scale", async () => {
    for (const timeScale of [1, 10, 100] as const) {
      const initial = createOfflineSimState({ ...identity, timeScale });
      const yieldControl = vi.fn(async () => {});
      const quantum = 10 * timeScale;
      const next = await stepOfflineSimStateCooperatively(initial, quantum, yieldControl);
      expect(next.world.tick - initial.world.tick).toBe(quantum);
      expect(yieldControl).toHaveBeenCalledTimes(
        Math.max(0, Math.ceil(quantum / OFFLINE_STEP_CHUNK_SIZE) - 1),
      );
      yieldControl.mockClear();
    }
  });

  it("rejects an invalid cooperative chunk size before advancing", async () => {
    const initial = createOfflineSimState(identity);
    await expect(stepOfflineSimStateCooperatively(initial, 10, async () => {}, 0)).rejects.toThrow(
      "chunk size",
    );
    expect(initial.world.tick).toBe(createOfflineSimState(identity).world.tick);
  });
});
