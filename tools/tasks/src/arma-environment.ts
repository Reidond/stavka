import { Config, Context, Data, Effect, Layer, Schema, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

export class ArmaTaskFailed extends Data.TaggedError("ArmaTaskFailed")<{
  readonly stage: string;
  readonly message: string;
  readonly status?: "failed" | "blocked" | "timeout";
}> {}

export const ArmaInstallation = Schema.Struct({
  executable: Schema.String,
  addons: Schema.String,
  gameExecutable: Schema.String,
  toolsVersion: Schema.String,
  gameVersion: Schema.String,
  editorPids: Schema.Array(Schema.Number),
});
export type ArmaInstallation = typeof ArmaInstallation.Type;

// Static Windows adapter: paths enter as environment values, never shell code.
// Read only installation metadata and process identities; no command lines,
// profiles, Steam account identities or credentials are collected.
const inspectInstallation = String.raw`
$ErrorActionPreference = 'Stop'
$steamRoot = (Get-ItemProperty 'HKCU:\Software\Valve\Steam' -ErrorAction SilentlyContinue).SteamPath
if (!$steamRoot) { $steamRoot = 'C:/Program Files (x86)/Steam' }
$libraries = @($steamRoot)
$libraryFile = Join-Path $steamRoot 'steamapps/libraryfolders.vdf'
if (Test-Path -LiteralPath $libraryFile) {
  $libraryText = [IO.File]::ReadAllText($libraryFile)
  foreach ($entry in [regex]::Matches($libraryText, '"path"\s+"([^"]+)"')) {
    $libraries += $entry.Groups[1].Value.Replace('\\', '\')
  }
}
$executable = $env:STAVKA_TOOLS_PATH
$addons = $env:STAVKA_ADDONS_PATH
foreach ($library in $libraries) {
  $candidate = Join-Path $library 'steamapps/common/Arma Reforger Tools/Workbench/ArmaReforgerWorkbenchSteamDiag.exe'
  if (!$executable -and (Test-Path -LiteralPath $candidate)) { $executable = $candidate }
  $candidate = Join-Path $library 'steamapps/common/Arma Reforger/addons'
  if (!$addons -and (Test-Path -LiteralPath $candidate)) { $addons = $candidate }
}
if (!$executable -or !$addons) { throw 'Matching Steam game and Tools installations were not found. Set ARMA_WORKBENCH_EXE and ARMA_REFORGER_ADDONS.' }
$gameExecutable = Join-Path (Split-Path $addons -Parent) 'ArmaReforgerSteam.exe'
$toolsFile = Get-Item -LiteralPath $executable
$gameFile = Get-Item -LiteralPath $gameExecutable
$editorPids = @(Get-Process -Name ArmaReforgerWorkbenchSteamDiag -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Id)
[ordered]@{
  executable = $toolsFile.FullName
  addons = (Get-Item -LiteralPath $addons).FullName
  gameExecutable = $gameFile.FullName
  toolsVersion = $toolsFile.VersionInfo.FileVersion
  gameVersion = $gameFile.VersionInfo.FileVersion
  editorPids = @($editorPids)
} | ConvertTo-Json -Compress
`;

export class ArmaEnvironment extends Context.Service<
  ArmaEnvironment,
  { readonly inspect: Effect.Effect<ArmaInstallation, ArmaTaskFailed> }
>()("stavka/tasks/ArmaEnvironment") {}

export const ArmaEnvironmentLive = Layer.effect(
  ArmaEnvironment,
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    return {
      inspect: Effect.gen(function* () {
        const executable = yield* Config.string("ARMA_WORKBENCH_EXE").pipe(Config.withDefault(""));
        const addons = yield* Config.string("ARMA_REFORGER_ADDONS").pipe(Config.withDefault(""));
        const child = yield* ChildProcess.make(
          "powershell.exe",
          ["-NoProfile", "-NonInteractive", "-Command", inspectInstallation],
          {
            env: { STAVKA_TOOLS_PATH: executable, STAVKA_ADDONS_PATH: addons },
            stdin: "ignore",
            stdout: "pipe",
            stderr: "pipe",
          },
        );
        const [stdout, stderr, code] = yield* Effect.all(
          [
            child.stdout.pipe(
              Stream.decodeText(),
              Stream.runCollect,
              Effect.map((chunks) => chunks.join("")),
            ),
            child.stderr.pipe(
              Stream.decodeText(),
              Stream.runCollect,
              Effect.map((chunks) => chunks.join("")),
            ),
            child.exitCode,
          ],
          { concurrency: "unbounded" },
        );
        if (code !== 0) {
          return yield* Effect.fail(
            new ArmaTaskFailed({ stage: "doctor", status: "blocked", message: stderr.trim() }),
          );
        }
        return yield* Schema.decodeUnknownEffect(Schema.fromJsonString(ArmaInstallation))(stdout);
      }).pipe(
        Effect.scoped,
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        Effect.timeout("20 seconds"),
        Effect.mapError((error) =>
          error instanceof ArmaTaskFailed
            ? error
            : new ArmaTaskFailed({
                stage: "doctor",
                status: "blocked",
                message: `Windows installation inspection failed: ${String(error)}`,
              }),
        ),
      ),
    };
  }),
);

export const createArmaArchive = (source: string, destination: string, quiet = false) =>
  Effect.gen(function* () {
    const child = yield* ChildProcess.make(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "$ErrorActionPreference = 'Stop'; Compress-Archive -LiteralPath $env:STAVKA_ARCHIVE_SOURCE -DestinationPath $env:STAVKA_ARCHIVE_TARGET -CompressionLevel Optimal",
      ],
      {
        env: { STAVKA_ARCHIVE_SOURCE: source, STAVKA_ARCHIVE_TARGET: destination },
        stdin: quiet ? "ignore" : "inherit",
        stdout: quiet ? "ignore" : "inherit",
        stderr: quiet ? "ignore" : "inherit",
      },
    );
    const code = yield* child.exitCode;
    if (code !== 0)
      return yield* Effect.fail(
        new ArmaTaskFailed({ stage: "archive", message: `ZIP creation exited ${code}.` }),
      );
  }).pipe(Effect.scoped, Effect.timeout("60 seconds"));
