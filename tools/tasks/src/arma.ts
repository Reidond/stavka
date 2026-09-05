import { resolve } from "node:path";
import { Console, Effect, FileSystem, Schema } from "effect";
import { ChildProcess } from "effect/unstable/process";
import {
  ArmaEnvironment,
  ArmaInstallation,
  ArmaTaskFailed,
  createArmaArchive,
} from "./arma-environment";
import {
  Diagnostic,
  fingerprintSources,
  NativeSmokeResult,
  readDiagnostics,
  sha256,
  verifySmokeIdentity,
} from "./arma-evidence";

export const ArmaAction = Schema.Literals(["doctor", "validate", "pack", "smoke", "resources"]);
export type ArmaAction = typeof ArmaAction.Type;
const Targets = Schema.Literals(["ALL", "WORKBENCH", "PC", "XBOX", "PS4", "PS5"]);
export const ArmaResult = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  runId: Schema.String,
  action: ArmaAction,
  status: Schema.Literals(["passed", "failed", "blocked", "timeout", "cancelled"]),
  startedAt: Schema.String,
  finishedAt: Schema.String,
  sourceHash: Schema.String,
  installation: Schema.NullOr(ArmaInstallation),
  diagnostics: Schema.Array(Diagnostic),
  artifacts: Schema.Array(Schema.Struct({ path: Schema.String, sha256: Schema.String })),
  message: Schema.String,
});

export const validateWorkbenchLog = (log: string): boolean =>
  log.includes("Script validation successful.") &&
  !log.includes("Script validation failed.") &&
  !/SCRIPT\s+\(E\)/u.test(log);

export const parseArmaOptions = (action: ArmaAction, args: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    let target = "ALL";
    let timeoutSeconds = action === "smoke" ? 180 : 600;
    let fail = false;
    let query = "";
    for (let i = 0; i < args.length; i++) {
      const flag = args[i];
      if (flag === "--target" && action === "validate") target = args[++i] ?? "";
      else if (flag === "--timeout-seconds") timeoutSeconds = Number(args[++i]);
      else if (flag === "--fail" && action === "smoke") fail = true;
      else if (flag === "--query" && action === "resources") query = args[++i] ?? "";
      else
        return yield* Effect.fail(
          new ArmaTaskFailed({ stage: "arguments", message: `Unsupported option: ${flag}` }),
        );
    }
    const decodedTarget = yield* Schema.decodeUnknownEffect(Targets)(target);
    if (!Number.isInteger(timeoutSeconds) || timeoutSeconds < 1 || timeoutSeconds > 600) {
      return yield* Effect.fail(
        new ArmaTaskFailed({
          stage: "arguments",
          message: "Timeout must be between 1 and 600 seconds.",
        }),
      );
    }
    if (
      action === "resources" &&
      (!query.trim() ||
        query.length > 120 ||
        Array.from(query).some((character) => character.charCodeAt(0) < 32))
    ) {
      return yield* Effect.fail(
        new ArmaTaskFailed({
          stage: "arguments",
          message: "Resource lookup requires --query with 1–120 printable characters.",
        }),
      );
    }
    return { target: decodedTarget, timeoutSeconds, fail, query };
  });

/** Native engine commands are operator-local and intentionally absent from CI. */
export const runArmaTask = (
  repositoryRoot: string,
  action: ArmaAction,
  args: ReadonlyArray<string> = [],
  execution: { readonly runId?: string; readonly quiet?: boolean } = {},
) =>
  Effect.gen(function* () {
    const options = yield* parseArmaOptions(action, args);
    const fs = yield* FileSystem.FileSystem;
    const environment = yield* ArmaEnvironment;
    const runId = execution.runId ?? (yield* Effect.sync(() => crypto.randomUUID()));
    if (!/^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/iu.test(runId)) {
      return yield* Effect.fail(
        new ArmaTaskFailed({ stage: "arguments", message: "Invalid run identity." }),
      );
    }
    const startedAt = yield* Effect.sync(() => new Date().toISOString());
    const output = resolve(repositoryRoot, "out/arma", runId);
    yield* fs.makeDirectory(output, { recursive: true });
    const diagnostics: Array<Diagnostic> = [];
    const artifacts: Array<{ path: string; sha256: string }> = [];
    let installation: ArmaInstallation | null = null;
    let sourceHash = "";
    const artifact = (path: string) =>
      Effect.gen(function* () {
        artifacts.push({ path, sha256: sha256(yield* fs.readFile(path)) });
      });
    const finish = (status: typeof ArmaResult.Type.status, message: string) =>
      Effect.gen(function* () {
        const result = yield* Schema.decodeUnknownEffect(ArmaResult)({
          schemaVersion: 1,
          runId,
          action,
          status,
          startedAt,
          finishedAt: yield* Effect.sync(() => new Date().toISOString()),
          sourceHash,
          installation,
          diagnostics,
          artifacts,
          message,
        });
        const path = resolve(output, "result.json");
        yield* fs.writeFileString(path, JSON.stringify(result, null, 2) + "\n");
        if (!execution.quiet)
          yield* Console.log(`Arma ${action} ${status}: ${message}\nResult: ${path}`);
        return result;
      });
    const work = Effect.gen(function* () {
      installation = yield* environment.inspect;
      if (installation.toolsVersion !== installation.gameVersion) {
        return yield* Effect.fail(
          new ArmaTaskFailed({
            stage: "doctor",
            status: "blocked",
            message: `Game ${installation.gameVersion} and Tools ${installation.toolsVersion} differ. Update them to matching versions.`,
          }),
        );
      }
      if (installation.editorPids.length > 0) {
        return yield* Effect.fail(
          new ArmaTaskFailed({
            stage: "doctor",
            status: "blocked",
            message: `Close existing Workbench processes before native tasks: ${installation.editorPids.join(", ")}. They were left untouched.`,
          }),
        );
      }
      for (const required of ["mods/Stavka/addon.gproj", "mods/StavkaTools/addon.gproj"]) {
        if (!(yield* fs.exists(resolve(repositoryRoot, required)))) {
          return yield* Effect.fail(
            new ArmaTaskFailed({
              stage: "doctor",
              status: "blocked",
              message: `Missing project: ${required}`,
            }),
          );
        }
      }
      const includeTools = action === "smoke" || action === "resources";
      const source = yield* fingerprintSources(repositoryRoot, includeTools);
      sourceHash = source.hash;
      const sourceManifest = resolve(output, "sources.json");
      yield* fs.writeFileString(sourceManifest, JSON.stringify(source, null, 2) + "\n");
      yield* artifact(sourceManifest);
      if (action === "doctor") return;
      const lockPath = resolve(repositoryRoot, "out/arma/native.lock");
      yield* Effect.acquireRelease(
        fs.writeFileString(lockPath, runId, { flag: "wx" }).pipe(
          Effect.mapError(
            () =>
              new ArmaTaskFailed({
                stage: "lock",
                status: "blocked",
                message: `Another native task holds ${lockPath}. No editor was launched. Inspect the owning run before removing a stale lock.`,
              }),
          ),
        ),
        () => fs.remove(lockPath).pipe(Effect.orDie),
      );
      const project = includeTools ? "StavkaTools" : "Stavka";
      const profileRoot = resolve(output, "native-profile");
      yield* fs.makeDirectory(resolve(profileRoot, "profile"), { recursive: true });
      const common = [
        "-gproj",
        resolve(repositoryRoot, `mods/${project}/addon.gproj`),
        "-addonsDir",
        `${resolve(repositoryRoot, "mods")},${installation.addons}`,
        "-profile",
        profileRoot,
        "-noFocus",
        "-forceUpdate",
        "-disableCrashReporter",
        "-VMErrorMode",
        "fatal",
      ];
      const executable = installation.executable;
      const engineVersion = installation.toolsVersion;
      const run = (stage: string, nativeArgs: ReadonlyArray<string>, smoke = false) =>
        Effect.gen(function* () {
          const logs = resolve(output, `${stage}-logs`);
          yield* fs.makeDirectory(logs, { recursive: true });
          if (!execution.quiet) yield* Console.log(`Arma ${stage}: ${logs}`);
          const child = yield* ChildProcess.make(
            executable,
            [...common, "-logsDir", logs, ...nativeArgs],
            {
              cwd: repositoryRoot,
              detached: false,
              stdin: execution.quiet ? "ignore" : "inherit",
              stdout: execution.quiet ? "ignore" : "inherit",
              stderr: execution.quiet ? "ignore" : "inherit",
            },
          );
          if (smoke) {
            const nativeResult = resolve(profileRoot, "profile/stavka-smoke-result.json");
            while (true) {
              const log = yield* fs
                .readFileString(resolve(logs, "console.log"))
                .pipe(Effect.catch(() => Effect.succeed("")));
              if (/SCRIPT\s+\(E\)/u.test(log) && !log.includes("[StavkaSmoke] COMPLETE")) {
                diagnostics.push(...readDiagnostics(log));
                return yield* Effect.fail(
                  new ArmaTaskFailed({
                    stage,
                    message: "Native script error; inspect smoke logs.",
                  }),
                );
              }
              if (log.includes("[StavkaSmoke] COMPLETE")) {
                const receipt = yield* Schema.decodeUnknownEffect(
                  Schema.fromJsonString(NativeSmokeResult),
                )(yield* fs.readFileString(nativeResult));
                if (!verifySmokeIdentity(receipt, { runId, sourceHash, engineVersion })) {
                  return yield* Effect.fail(
                    new ArmaTaskFailed({
                      stage,
                      message: "Native result identity does not match this run, source or engine.",
                    }),
                  );
                }
                const current = yield* fingerprintSources(repositoryRoot, true);
                if (current.hash !== sourceHash) {
                  return yield* Effect.fail(
                    new ArmaTaskFailed({
                      stage,
                      message: "Sources changed during the native run.",
                    }),
                  );
                }
                for (const file of yield* fs.readDirectory(resolve(profileRoot, "profile"))) {
                  if (/^stavka-smoke-.*\.json$/u.test(file))
                    yield* artifact(resolve(profileRoot, "profile", file));
                }
                diagnostics.push(...readDiagnostics(log));
                if (!receipt.passed || receipt.phase !== 4 || /SCRIPT\s+\(E\)/u.test(log)) {
                  return yield* Effect.fail(
                    new ArmaTaskFailed({ stage, message: "Native smoke assertions failed." }),
                  );
                }
                // Completion follows entity cleanup. Scoped release stops only
                // this CLI-owned editor, without saving the temporary world.
                return log;
              }
              if (!(yield* child.isRunning)) {
                return yield* Effect.fail(
                  new ArmaTaskFailed({
                    stage,
                    message: `Workbench exited ${yield* child.exitCode} without a complete smoke result.`,
                  }),
                );
              }
              yield* Effect.sleep("500 millis");
            }
          }
          const code = yield* child.exitCode;
          const log = yield* fs.readFileString(resolve(logs, "console.log"));
          diagnostics.push(...readDiagnostics(log));
          if (code !== 0)
            return yield* Effect.fail(
              new ArmaTaskFailed({ stage, message: `Workbench exited ${code}. See ${logs}.` }),
            );
          return log;
        }).pipe(
          Effect.scoped,
          Effect.timeoutOrElse({
            duration: options.timeoutSeconds * 1000,
            orElse: () =>
              Effect.fail(
                new ArmaTaskFailed({
                  stage,
                  status: "timeout",
                  message: `${stage} exceeded ${options.timeoutSeconds} seconds. The owned process was stopped; inspect its logs for startup or authorization failures.`,
                }),
              ),
          }),
        );
      if (action === "resources") {
        const log = yield* run("resources", [
          "-stavkaResourceQuery",
          options.query,
          "-stavkaRunId",
          runId,
          "-stavkaSourceHash",
          sourceHash,
          "-wbModule=ResourceManager",
          "-plugin=StavkaResourcesPlugin",
        ]);
        const path = resolve(profileRoot, "profile/stavka-resources.json");
        const inventory = yield* Schema.decodeUnknownEffect(
          Schema.fromJsonString(
            Schema.Struct({
              schema_version: Schema.Literal(1),
              run_id: Schema.String,
              source_hash: Schema.String,
              query: Schema.String,
              total: Schema.Number,
              resources: Schema.Array(Schema.String),
            }),
          ),
        )(yield* fs.readFileString(path));
        if (
          !log.includes("[StavkaTools] Resource lookup complete") ||
          inventory.run_id !== runId ||
          inventory.source_hash !== sourceHash ||
          inventory.query !== options.query ||
          /SCRIPT\s+\(E\)/u.test(log)
        ) {
          return yield* Effect.fail(
            new ArmaTaskFailed({
              stage: "resources",
              message: "Resource lookup did not produce valid evidence for this request.",
            }),
          );
        }
        yield* artifact(path);
        if (!execution.quiet) yield* Console.log(JSON.stringify(inventory, null, 2));
      } else if (action === "smoke") {
        yield* run(
          "smoke",
          [
            "-stavkaSmoke",
            "1",
            "-stavkaRunId",
            runId,
            "-stavkaSourceHash",
            sourceHash,
            ...(options.fail ? ["-stavkaSmokeFailure", "1"] : []),
            "-wbModule=WorldEditor",
            "-run",
            "-plugin=StavkaSmokePlugin",
          ],
          true,
        );
      } else {
        const validation = yield* run("validate", [
          "-wbSilent",
          "-exitAfterInit",
          "-wbModule=ScriptEditor",
          "-validate",
          options.target,
        ]);
        if (!validateWorkbenchLog(validation)) {
          return yield* Effect.fail(
            new ArmaTaskFailed({
              stage: "validate",
              message: "Native compilation failed or did not report completion.",
            }),
          );
        }
        if (action === "pack") {
          const packed = resolve(output, "packed");
          yield* fs.makeDirectory(packed, { recursive: true });
          // wbSilent exits before this build starts its packer.
          const log = yield* run("pack", [
            "-wbModule=ResourceManager",
            "-packAddon",
            "-packAddonDir",
            packed,
          ]);
          const files = yield* fs.readDirectory(packed, { recursive: true });
          if (
            !log.includes("Packaging project successful") ||
            !files.some((file) => file.endsWith(".pak")) ||
            /SCRIPT\s+\(E\)|RESOURCES\s+\(E\):.*(?:Stavka|Missions\/|Worlds\/)/iu.test(log)
          ) {
            return yield* Effect.fail(
              new ArmaTaskFailed({
                stage: "pack",
                message: "Packaging failed or produced no PAK files.",
              }),
            );
          }
          for (const file of files) yield* artifact(resolve(packed, file));
          const release = resolve(output, "release");
          yield* fs.makeDirectory(release, { recursive: true });
          yield* fs.copy(packed, resolve(release, "Stavka"));
          yield* fs.copyFile(sourceManifest, resolve(release, "sources.json"));
          yield* fs.writeFileString(
            resolve(release, "build.json"),
            JSON.stringify(
              {
                schemaVersion: 1,
                runId,
                engineVersion,
                sourceHash,
                validatedTargets: "ALL",
                addonGuid: "6A4B4D6187F605E0",
                containsDevelopmentPlugin: false,
              },
              null,
              2,
            ) + "\n",
          );
          const archive = resolve(output, "Stavka.zip");
          yield* createArmaArchive(release, archive, execution.quiet);
          yield* artifact(archive);
        }
      }
      if ((yield* fingerprintSources(repositoryRoot, includeTools)).hash !== sourceHash) {
        return yield* Effect.fail(
          new ArmaTaskFailed({ stage: action, message: "Sources changed during the native run." }),
        );
      }
    }).pipe(Effect.scoped);
    return yield* work.pipe(
      Effect.matchEffect({
        onFailure: (error) =>
          Effect.gen(function* () {
            const message = error instanceof ArmaTaskFailed ? error.message : String(error);
            yield* finish(
              error instanceof ArmaTaskFailed ? (error.status ?? "failed") : "failed",
              message,
            );
            return yield* Effect.fail(error);
          }),
        onSuccess: () =>
          finish(
            "passed",
            action === "doctor"
              ? "Matching installation, project sources and writable output verified."
              : "Native completion and artifacts verified.",
          ),
      }),
      Effect.onInterrupt(() =>
        finish("cancelled", "Native task interrupted; its scoped process was stopped."),
      ),
    );
  });
