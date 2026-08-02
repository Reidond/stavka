import { mkdir } from "node:fs/promises";
import { Context, Effect, Layer } from "effect";

import { GatewayError } from "../domain/types";

export interface RuntimeDirectoryRepositoryService {
  readonly ensure: (paths: readonly string[]) => Effect.Effect<void, GatewayError>;
}

export class RuntimeDirectoryRepository extends Context.Service<
  RuntimeDirectoryRepository,
  RuntimeDirectoryRepositoryService
>()("@stavka/maskirovka/RuntimeDirectoryRepository") {}

export class FileRuntimeDirectoryRepository implements RuntimeDirectoryRepositoryService {
  ensure(paths: readonly string[]): Effect.Effect<void, GatewayError> {
    return Effect.tryPromise({
      try: async () => {
        await Promise.all(paths.map((path) => mkdir(path, { recursive: true, mode: 0o700 })));
      },
      catch: (cause) => new GatewayError(
        500,
        "RUNTIME_DIRECTORY_REPOSITORY_FAILURE",
        "Unable to prepare Maskirovka runtime directories",
        [cause instanceof Error ? cause.message : "Unknown runtime directory error"],
      ),
    });
  }
}

export const RuntimeDirectoryRepositoryLive: Layer.Layer<RuntimeDirectoryRepository> =
  Layer.succeed(RuntimeDirectoryRepository, new FileRuntimeDirectoryRepository());
