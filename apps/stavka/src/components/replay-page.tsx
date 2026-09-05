import { useState, type ChangeEvent } from "react";
import type { SessionExport } from "@stavka/protocol";
import { Banner } from "@cloudflare/kumo/components/banner";
import { Button } from "@cloudflare/kumo/components/button";
import { Badge } from "@cloudflare/kumo/components/badge";
import { LayerCard } from "@cloudflare/kumo/components/layer-card";

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
      <header className="stavka-page-heading">
        <div>
          <h1>Replays</h1>
          <p>Inspect recorded states, decisions, and outcomes from a session export.</p>
        </div>
        <Button onClick={onReturn}>Return to simulator</Button>
      </header>

      <div className="poligon-replay-content space-y-4">
        <LayerCard className="space-y-3 p-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <h2 className="m-0 text-base font-semibold text-kumo-strong">Import a session</h2>
              <p id="replay-file-help" className="mt-1 mb-0 text-sm">
                Choose a local JSON export. Nothing is uploaded and remote URLs are not accepted.
              </p>
            </div>
            <Badge variant="secondary">max {MAX_REPLAY_FILE_BYTES / 1024 / 1024} MiB</Badge>
          </div>
          <input
            type="file"
            accept=".json,application/json"
            aria-describedby="replay-file-help"
            className="block w-full rounded-sm border border-kumo-line bg-kumo-base p-3 text-xs file:mr-3 file:rounded-sm file:border file:border-kumo-line file:bg-kumo-contrast file:px-3 file:py-2 file:text-kumo-inverse file:uppercase"
            onChange={(event) => void selectFile(event)}
          />
          {loading ? <Badge variant="warning">Validating local export</Badge> : null}
          {fileName ? <p className="m-0 text-xs text-kumo-subtle">Selected: {fileName}</p> : null}
        </LayerCard>

        {error ? (
          <Banner variant="error" title="Replay import rejected" description={error} />
        ) : null}

        {replay ? <ReplayDashboard replay={replay} /> : null}
      </div>
    </main>
  );
};
