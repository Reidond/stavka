import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Context, Effect, Layer } from "effect";

import { GatewayError, type CachedGatewayResponse } from "../domain/types";

export interface CacheRepositoryService {
  readonly get: (key: string) => Effect.Effect<CachedGatewayResponse | undefined, GatewayError>;
  readonly put: (entry: CachedGatewayResponse) => Effect.Effect<void, GatewayError>;
}

export class CacheRepository extends Context.Service<CacheRepository, CacheRepositoryService>()(
  "@stavka/maskirovka/CacheRepository",
) {}

const repositoryFailure = (operation: string, cause: unknown): GatewayError =>
  new GatewayError(500, "CACHE_REPOSITORY_FAILURE", `Unable to ${operation} the response cache`, [
    cause instanceof Error ? cause.message : "Unknown cache error",
  ]);

export class FileCacheRepository implements CacheRepositoryService {
  constructor(private readonly directory: string) {}

  get(key: string): Effect.Effect<CachedGatewayResponse | undefined, GatewayError> {
    return Effect.tryPromise({
      try: async () => {
        try {
          const value = JSON.parse(
            await readFile(join(this.directory, `${key}.json`), "utf8"),
          ) as CachedGatewayResponse;
          return value.version === 1 && value.key === key ? value : undefined;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
          throw error;
        }
      },
      catch: (cause) => repositoryFailure("read", cause),
    });
  }

  put(entry: CachedGatewayResponse): Effect.Effect<void, GatewayError> {
    return Effect.tryPromise({
      try: async () => {
        await mkdir(this.directory, { recursive: true });
        const destination = join(this.directory, `${entry.key}.json`);
        const temporary = `${destination}.${process.pid}.${crypto.randomUUID()}.tmp`;
        await writeFile(temporary, `${JSON.stringify(entry, null, 2)}\n`, {
          encoding: "utf8",
          mode: 0o600,
        });
        await rename(temporary, destination);
      },
      catch: (cause) => repositoryFailure("write", cause),
    });
  }
}

export class MemoryCacheRepository implements CacheRepositoryService {
  readonly entries = new Map<string, CachedGatewayResponse>();

  get(key: string): Effect.Effect<CachedGatewayResponse | undefined> {
    return Effect.sync(() => this.entries.get(key));
  }

  put(entry: CachedGatewayResponse): Effect.Effect<void> {
    return Effect.sync(() => {
      this.entries.set(entry.key, entry);
    });
  }
}

export const CacheRepositoryLive = (directory: string): Layer.Layer<CacheRepository> =>
  Layer.succeed(CacheRepository, new FileCacheRepository(directory));

export const CacheRepositoryMemory = (
  repository: MemoryCacheRepository = new MemoryCacheRepository(),
): Layer.Layer<CacheRepository> => Layer.succeed(CacheRepository, repository);
