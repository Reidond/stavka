import { decodeSessionExport, type SessionExport } from "@stavka/protocol";

import { reconstructReplayFrames } from "./replay-state";

export const MAX_REPLAY_FILE_BYTES = 5 * 1024 * 1024;

export interface LocalReplayFile {
  readonly name: string;
  readonly size: number;
  readonly text: () => Promise<string>;
}

const describeError = (error: unknown): string =>
  (error instanceof Error ? error.message : String(error)).slice(0, 2_000);

/** Reads only the user-selected browser File; no fetch, URL, or remote import path exists. */
export const readSessionExportFile = async (file: LocalReplayFile): Promise<SessionExport> => {
  if (file.size > MAX_REPLAY_FILE_BYTES) {
    throw new Error(`Replay file exceeds the ${MAX_REPLAY_FILE_BYTES / 1024 / 1024} MiB limit`);
  }

  const text = await file.text();
  if (text.length > MAX_REPLAY_FILE_BYTES) {
    throw new Error(`Replay file exceeds the ${MAX_REPLAY_FILE_BYTES / 1024 / 1024} MiB limit`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch (error) {
    throw new Error(`Replay file is not valid JSON: ${describeError(error)}`);
  }

  let replay: SessionExport;
  try {
    replay = decodeSessionExport(parsed);
  } catch (error) {
    throw new Error(`Replay export schema error: ${describeError(error)}`);
  }
  try {
    reconstructReplayFrames(replay);
  } catch (error) {
    throw new Error(`Replay archive reconstruction error: ${describeError(error)}`);
  }
  return replay;
};
