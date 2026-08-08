import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  aggregateReplayCosts,
  buildReplayTimeline,
  projectReplayTacticalMarkers,
  ReplayDashboard,
} from "../src/components/replay-dashboard";
import { reconstructReplayFrames } from "../src/replay-state";
import { replayFixture } from "./replay-fixture";

describe("ReplayDashboard", () => {
  it("builds a cause-to-decision-to-command-to-outcome timeline", () => {
    expect(buildReplayTimeline(replayFixture)).toEqual([
      {
        id: "dec_000001",
        timestamp: "2026-08-02T12:00:01.000Z",
        cause: "urgent_contact · 1 input event(s)",
        decision: "Move to the eastern ridge.",
        commands: ["cmd_1 · move_group"],
        outcomes: ["cmd_1 · completed"],
      },
    ]);
  });

  it("groups costs by session, faction, agent tier, and model", () => {
    expect(aggregateReplayCosts(replayFixture)).toEqual([
      {
        key: JSON.stringify([
          "poligon-engagement-12-opfor-balanced-x10-single",
          "OPFOR",
          "commander",
          "stavka/commander",
        ]),
        sessionId: "poligon-engagement-12-opfor-balanced-x10-single",
        faction: "OPFOR",
        agent_tier: "commander",
        model: "stavka/commander",
        calls: 3,
        input_tokens: 60,
        output_tokens: 15,
        cost_usd: 0.003,
      },
    ]);
  });

  it("projects the reconstructed full-to-delta state without fabricating hidden world data", () => {
    const frames = reconstructReplayFrames(replayFixture);
    const latest = frames.at(-1);
    expect(latest).toMatchObject({ tickId: 2, kind: "delta", source: "reconstructed" });
    expect(latest && projectReplayTacticalMarkers(latest.snapshot)).toEqual([
      {
        key: "friendly:red_1",
        kind: "friendly",
        label: "red_1",
        x: 100,
        z: 200,
        detail: "idle · 6/6",
      },
      {
        key: "objective:ridge",
        kind: "objective",
        label: "Eastern ridge",
        x: 140,
        z: 220,
        detail: "neutral · 0%",
      },
      {
        key: "known-enemy:blue_1",
        kind: "known_enemy",
        label: "blue_1",
        x: 220,
        z: 240,
        detail: "probable · 12s old",
      },
    ]);
  });

  it("renders replay metadata, timeline stages, and cost table with Kumo components", () => {
    const markup = renderToStaticMarkup(<ReplayDashboard replay={replayFixture} />);

    expect(markup).toContain("Cause to outcome replay timeline");
    expect(markup).toContain("Cause");
    expect(markup).toContain("Decision");
    expect(markup).toContain("Commands");
    expect(markup).toContain("Outcomes");
    expect(markup).toContain("Calls, tokens, and cost");
    expect(markup).toContain("$0.0030");
    expect(markup).toContain("Reconstructed replay world progression");
    expect(markup).toContain("Tick 2 · delta · reconstructed state");
    expect(markup).toContain('data-marker="friendly:red_1"');
    expect(markup).toContain("red_1</strong> · X 100 · Z 200");
    expect(markup).toContain("probable · 12s old");
    expect(markup).toContain("140</strong>");
  });
});
