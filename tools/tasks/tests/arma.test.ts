import { describe, expect, it } from "vitest";
import { NodeServices } from "@effect/platform-node";
import { Effect, FileSystem, Schema } from "effect";
import { resolve } from "node:path";
import { ArmaResult, parseArmaOptions, runArmaTask, validateWorkbenchLog } from "../src/arma";
import { ArmaEnvironment } from "../src/arma-environment";
import { NativeSmokeResult, readDiagnostics, verifySmokeIdentity } from "../src/arma-evidence";
import { sha256 } from "../src/arma-evidence";
import { runArmaInspect } from "../src/arma-inspect";

describe("Workbench validation evidence", () => {
  it("requires a positive compiler completion marker", () => {
    expect(validateWorkbenchLog("ENGINE: Game successfully created.")).toBe(false);
    expect(validateWorkbenchLog("SCRIPT: Script validation successful.")).toBe(true);
  });
  it("does not trust process exit zero or a success marker alongside errors", () => {
    expect(validateWorkbenchLog("SCRIPT (E): Invalid script\nScript validation successful.")).toBe(
      false,
    );
    expect(validateWorkbenchLog("Script validation failed.")).toBe(false);
  });
});

describe("CLI native run isolation", () => {
  const expected = { runId: "this-run", sourceHash: "current-source", engineVersion: "1.8.0.13" };
  const receipt = {
    schema_version: 1 as const,
    run_id: "this-run",
    source_hash: "current-source",
    engine_version: "1.8.0.13",
    passed: true,
    phase: 4,
  };

  it("rejects stale runs, edited sources and a different engine version", () => {
    expect(verifySmokeIdentity(receipt, expected)).toBe(true);
    expect(verifySmokeIdentity({ ...receipt, run_id: "old-run" }, expected)).toBe(false);
    expect(verifySmokeIdentity({ ...receipt, source_hash: "old-source" }, expected)).toBe(false);
    expect(verifySmokeIdentity({ ...receipt, engine_version: "1.7.0.54" }, expected)).toBe(false);
    expect(() => Schema.decodeUnknownSync(NativeSmokeResult)({ passed: true })).toThrow();
  });

  it("extracts actionable compiler locations and deduplicates repeated target diagnostics", () => {
    const diagnostic = '12:00 SCRIPT (E): @"Scripts/Game/Broken.c,13": Unknown type';
    expect(
      readDiagnostics(`${diagnostic}\n${diagnostic}\nScripts/Game/Old.c(8): warning: obsolete`),
    ).toEqual([
      { severity: "error", file: "Scripts/Game/Broken.c", line: 13, message: "Unknown type" },
      { severity: "warning", file: "Scripts/Game/Old.c", line: 8, message: "obsolete" },
    ]);
  });

  it("rejects unbounded deadlines and target narrowing for packaging", async () => {
    await expect(
      Effect.runPromise(parseArmaOptions("smoke", ["--timeout-seconds", "0"])),
    ).rejects.toThrow();
    await expect(Effect.runPromise(parseArmaOptions("pack", ["--target", "PC"]))).rejects.toThrow();
    await expect(
      Effect.runPromise(parseArmaOptions("validate", ["--target", "PC"])),
    ).resolves.toMatchObject({ target: "PC" });
  });

  it("records a blocked version mismatch without launching Workbench", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const root = yield* fs.makeTempDirectoryScoped();
        const failure = yield* runArmaTask(root, "doctor").pipe(
          Effect.provideService(ArmaEnvironment, {
            inspect: Effect.succeed({
              executable: "never-launch.exe",
              addons: "unused",
              gameExecutable: "unused.exe",
              toolsVersion: "1.8.0.13",
              gameVersion: "1.7.0.54",
              editorPids: [],
            }),
          }),
          Effect.flip,
        );
        expect(failure).toMatchObject({ _tag: "ArmaTaskFailed", status: "blocked" });
        const runs = yield* fs.readDirectory(resolve(root, "out/arma"));
        expect(runs).toHaveLength(1);
        const result = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(ArmaResult))(
          yield* fs.readFileString(resolve(root, "out/arma", runs[0]!, "result.json")),
        );
        expect(result.status).toBe("blocked");
        expect(result.artifacts).toEqual([]);
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
    );
  });

  it("rejects modified evidence instead of accepting its saved success status", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const root = yield* fs.makeTempDirectoryScoped();
        const runId = "b04112a4-d7d5-402d-ae5c-c4df70057270";
        const runRoot = resolve(root, "out/arma", runId);
        yield* fs.makeDirectory(runRoot, { recursive: true });
        const artifactPath = resolve(runRoot, "capture.json");
        yield* fs.writeFileString(artifactPath, "tampered");
        yield* fs.writeFileString(
          resolve(runRoot, "result.json"),
          JSON.stringify({
            schemaVersion: 1,
            runId,
            action: "smoke",
            status: "passed",
            startedAt: "test",
            finishedAt: "test",
            sourceHash: "test",
            installation: null,
            diagnostics: [],
            message: "previous success",
            artifacts: [{ path: artifactPath, sha256: sha256("original") }],
          }),
        );
        const failure = yield* runArmaInspect(root, [runId]).pipe(Effect.flip);
        expect(failure).toMatchObject({ _tag: "ArmaTaskFailed", stage: "inspect" });
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
    );
  });
});
