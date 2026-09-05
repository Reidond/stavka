import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { Effect, FileSystem, Schema } from "effect";
import { ArmaTaskFailed } from "./arma-environment";

export const NativeSmokeResult = Schema.Struct({
  schema_version: Schema.Literal(1),
  run_id: Schema.String,
  source_hash: Schema.String,
  engine_version: Schema.String,
  passed: Schema.Boolean,
  phase: Schema.Number,
});

export const Diagnostic = Schema.Struct({
  severity: Schema.Literals(["error", "warning"]),
  file: Schema.String,
  line: Schema.Number,
  message: Schema.String,
});
export type Diagnostic = typeof Diagnostic.Type;

export const readDiagnostics = (log: string): ReadonlyArray<Diagnostic> => {
  const diagnostics = new Map<string, Diagnostic>();
  for (const line of log.split(/\r?\n/u)) {
    const native = /SCRIPT\s+\(([EW])\):\s*@"(.+),(\d+)":\s*(.*)/u.exec(line);
    const cli = /^(.+)\((\d+)\):\s*(error|warning):\s*(.*)/u.exec(line);
    const item: Diagnostic | undefined = native
      ? {
          severity: native[1] === "E" ? "error" : "warning",
          file: native[2]!,
          line: Number(native[3]),
          message: native[4]!,
        }
      : cli
        ? {
            severity: cli[3] === "error" ? "error" : "warning",
            file: cli[1]!,
            line: Number(cli[2]),
            message: cli[4]!,
          }
        : undefined;
    if (item) diagnostics.set(JSON.stringify(item), item);
  }
  return [...diagnostics.values()];
};

export const verifySmokeIdentity = (
  result: typeof NativeSmokeResult.Type,
  expected: { readonly runId: string; readonly sourceHash: string; readonly engineVersion: string },
): boolean =>
  result.run_id === expected.runId &&
  result.source_hash === expected.sourceHash &&
  result.engine_version === expected.engineVersion;

export const sha256 = (data: Uint8Array | string): string =>
  createHash("sha256").update(data).digest("hex");

export const fingerprintSources = (repositoryRoot: string, includeTools: boolean) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const roots = includeTools ? ["mods/Stavka", "mods/StavkaTools"] : ["mods/Stavka"];
    const files: Array<{ path: string; sha256: string; bytes: number }> = [];
    for (const root of roots) {
      for (const file of (yield* fs.readDirectory(resolve(repositoryRoot, root), {
        recursive: true,
      })).sort()) {
        if (!/\.(?:c|gproj|conf|meta|ent|layer)$/iu.test(file)) continue;
        const data = yield* fs.readFile(resolve(repositoryRoot, root, file));
        files.push({
          path: `${root}/${file.replaceAll("\\", "/")}`,
          sha256: sha256(data),
          bytes: data.byteLength,
        });
      }
    }
    if (files.length === 0)
      return yield* Effect.fail(
        new ArmaTaskFailed({ stage: "source", message: "No addon sources found." }),
      );
    return { hash: sha256(JSON.stringify(files)), files };
  });
