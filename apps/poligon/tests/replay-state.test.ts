import type { GameSnapshot, SessionExport, StateDelta, TickRequest } from "@stavka/protocol";
import { describe, expect, it, vi } from "vitest";

import { reconstructReplayFrames } from "../src/replay-state";

type FullTick = Extract<TickRequest, { readonly type: "full" }>;
type DeltaTick = Extract<TickRequest, { readonly type: "delta" }>;
type ArchivedTick = SessionExport["archive"]["ticks"][number];
type ArchivedSnapshot = SessionExport["archive"]["snapshots"][number];

const baseline: GameSnapshot = {
  mission: {
    id: "mission-1",
    epoch: 1,
    name: "Replay test",
    map: "Poligon",
    time_elapsed_seconds: 10,
    player_count: { friendly: 1, enemy: 2 },
  },
  objectives: [
    {
      id: "objective-stable",
      name: "Stable",
      position: [0, 0, 0],
      status: "neutral",
      capture_progress: 0,
    },
    {
      id: "objective-replace",
      name: "Old replacement",
      position: [5, 0, 5],
      status: "enemy",
      capture_progress: 0.2,
    },
    {
      id: "objective-remove",
      name: "Remove",
      position: [8, 0, 8],
      status: "enemy",
      capture_progress: 0,
    },
  ],
  friendly_groups: [
    {
      id: "alpha",
      faction: "OPFOR",
      template: "infantry",
      position: [1, 0, 1],
      strength: { current: 8, max: 8 },
      behavior: "hold",
      status: "idle",
    },
    {
      id: "bravo",
      faction: "OPFOR",
      template: "infantry",
      position: [2, 0, 2],
      strength: { current: 6, max: 8 },
      behavior: "hold",
      status: "idle",
    },
  ],
  known_enemies: [
    {
      id: "enemy-replace",
      reported_by: "alpha",
      type: "infantry",
      estimated_count: 4,
      last_known_position: [20, 0, 20],
      confidence: "probable",
      age_seconds: 5,
    },
    {
      id: "enemy-expire",
      reported_by: "alpha",
      type: "vehicle",
      estimated_count: 1,
      last_known_position: [30, 0, 30],
      confidence: "stale",
      age_seconds: 180,
    },
  ],
  resources: {
    manpower: 100,
    vehicle_pool: 4,
    reinforcement_cooldown_seconds: 10,
    max_active_units: 20,
  },
};

const emptyDelta = (): StateDelta => ({
  groups_upserted: [],
  groups_moved: [],
  groups_destroyed: [],
  objectives_upserted: [],
  known_enemies_upserted: [],
  known_enemies_expired: [],
});

const fullRequest = (tickId = 1, timestamp = 100): FullTick => ({
  protocol_version: 1,
  session_id: "session-1",
  faction: "OPFOR",
  tick_id: tickId,
  timestamp,
  full_snapshot_interval: 30,
  type: "full",
  snapshot: baseline,
  sergeant_reports: [],
  events: [],
  command_results: [],
});

const deltaRequest = (
  changes: StateDelta = emptyDelta(),
  options: {
    readonly tickId?: number;
    readonly timestamp?: number;
    readonly sinceTick?: number;
    readonly snapshot?: GameSnapshot;
  } = {},
): DeltaTick => ({
  protocol_version: 1,
  session_id: "session-1",
  faction: "OPFOR",
  tick_id: options.tickId ?? 2,
  timestamp: options.timestamp ?? 101,
  full_snapshot_interval: 30,
  type: "delta",
  since_tick: options.sinceTick ?? 1,
  changes,
  ...(options.snapshot === undefined ? {} : { snapshot: options.snapshot }),
  sergeant_reports: [
    {
      type: "sergeant_report",
      timestamp: options.timestamp ?? 101,
      payload: {
        group_id: "alpha",
        report_type: "sitrep",
        position: [1, 0, 1],
        strength: { current: 8, max: 8 },
        status: "idle",
        contacts: [],
        ammo_status: "adequate",
        morale: "steady",
        local_decision: "Holding",
      },
    },
  ],
  events: [
    {
      id: `event-${options.tickId ?? 2}`,
      type: "contact",
      timestamp: options.timestamp ?? 101,
      significance: "notable",
      group_id: "alpha",
    },
  ],
  command_results: [{ command_id: "command-1", status: "completed" }],
});

const archivedTick = (request: TickRequest): ArchivedTick => ({
  tickId: request.tick_id,
  timestamp: request.timestamp,
  kind: request.type,
  request,
});

const replayOf = (
  requests: readonly TickRequest[],
  snapshots: readonly ArchivedSnapshot[] = [],
): SessionExport => ({
  export_version: 1,
  session: {
    protocol_version: 1,
    session_id: "session-1",
    faction: "OPFOR",
    mission_epoch: 1,
    doctrine: "balanced",
    mode: "rule",
    map_name: "Poligon",
    exported_at: "2026-08-02T12:00:00.000Z",
  },
  logs: [],
  archive: { ticks: requests.map(archivedTick), events: [], snapshots: [...snapshots] },
  cost_aggregates: [],
});

const deepFreeze = <T>(value: T): T => {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
};

describe("reconstructReplayFrames", () => {
  it("reconstructs full-to-delta positions, removals, replacements, and resources", () => {
    const changes: StateDelta = {
      mission: { ...baseline.mission, time_elapsed_seconds: 20 },
      groups_upserted: [{ ...baseline.friendly_groups[0]!, behavior: "advance" }],
      groups_moved: [
        { id: "alpha", position: [10, 0, 11] },
        { id: "bravo", position: [99, 0, 99] },
      ],
      groups_destroyed: ["bravo"],
      objectives_removed: ["objective-replace", "objective-remove"],
      objectives_upserted: [
        {
          ...baseline.objectives[1]!,
          name: "New replacement",
          status: "friendly",
          capture_progress: 1,
        },
      ],
      known_enemies_expired: ["enemy-replace", "enemy-expire"],
      known_enemies_upserted: [
        {
          ...baseline.known_enemies[0]!,
          estimated_count: 2,
          last_known_position: [21, 0, 22],
          confidence: "confirmed",
          age_seconds: 0,
        },
      ],
      resources: {
        manpower: 75,
        vehicle_pool: 3,
        reinforcement_cooldown_seconds: 0,
        max_active_units: 18,
      },
    };

    const frames = reconstructReplayFrames(replayOf([fullRequest(), deltaRequest(changes)]));

    expect(frames).toHaveLength(2);
    expect(frames.map(({ tickId, kind, source }) => ({ tickId, kind, source }))).toEqual([
      { tickId: 1, kind: "full", source: "request" },
      { tickId: 2, kind: "delta", source: "reconstructed" },
    ]);
    expect(frames[1]?.snapshot).toMatchObject({
      mission: { time_elapsed_seconds: 20 },
      friendly_groups: [{ id: "alpha", behavior: "advance", position: [10, 0, 11] }],
      objectives: [
        { id: "objective-stable" },
        { id: "objective-replace", name: "New replacement", status: "friendly" },
      ],
      known_enemies: [
        {
          id: "enemy-replace",
          estimated_count: 2,
          last_known_position: [21, 0, 22],
        },
      ],
      resources: { manpower: 75, vehicle_pool: 3 },
    });
    expect(frames[1]?.events).toHaveLength(1);
    expect(frames[1]?.sergeantReports).toHaveLength(1);
    expect(frames[1]?.commandResults).toEqual([{ command_id: "command-1", status: "completed" }]);
  });

  it("requires the first tick to provide a full baseline", () => {
    expect(() => reconstructReplayFrames(replayOf([deltaRequest()]))).toThrow(
      /begin with a full snapshot/i,
    );
  });

  it("requires every delta since_tick to point to the immediately prior frame", () => {
    expect(() =>
      reconstructReplayFrames(
        replayOf([fullRequest(), deltaRequest(emptyDelta(), { sinceTick: 0 })]),
      ),
    ).toThrow(/since_tick 0 does not match prior tick 1/i);
  });

  it("ignores unknown and destroyed group moves using Commander delta ordering", () => {
    const frames = reconstructReplayFrames(
      replayOf([
        fullRequest(),
        deltaRequest({
          ...emptyDelta(),
          groups_moved: [
            { id: "missing", position: [50, 0, 50] },
            { id: "bravo", position: [60, 0, 60] },
          ],
          groups_destroyed: ["bravo"],
        }),
      ]),
    );

    expect(frames[1]?.snapshot.friendly_groups).toEqual([baseline.friendly_groups[0]]);
  });

  it.each([
    ["duplicate", [fullRequest(1), fullRequest(1, 101)]],
    ["out-of-order", [fullRequest(2), fullRequest(1, 101)]],
  ])("rejects %s tick IDs", (_label, requests) => {
    expect(() => reconstructReplayFrames(replayOf(requests))).toThrow(/strictly increasing/i);
  });

  it("rejects timestamps that regress while allowing equal timestamps", () => {
    expect(() =>
      reconstructReplayFrames(
        replayOf([fullRequest(1, 100), deltaRequest(emptyDelta(), { timestamp: 90 })]),
      ),
    ).toThrow(/timestamps must be monotonic/i);

    expect(
      reconstructReplayFrames(
        replayOf([fullRequest(1, 100), deltaRequest(emptyDelta(), { timestamp: 100 })]),
      ).map((frame) => frame.timestamp),
    ).toEqual([100, 100]);
  });

  it("rejects an explicit delta snapshot that differs from the derived state", () => {
    expect(() =>
      reconstructReplayFrames(
        replayOf([
          fullRequest(),
          deltaRequest(emptyDelta(), {
            snapshot: { ...baseline, resources: { ...baseline.resources, manpower: 999 } },
          }),
        ]),
      ),
    ).toThrow(/request snapshot does not match reconstructed state/i);
  });

  it("accepts partial matching archive snapshots and labels each frame source", () => {
    const full = fullRequest();
    const delta = deltaRequest();
    const snapshots: ArchivedSnapshot[] = [
      { tickId: 1, timestamp: 100, snapshot: baseline },
      { tickId: 2, timestamp: 101, snapshot: baseline },
    ];

    expect(
      reconstructReplayFrames(replayOf([full, delta], snapshots)).map((frame) => frame.source),
    ).toEqual(["archive", "archive"]);
    expect(
      reconstructReplayFrames(replayOf([full, delta], snapshots.slice(0, 1))).map(
        (frame) => frame.source,
      ),
    ).toEqual(["archive", "reconstructed"]);
    expect(() =>
      reconstructReplayFrames(replayOf([full, delta], [{ ...snapshots[0]!, tickId: 3 }])),
    ).toThrow(/no corresponding archived tick/i);
    expect(() =>
      reconstructReplayFrames(
        replayOf(
          [full, delta],
          [
            snapshots[0]!,
            {
              ...snapshots[1]!,
              snapshot: { ...baseline, resources: { ...baseline.resources, manpower: 999 } },
            },
          ],
        ),
      ),
    ).toThrow(/archive snapshot.*does not match reconstructed state/i);
  });

  it("checks replay session and faction on every request", () => {
    const request = { ...fullRequest(), faction: "BLUFOR" };
    expect(() => reconstructReplayFrames(replayOf([request]))).toThrow(/session and faction/i);
  });

  it("checks the mission epoch and declared map on every derived frame", () => {
    const wrongEpoch: FullTick = {
      ...fullRequest(),
      snapshot: { ...baseline, mission: { ...baseline.mission, epoch: 2 } },
    };
    const wrongMap: FullTick = {
      ...fullRequest(),
      snapshot: { ...baseline, mission: { ...baseline.mission, map: "Everon" } },
    };

    expect(() => reconstructReplayFrames(replayOf([wrongEpoch]))).toThrow(
      /mission epoch 2.*does not match replay epoch 1/i,
    );
    expect(() => reconstructReplayFrames(replayOf([wrongMap]))).toThrow(
      /mission map Everon.*does not match replay map Poligon/i,
    );
  });

  it("does not mutate its frozen input or access the network", () => {
    const fetchSpy = vi.fn();
    const webSocketSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    vi.stubGlobal("WebSocket", webSocketSpy);
    const replay = deepFreeze(
      replayOf([
        fullRequest(),
        deltaRequest({
          ...emptyDelta(),
          groups_moved: [{ id: "alpha", position: [10, 0, 10] }],
          resources: { ...baseline.resources, manpower: 80 },
        }),
      ]),
    );

    const frames = reconstructReplayFrames(replay);

    expect(frames[0]?.snapshot.friendly_groups[0]?.position).toEqual([1, 0, 1]);
    expect(frames[0]?.snapshot.resources.manpower).toBe(100);
    expect(frames[1]?.snapshot.friendly_groups[0]?.position).toEqual([10, 0, 10]);
    expect(frames[1]?.snapshot.resources.manpower).toBe(80);
    expect(frames[0]?.snapshot).not.toBe(
      replay.archive.ticks[0]?.request.type === "full"
        ? replay.archive.ticks[0].request.snapshot
        : undefined,
    );
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(webSocketSpy).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
});
