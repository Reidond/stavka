import { resolve } from "node:path";
import { Context, Effect, FileSystem, Layer } from "effect";
import { ChildProcessSpawner } from "effect/unstable/process";
import { ArmaEnvironment } from "./arma-environment";
import { ArmaResult, parseArmaOptions, runArmaTask } from "./arma";
import { searchArmaDocs } from "./arma-docs";
import { inspectArmaRun } from "./arma-inspect";
import { EnfusionError, type RunInput, toNativeArguments } from "./enfusion-contract";

export type Inspection = Effect.Success<ReturnType<typeof inspectArmaRun>>;
export type Documentation = Effect.Success<ReturnType<typeof searchArmaDocs>>;

export class EnfusionBackend extends Context.Service<
  EnfusionBackend,
  {
    readonly doctor: Effect.Effect<Record<string, unknown>, EnfusionError>;
    readonly docs: (query: string) => Effect.Effect<Documentation, EnfusionError>;
    readonly run: (
      runId: string,
      input: RunInput,
    ) => Effect.Effect<typeof ArmaResult.Type, EnfusionError>;
    readonly inspect: (runId: string) => Effect.Effect<Inspection, EnfusionError>;
  }
>()("stavka/EnfusionBackend") {}

const failed = (error: unknown) =>
  new EnfusionError({
    code: "FAILED",
    message: error instanceof Error ? error.message : String(error),
  });

export const EnfusionBackendLive = (repositoryRoot: string) =>
  Layer.effect(
    EnfusionBackend,
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const environment = yield* ArmaEnvironment;
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const provide = <A, E>(
        effect: Effect.Effect<
          A,
          E,
          FileSystem.FileSystem | ArmaEnvironment | ChildProcessSpawner.ChildProcessSpawner
        >,
      ) =>
        effect.pipe(
          Effect.provideService(FileSystem.FileSystem, fs),
          Effect.provideService(ArmaEnvironment, environment),
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
          Effect.mapError(failed),
        );
      return {
        doctor: Effect.gen(function* () {
          const installation = yield* environment.inspect;
          const issues: Array<string> = [];
          if (installation.toolsVersion !== installation.gameVersion)
            issues.push("Game and Tools versions differ.");
          if (installation.editorPids.length)
            issues.push("An existing Workbench process must be closed before native jobs.");
          for (const project of ["mods/Stavka/addon.gproj", "mods/StavkaTools/addon.gproj"]) {
            if (!(yield* fs.exists(resolve(repositoryRoot, project))))
              issues.push(`Missing ${project}`);
          }
          if (yield* fs.exists(resolve(repositoryRoot, "out/arma/native.lock")))
            issues.push("A native task lock is present.");
          return { ...installation, repositoryRoot, ready: issues.length === 0, issues };
        }).pipe(Effect.mapError(failed)),
        docs: (query) => provide(searchArmaDocs([query])),
        run: (runId, input) =>
          provide(
            runArmaTask(repositoryRoot, input.action, toNativeArguments(input), {
              runId,
              quiet: true,
            }),
          ),
        inspect: (runId) => provide(inspectArmaRun(repositoryRoot, [runId])),
      };
    }),
  );

export const validateRunInput = (input: RunInput) =>
  parseArmaOptions(input.action, toNativeArguments(input)).pipe(
    Effect.mapError(
      (error) =>
        new EnfusionError({
          code: "INVALID_ARGUMENT",
          message: error instanceof Error ? error.message : String(error),
        }),
    ),
  );
