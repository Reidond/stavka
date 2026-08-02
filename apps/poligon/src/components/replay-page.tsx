import { useState, type ChangeEvent } from "react";
import type { SessionExport } from "@stavka/protocol";
import { Button, OrderCallout, Stamp, StatusChip } from "@stavka/ui";

import { MAX_REPLAY_FILE_BYTES, readSessionExportFile } from "../replay-file";
import { ReplayDashboard } from "./replay-dashboard";

export const ReplayPage = ({ onReturn }: { readonly onReturn: () => void }) => {
  const [replay, setReplay] = useState<SessionExport>();
  const [fileName, setFileName] = useState<string>();
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(false);

  const selectFile = async (event: ChangeEvent<HTMLInputElement>): Promise<void> => {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = "";
    if (!file) return;
    setLoading(true);
    setError(undefined);
    setReplay(undefined);
    setFileName(file.name);
    try {
      setReplay(await readSessionExportFile(file));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to import replay export");
    } finally {
      setLoading(false);
    }
  };

  return (
    <main className="poligon-shell">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="stavka-grid-label m-0">Stavka / proving ground / local replay</p>
          <h1 className="m-0 font-display text-5xl tracking-tight uppercase">Replay</h1>
        </div>
        <Button onClick={onReturn}>Return to simulator</Button>
      </header>

      <div className="poligon-replay-content space-y-4">
        <section className="stavka-panel space-y-3 p-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <h2 className="m-0 font-display text-2xl uppercase">Import commander export</h2>
              <p id="replay-file-help" className="mt-1 mb-0 text-sm">
                Choose a local JSON export. Nothing is uploaded and remote URLs are not accepted.
              </p>
            </div>
            <StatusChip>max {MAX_REPLAY_FILE_BYTES / 1024 / 1024} MiB</StatusChip>
          </div>
          <input
            type="file"
            accept=".json,application/json"
            aria-describedby="replay-file-help"
            className="block w-full border border-contour bg-paper p-3 font-data text-xs file:mr-3 file:border file:border-ink file:bg-ink file:px-3 file:py-2 file:text-paper file:uppercase"
            onChange={(event) => void selectFile(event)}
          />
          {loading ? <Stamp tone="pending">Validating local export</Stamp> : null}
          {fileName ? <p className="m-0 font-data text-xs">Selected: {fileName}</p> : null}
        </section>

        {error ? (
          <OrderCallout title="Replay import rejected" priority="urgent">
            {error}
          </OrderCallout>
        ) : null}

        {replay ? <ReplayDashboard replay={replay} /> : null}
      </div>
    </main>
  );
};
