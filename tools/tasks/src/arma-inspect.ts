import { isAbsolute, relative, resolve } from "node:path";
import { Console, Effect, FileSystem, Schema } from "effect";
import { ArmaResult } from "./arma";
import { ArmaTaskFailed } from "./arma-environment";
import { sha256 } from "./arma-evidence";

export const inspectArmaRun = (repositoryRoot: string, args: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const runId = args[0] ?? "";
    if (
      args.length !== 1 ||
      !/^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/iu.test(runId)
    ) {
      return yield* Effect.fail(
        new ArmaTaskFailed({
          stage: "inspect",
          message: "Provide the UUID of a completed native run.",
        }),
      );
    }
    const fs = yield* FileSystem.FileSystem;
    const runRoot = resolve(repositoryRoot, "out/arma", runId);
    const result = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(ArmaResult))(
      yield* fs.readFileString(resolve(runRoot, "result.json")),
    );
    if (result.runId !== runId)
      return yield* Effect.fail(
        new ArmaTaskFailed({ stage: "inspect", message: "Stored run identity mismatch." }),
      );
    const invalid: Array<string> = [];
    for (const artifact of result.artifacts) {
      const localPath = relative(runRoot, artifact.path);
      if (
        isAbsolute(localPath) ||
        localPath === ".." ||
        localPath.startsWith(`..\\`) ||
        localPath.startsWith("../")
      ) {
        invalid.push(artifact.path);
        continue;
      }
      const actual = yield* fs.readFile(artifact.path).pipe(
        Effect.map(sha256),
        Effect.catch(() => Effect.succeed("missing")),
      );
      if (actual !== artifact.sha256) invalid.push(artifact.path);
    }
    return {
      ...result,
      artifactIntegrity: invalid.length ? ("failed" as const) : ("verified" as const),
      invalidArtifacts: invalid,
    };
  });

export const runArmaInspect = (repositoryRoot: string, args: ReadonlyArray<string>) =>
  inspectArmaRun(repositoryRoot, args).pipe(
    Effect.flatMap((result) =>
      Effect.gen(function* () {
        yield* Console.log(JSON.stringify(result, null, 2));
        if (result.artifactIntegrity === "failed")
          return yield* Effect.fail(
            new ArmaTaskFailed({
              stage: "inspect",
              message: "Artifact digest verification failed.",
            }),
          );
      }),
    ),
  );
