import { Effect } from "effect";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import {
  StudyConflict,
  StudyNotFound,
  StudyStateInvalid,
  type StudyManifest,
  type StudyResult,
  type StudyStore,
} from "@stavka/warbench-core";

/**
 * File-backed immutable study store for operator CLI use. Enforces the same
 * rules as the server-side Durable Object store: one attempt per slot,
 * results rejected in terminal states, completed studies never cleared.
 *
 * Layout under the data directory:
 *   studies/<id>/manifest.json
 *   studies/<id>/results/<arm>-<family>-<seed>.json
 *   studies/<id>/digest.txt          (written once at completion)
 */

const digestHex = async (value: unknown): Promise<string> => {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(JSON.stringify(value)),
  );
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
};

const readJson = async <T>(path: string): Promise<T | undefined> => {
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
};

const writeJson = async (path: string, value: unknown): Promise<void> => {
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
};

const resultFileName = (result: StudyResult): string =>
  `${result.controller}-${result.family}-${result.seed}.json`;

export class FileStudyStore implements StudyStore {
  readonly #root: string;

  constructor(dataDir: string) {
    this.#root = join(dataDir, "studies");
  }

  readonly #studyDir = (studyId: string): string => join(this.#root, studyId);

  readonly createStudy = (manifest: StudyManifest): Effect.Effect<void, StudyConflict> =>
    Effect.tryPromise({
      try: async () => {
        const manifestPath = join(this.#studyDir(manifest.id), "manifest.json");
        if ((await readJson<StudyManifest>(manifestPath)) !== undefined) {
          throw new StudyConflict({ message: `study ${manifest.id} exists` });
        }
        await writeJson(manifestPath, manifest);
      },
      catch: (cause) =>
        cause instanceof StudyConflict
          ? cause
          : new StudyConflict({
              message: cause instanceof Error ? cause.message : "create failed",
            }),
    });

  readonly getStudy = (studyId: string): Effect.Effect<StudyManifest, StudyNotFound> =>
    Effect.tryPromise({
      try: async () => {
        const manifest = await readJson<StudyManifest>(
          join(this.#studyDir(studyId), "manifest.json"),
        );
        if (!manifest) throw new Error(`missing study ${studyId}`);
        return manifest;
      },
      catch: () => new StudyNotFound({ message: `unknown study ${studyId}` }),
    });

  readonly updateManifest = (manifest: StudyManifest): Effect.Effect<void> =>
    Effect.promise(() => writeJson(join(this.#studyDir(manifest.id), "manifest.json"), manifest));

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
      const path = join(this.#studyDir(result.studyId), "results", resultFileName(result));
      if ((yield* Effect.promise(() => readJson<StudyResult>(path))) !== undefined) {
        return yield* Effect.fail(
          new StudyConflict({
            message: `slot ${result.controller}/${result.family}/${result.seed} already filled`,
          }),
        );
      }
      yield* Effect.promise(() => writeJson(path, result));
    });

  readonly listResults = (
    studyId: string,
  ): Effect.Effect<ReadonlyArray<StudyResult>, StudyNotFound> =>
    Effect.gen({ self: this }, function* () {
      yield* this.getStudy(studyId);
      const dir = join(this.#studyDir(studyId), "results");
      const names = yield* Effect.promise(() => readdir(dir).catch(() => [] as string[]));
      const results: StudyResult[] = [];
      for (const name of names.filter((candidate) => candidate.endsWith(".json"))) {
        const parsed = yield* Effect.promise(() => readJson<StudyResult>(join(dir, name)));
        if (parsed) results.push(parsed);
      }
      return results;
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
        return yield* Effect.fail(new StudyConflict({ message: `study ${studyId} is completed` }));
      }
      const results = yield* this.listResults(studyId);
      const completed: StudyManifest = {
        ...manifest,
        status: "completed",
        ...(manifest.completedAt ? {} : { completedAt: new Date().toISOString() }),
      };
      const digest = yield* Effect.promise(() => digestHex({ manifest: completed, results }));
      const digestPath = join(this.#studyDir(studyId), "digest.txt");
      if ((yield* Effect.promise(() => readJson<string>(digestPath))) === undefined) {
        yield* Effect.promise(() => writeJson(digestPath, digest));
      }
      yield* this.updateManifest(completed);
      return digest;
    });
}
