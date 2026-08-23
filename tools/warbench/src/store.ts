import { Effect, Schema } from "effect";
import { chmod, link, mkdir, open, readFile, readdir, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";

import {
  StudyConflict,
  StudyManifestSchema,
  StudyNotFound,
  StudyResultSchema,
  StudyStateInvalid,
  canonicalJson,
  computeStudyDigest,
  sortStudyResults,
  validateStudyResults,
  type StudyManifest,
  type StudyResult,
  type StudyStore,
} from "@stavka/warbench-core";

/**
 * File-backed immutable study store for operator CLI use. All directories are
 * owner-only, all files are written through fsync + atomic rename/link, and a
 * completed manifest carries the canonical digest it froze.
 */

const ensurePrivateDirectory = async (path: string): Promise<void> => {
  await mkdir(path, { recursive: true, mode: 0o700 });
  await chmod(path, 0o700);
};

const atomicWrite = async (
  path: string,
  value: string,
  options: { readonly exclusive?: boolean } = {},
): Promise<void> => {
  await ensurePrivateDirectory(dirname(path));
  const temporary = `${path}.${crypto.randomUUID()}.tmp`;
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.chmod(0o600);
    await handle.writeFile(value, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    if (options.exclusive) {
      await link(temporary, path);
    } else {
      await rename(temporary, path);
    }
  } finally {
    await rm(temporary, { force: true });
  }
};

const atomicWriteJson = (
  path: string,
  value: unknown,
  options: { readonly exclusive?: boolean } = {},
): Promise<void> => atomicWrite(path, `${JSON.stringify(value, null, 2)}\n`, options);

const readUnknown = async (path: string): Promise<unknown | undefined> => {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
};

const decodeManifest = (value: unknown, studyId: string): StudyManifest => {
  try {
    return Schema.decodeUnknownSync(StudyManifestSchema, { onExcessProperty: "error" })(value);
  } catch (cause) {
    throw new StudyStateInvalid({
      message: `manifest for ${studyId} is invalid: ${cause instanceof Error ? cause.message : String(cause)}`,
    });
  }
};

const decodeResult = (value: unknown, fileName: string): StudyResult => {
  try {
    return Schema.decodeUnknownSync(StudyResultSchema, { onExcessProperty: "error" })(value);
  } catch (cause) {
    throw new StudyStateInvalid({
      message: `result ${fileName} is invalid: ${cause instanceof Error ? cause.message : String(cause)}`,
    });
  }
};

const resultFileName = (result: StudyResult): string =>
  `${result.controller}-${result.family}-${result.seed}.json`;

const frozenManifestParameters = (manifest: StudyManifest): string =>
  canonicalJson({
    id: manifest.id,
    mode: manifest.mode,
    protocolVersion: manifest.protocolVersion,
    evidenceSchemaVersion: manifest.evidenceSchemaVersion,
    gitSha: manifest.gitSha,
    providerVersion: manifest.providerVersion,
    piVersion: manifest.piVersion,
    modelId: manifest.modelId,
    promptHash: manifest.promptHash,
    seeds: manifest.seeds,
    families: manifest.families,
    decisionEveryTicks: manifest.decisionEveryTicks,
    createdAt: manifest.createdAt,
  });

export class FileStudyStore implements StudyStore {
  readonly #dataDir: string;
  readonly #root: string;

  constructor(dataDir: string) {
    this.#dataDir = dataDir;
    this.#root = join(dataDir, "studies");
  }

  readonly #studyDir = (studyId: string): string => join(this.#root, studyId);

  readonly createStudy = (manifest: StudyManifest): Effect.Effect<void, StudyConflict> =>
    Effect.tryPromise({
      try: async () => {
        await ensurePrivateDirectory(this.#dataDir);
        await ensurePrivateDirectory(this.#root);
        await atomicWriteJson(join(this.#studyDir(manifest.id), "manifest.json"), manifest, {
          exclusive: true,
        });
      },
      catch: (cause) =>
        new StudyConflict({
          message:
            (cause as NodeJS.ErrnoException).code === "EEXIST"
              ? `study ${manifest.id} exists`
              : cause instanceof Error
                ? cause.message
                : "create failed",
        }),
    });

  readonly getStudy = (
    studyId: string,
  ): Effect.Effect<StudyManifest, StudyNotFound | StudyStateInvalid> =>
    Effect.tryPromise({
      try: async () => {
        const value = await readUnknown(join(this.#studyDir(studyId), "manifest.json"));
        if (value === undefined) throw new StudyNotFound({ message: `unknown study ${studyId}` });
        return decodeManifest(value, studyId);
      },
      catch: (cause) =>
        cause instanceof StudyNotFound || cause instanceof StudyStateInvalid
          ? cause
          : new StudyStateInvalid({
              message: `could not read study ${studyId}: ${cause instanceof Error ? cause.message : String(cause)}`,
            }),
    });

  readonly updateManifest = (
    manifest: StudyManifest,
  ): Effect.Effect<void, StudyNotFound | StudyStateInvalid> =>
    Effect.gen({ self: this }, function* () {
      const current = yield* this.getStudy(manifest.id);
      if (frozenManifestParameters(current) !== frozenManifestParameters(manifest)) {
        return yield* Effect.fail(
          new StudyStateInvalid({
            message: `study ${manifest.id} attempted to change frozen parameters`,
          }),
        );
      }
      if (
        (current.status === "completed" || current.status === "invalidated") &&
        canonicalJson(current) !== canonicalJson(manifest)
      ) {
        return yield* Effect.fail(
          new StudyStateInvalid({ message: `study ${manifest.id} is terminal` }),
        );
      }
      yield* Effect.promise(() =>
        atomicWriteJson(join(this.#studyDir(manifest.id), "manifest.json"), manifest),
      );
    });

  readonly recordResult = (
    result: StudyResult,
  ): Effect.Effect<void, StudyConflict | StudyStateInvalid | StudyNotFound> =>
    Effect.gen({ self: this }, function* () {
      const manifest = yield* this.getStudy(result.studyId);
      if (manifest.status === "completed") {
        return yield* Effect.fail(
          new StudyConflict({ message: `study ${result.studyId} is completed` }),
        );
      }
      if (manifest.status === "invalidated") {
        return yield* Effect.fail(
          new StudyStateInvalid({ message: `study ${result.studyId} was invalidated` }),
        );
      }
      const existing = yield* this.listResults(result.studyId);
      if (
        existing.some(
          (recorded) =>
            recorded.controller === result.controller &&
            recorded.family === result.family &&
            recorded.seed === result.seed,
        )
      ) {
        return yield* Effect.fail(
          new StudyConflict({
            message: `slot ${result.controller}/${result.family}/${result.seed} already filled`,
          }),
        );
      }
      const invalid = validateStudyResults(manifest, [...existing, result], false);
      if (invalid) return yield* Effect.fail(invalid);
      const path = join(this.#studyDir(result.studyId), "results", resultFileName(result));
      const written = yield* Effect.result(
        Effect.promise(() => atomicWriteJson(path, result, { exclusive: true })),
      );
      if (written._tag === "Failure") {
        const cause = written.failure as NodeJS.ErrnoException;
        if (cause.code === "EEXIST") {
          return yield* Effect.fail(
            new StudyConflict({
              message: `slot ${result.controller}/${result.family}/${result.seed} already filled`,
            }),
          );
        }
        return yield* Effect.die(cause);
      }
    });

  readonly listResults = (
    studyId: string,
  ): Effect.Effect<ReadonlyArray<StudyResult>, StudyNotFound | StudyStateInvalid> =>
    Effect.gen({ self: this }, function* () {
      yield* this.getStudy(studyId);
      const dir = join(this.#studyDir(studyId), "results");
      const names = yield* Effect.promise(() => readdir(dir).catch(() => [] as string[]));
      const results: StudyResult[] = [];
      for (const name of names.filter((candidate) => candidate.endsWith(".json")).sort()) {
        const value = yield* Effect.promise(() => readUnknown(join(dir, name)));
        if (value !== undefined) results.push(decodeResult(value, name));
      }
      return sortStudyResults(results);
    });

  readonly completeStudy = (
    studyId: string,
  ): Effect.Effect<string, StudyConflict | StudyStateInvalid | StudyNotFound> =>
    Effect.gen({ self: this }, function* () {
      const manifest = yield* this.getStudy(studyId);
      if (manifest.status === "invalidated") {
        return yield* Effect.fail(
          new StudyStateInvalid({ message: `study ${studyId} was invalidated` }),
        );
      }
      if (manifest.status === "completed") {
        if (!manifest.completionDigest) {
          return yield* Effect.fail(
            new StudyStateInvalid({ message: `completed study ${studyId} has no digest` }),
          );
        }
        return manifest.completionDigest;
      }
      const results = yield* this.listResults(studyId);
      const invalid = validateStudyResults(manifest, results, true);
      if (invalid) return yield* Effect.fail(invalid);
      const completedWithoutDigest: StudyManifest = {
        ...manifest,
        status: "completed",
        completedAt: manifest.completedAt ?? new Date().toISOString(),
      };
      const digest = yield* Effect.promise(() =>
        computeStudyDigest(completedWithoutDigest, results),
      );
      const completed: StudyManifest = { ...completedWithoutDigest, completionDigest: digest };
      yield* this.updateManifest(completed);
      const digestPath = join(this.#studyDir(studyId), "digest.txt");
      const written = yield* Effect.result(
        Effect.promise(() => atomicWrite(digestPath, `${digest}\n`, { exclusive: true })),
      );
      if (written._tag === "Failure") {
        const cause = written.failure as NodeJS.ErrnoException;
        if (cause.code !== "EEXIST") return yield* Effect.die(cause);
        const existing = (yield* Effect.promise(() => readFile(digestPath, "utf8"))).trim();
        if (existing !== digest) {
          return yield* Effect.fail(
            new StudyStateInvalid({
              message: `study ${studyId} digest file does not match manifest`,
            }),
          );
        }
      }
      return digest;
    });

  readonly invalidateStudy = (
    studyId: string,
  ): Effect.Effect<void, StudyConflict | StudyStateInvalid | StudyNotFound> =>
    Effect.gen({ self: this }, function* () {
      const manifest = yield* this.getStudy(studyId);
      if (manifest.status === "completed") {
        return yield* Effect.fail(new StudyConflict({ message: `study ${studyId} is completed` }));
      }
      if (manifest.status === "invalidated") return;
      yield* this.updateManifest({
        ...manifest,
        status: "invalidated",
        invalidatedAt: new Date().toISOString(),
      });
    });
}
