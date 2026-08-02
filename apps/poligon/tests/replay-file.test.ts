import { describe, expect, it, vi } from "vitest";

import {
  MAX_REPLAY_FILE_BYTES,
  readSessionExportFile,
  type LocalReplayFile,
} from "../src/replay-file";
import { replayFixture } from "./replay-fixture";

const localFile = (text: string): LocalReplayFile => ({
  name: "session.json",
  size: new TextEncoder().encode(text).byteLength,
  text: async () => text,
});

describe("local replay file import", () => {
  it("decodes the canonical SessionExport without network access", async () => {
    const fetchSpy = vi.fn();
    const webSocketSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    vi.stubGlobal("WebSocket", webSocketSpy);

    await expect(readSessionExportFile(localFile(JSON.stringify(replayFixture)))).resolves.toEqual(
      replayFixture,
    );
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(webSocketSpy).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it("rejects oversized files before reading them", async () => {
    const text = vi.fn(async () => "{}");

    await expect(
      readSessionExportFile({
        name: "too-large.json",
        size: MAX_REPLAY_FILE_BYTES + 1,
        text,
      }),
    ).rejects.toThrow("5 MiB limit");
    expect(text).not.toHaveBeenCalled();
  });

  it("reports JSON and canonical schema errors", async () => {
    await expect(readSessionExportFile(localFile("not-json"))).rejects.toThrow("not valid JSON");
    await expect(readSessionExportFile(localFile('{"export_version":1}'))).rejects.toThrow(
      "Replay export schema error",
    );
  });

  it("surfaces semantically invalid archive sequences at the schema boundary", async () => {
    const secondTick = replayFixture.archive.ticks[1];
    if (secondTick?.request.type !== "delta") throw new Error("Expected a delta replay fixture");
    const regressingClock = {
      ...replayFixture,
      archive: {
        ...replayFixture.archive,
        ticks: [
          replayFixture.archive.ticks[0]!,
          {
            ...secondTick,
            timestamp: 80,
            request: { ...secondTick.request, timestamp: 80 },
          },
        ],
      },
    };

    await expect(readSessionExportFile(localFile(JSON.stringify(regressingClock)))).rejects.toThrow(
      "Replay export schema error",
    );
  });
});
