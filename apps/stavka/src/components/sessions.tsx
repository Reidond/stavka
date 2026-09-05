import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Button } from "@cloudflare/kumo/components/button";
import { Input } from "@cloudflare/kumo/components/input";
import { Select } from "@cloudflare/kumo/components/select";
import { Tabs } from "@cloudflare/kumo/components/tabs";
import { Banner } from "@cloudflare/kumo/components/banner";
import { Empty } from "@cloudflare/kumo/components/empty";
import { ClipboardText } from "@cloudflare/kumo/components/clipboard-text";
import type { SessionExport } from "@stavka/protocol";
import { commanderSessionId, type ScenarioIdentity } from "../scenario-identity";
import { readSessionExport } from "../operations-api";
import { MAX_REPLAY_FILE_BYTES, readSessionExportFile } from "../replay-file";
import { scenarioTitles } from "./simulation-setup";
import { ReplayDashboard } from "./replay-dashboard";
import { Loading } from "./page-state";
import { useAccountScope } from "../recent-sessions";
import { SessionAiAuthorization } from "./session-ai-authorization";

export type SessionView = "timeline" | "state" | "usage";
type FileState =
  | { status: "empty" }
  | { status: "loading"; name: string }
  | { status: "error"; message: string }
  | { status: "ready"; name: string; replay: SessionExport };
export function SessionInspector({
  initialSessionId = "",
  initialFaction = "OPFOR",
  initialView = "timeline",
  initialSource = "commander",
}: {
  readonly initialSessionId?: string;
  readonly initialFaction?: string;
  readonly initialView?: SessionView;
  readonly initialSource?: "commander" | "file";
}) {
  const scope = useAccountScope();
  const [source, setSource] = useState(initialSource);
  const [view, setView] = useState<SessionView>(initialView);
  const [raw, setRaw] = useState(Boolean(initialSessionId));
  const [sessionId, setSessionId] = useState(initialSessionId);
  const [faction, setFaction] = useState(initialFaction);
  const [identity, setIdentity] = useState<ScenarioIdentity>({
    scenario: "engagement",
    seed: 12,
    doctrine: "balanced",
    timeScale: 10,
    mode: "single",
  });
  const [selection, setSelection] = useState(
    initialSessionId ? { sessionId: initialSessionId, faction: initialFaction } : undefined,
  );
  const [file, setFile] = useState<FileState>({ status: "empty" });
  const fileInput = useRef<HTMLInputElement>(null);
  const fileSequence = useRef(0);
  useEffect(
    () => () => {
      fileSequence.current += 1;
    },
    [],
  );
  const session = useQuery({
    queryKey: ["session-export", scope, selection],
    queryFn: ({ signal }) => readSessionExport(selection!.sessionId, selection!.faction, signal),
    enabled: source === "commander" && selection !== undefined && scope !== undefined,
    retry: false,
  });
  const computedId = raw ? sessionId.trim() : commanderSessionId({ ...identity, faction });
  const replay =
    source === "file"
      ? file.status === "ready"
        ? file.replay
        : undefined
      : session.isError || session.isFetching
        ? undefined
        : session.data;
  const switchSource = (value: string) => {
    if (value !== "file" && value !== "commander") return;
    fileSequence.current += 1;
    setFile({ status: "empty" });
    setSource(value);
  };
  const selectFile = async (selected: File) => {
    const sequence = ++fileSequence.current;
    setFile({ status: "loading", name: selected.name });
    try {
      const result = await readSessionExportFile(selected);
      if (sequence === fileSequence.current)
        setFile({ status: "ready", name: selected.name, replay: result });
    } catch (cause) {
      if (sequence === fileSequence.current)
        setFile({
          status: "error",
          message: cause instanceof Error ? cause.message : "Unable to import export",
        });
    }
  };
  return (
    <div className="stavka-pane space-y-4">
      <section className="stavka-panel space-y-4 p-4" aria-label="Session source">
        <Tabs
          variant="segmented"
          tabs={[
            { value: "commander", label: "From Commander" },
            { value: "file", label: "From export file" },
          ]}
          value={source}
          onValueChange={switchSource}
        />
        {source === "commander" ? (
          <form
            className="space-y-4"
            onSubmit={(event) => {
              event.preventDefault();
              if (!computedId || !faction) return;
              const next = { sessionId: computedId, faction };
              if (selection?.sessionId === next.sessionId && selection.faction === next.faction)
                void session.refetch();
              else setSelection(next);
            }}
          >
            <div className="session-picker">
              {raw ? (
                <Input
                  label="Session ID"
                  placeholder="poligon-engagement-12-opfor-balanced-x10-versus"
                  value={sessionId}
                  required
                  onChange={(event) => setSessionId(event.currentTarget.value)}
                />
              ) : (
                <>
                  <Select
                    label="Scenario"
                    className="w-full"
                    renderValue={(value) => scenarioTitles[value]}
                    value={identity.scenario}
                    onValueChange={(value) => {
                      if (value === "engagement" || value === "movement" || value === "mechanized")
                        setIdentity({ ...identity, scenario: value });
                    }}
                  >
                    {Object.entries(scenarioTitles).map(([value, title]) => (
                      <Select.Option key={value} value={value}>
                        {title}
                      </Select.Option>
                    ))}
                  </Select>
                  <Input
                    label="Seed"
                    type="number"
                    min={1}
                    max={2147483647}
                    step={1}
                    required
                    value={identity.seed}
                    onChange={(event) =>
                      setIdentity({ ...identity, seed: Number(event.currentTarget.value) })
                    }
                  />
                  <Select
                    label="Doctrine"
                    className="w-full"
                    renderValue={(value) => value.charAt(0).toUpperCase() + value.slice(1)}
                    value={identity.doctrine}
                    onValueChange={(value) => {
                      if (value === "balanced" || value === "aggressive" || value === "defensive")
                        setIdentity({ ...identity, doctrine: value });
                    }}
                  >
                    {["balanced", "aggressive", "defensive"].map((value) => (
                      <Select.Option key={value} value={value}>
                        {value[0]?.toUpperCase()}
                        {value.slice(1)}
                      </Select.Option>
                    ))}
                  </Select>
                  <Select
                    label="Time scale"
                    className="w-full"
                    renderValue={(value) => `×${value}`}
                    value={String(identity.timeScale)}
                    onValueChange={(value) => {
                      if (value === "1" || value === "10" || value === "100")
                        setIdentity({ ...identity, timeScale: Number(value) as 1 | 10 | 100 });
                    }}
                  >
                    {[1, 10, 100].map((value) => (
                      <Select.Option key={value} value={String(value)}>
                        ×{value}
                      </Select.Option>
                    ))}
                  </Select>
                  <Select
                    label="Mode"
                    className="w-full"
                    renderValue={(value) => (value === "single" ? "Single commander" : "Versus")}
                    value={identity.mode}
                    onValueChange={(value) => {
                      if (value === "single" || value === "versus")
                        setIdentity({ ...identity, mode: value });
                    }}
                  >
                    <Select.Option value="single">Single commander</Select.Option>
                    <Select.Option value="versus">Versus</Select.Option>
                  </Select>
                </>
              )}
              <Select
                label="Faction"
                className="w-full"
                value={faction}
                onValueChange={(value) => {
                  if (typeof value === "string") setFaction(value);
                }}
              >
                <Select.Option value="OPFOR">OPFOR</Select.Option>
                <Select.Option value="BLUFOR">BLUFOR</Select.Option>
                {!["OPFOR", "BLUFOR"].includes(initialFaction) ? (
                  <Select.Option value={initialFaction}>{initialFaction}</Select.Option>
                ) : null}
              </Select>
            </div>
            {!raw ? (
              <div className="text-xs break-all text-kumo-subtle">
                <ClipboardText text={computedId} />
              </div>
            ) : null}
            <div className="flex flex-wrap items-center gap-3">
              <Button type="submit" loading={source === "commander" && session.isFetching}>
                Load session
              </Button>
              <Button variant="ghost" onClick={() => setRaw(!raw)}>
                {raw ? "Choose a scenario instead" : "Paste an ID instead"}
              </Button>
            </div>
          </form>
        ) : (
          <div className="space-y-3">
            <p id="replay-file-help" className="m-0 text-sm text-kumo-subtle">
              Local JSON export, up to {MAX_REPLAY_FILE_BYTES / 1024 / 1024} MiB. The file stays in
              your browser.
            </p>
            <input
              ref={fileInput}
              hidden
              type="file"
              accept=".json,application/json"
              aria-label="Session export file"
              aria-describedby="replay-file-help"
              onChange={(event) => {
                const selected = event.currentTarget.files?.[0];
                event.currentTarget.value = "";
                if (selected) void selectFile(selected);
              }}
            />
            <Button onClick={() => fileInput.current?.click()}>Choose export file</Button>
            {file.status === "ready" ? (
              <p className="text-xs break-all text-kumo-subtle">{file.name}</p>
            ) : null}
          </div>
        )}
      </section>
      {source === "commander" && replay && !session.isFetching && !session.error ? (
        <section className="stavka-panel p-4">
          <SessionAiAuthorization
            session={{
              session_id: replay.session.session_id,
              faction: replay.session.faction,
              mission_epoch: replay.session.mission_epoch,
            }}
          />
        </section>
      ) : null}
      {source === "commander" && session.isFetching ? (
        <Loading label="Loading session" />
      ) : source === "commander" && session.error ? (
        <Banner variant="error" title="Session unavailable" description={session.error.message} />
      ) : source === "file" && file.status === "loading" ? (
        <Loading label="Validating export" />
      ) : source === "file" && file.status === "error" ? (
        <Banner variant="error" title="Replay import rejected" description={file.message} />
      ) : replay ? (
        <>
          <section className="stavka-panel space-y-3 p-4" aria-label="Session summary">
            <div className="break-all">
              <ClipboardText text={replay.session.session_id} />
            </div>
            <div className="flex flex-wrap gap-4 text-sm">
              <span>{replay.session.faction}</span>
              <span>{replay.session.doctrine}</span>
              <span>{replay.session.mode}</span>
              <span className="text-kumo-subtle">Exported {replay.session.exported_at}</span>
            </div>
          </section>
          <Tabs
            variant="segmented"
            tabs={[
              { value: "timeline", label: "Timeline" },
              { value: "state", label: "State" },
              { value: "usage", label: "Usage" },
            ]}
            value={view}
            onValueChange={(value) => {
              if (value === "timeline" || value === "state" || value === "usage") setView(value);
            }}
          />
          <ReplayDashboard replay={replay} view={view} showSummary={false} />
        </>
      ) : (
        <Empty
          className="[&_h2]:text-sm"
          size="sm"
          title="Choose a session to review"
          description={
            source === "commander"
              ? "Choose its scenario configuration and faction, then load the recorded session."
              : "Select a canonical export to inspect its timeline, state, and usage."
          }
        />
      )}
    </div>
  );
}
