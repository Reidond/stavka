import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { Context, Effect, Layer } from "effect";

import { GatewayError, type AliasResolution } from "../domain/types";

export interface PersistedGatewayConfig {
  readonly aliases: readonly AliasResolution[];
  readonly killed: boolean;
}

export interface GatewayConfigRepositoryService {
  readonly load: () => Effect.Effect<PersistedGatewayConfig | undefined, GatewayError>;
  readonly save: (config: PersistedGatewayConfig) => Effect.Effect<void, GatewayError>;
}

export class GatewayConfigRepository extends Context.Service<
  GatewayConfigRepository,
  GatewayConfigRepositoryService
>()("@stavka/maskirovka/GatewayConfigRepository") {}

const repositoryFailure = (operation: string, cause: unknown): GatewayError =>
  new GatewayError(500, "CONFIG_REPOSITORY_FAILURE", `Unable to ${operation} gateway configuration`, [
    cause instanceof Error ? cause.message : "Unknown gateway configuration error",
  ]);

export class FileGatewayConfigRepository implements GatewayConfigRepositoryService {
  constructor(private readonly filename: string) {}

  load(): Effect.Effect<PersistedGatewayConfig | undefined, GatewayError> {
    return Effect.tryPromise({
      try: async () => {
        try {
          return JSON.parse(await readFile(this.filename, "utf8")) as PersistedGatewayConfig;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
          throw error;
        }
      },
      catch: (cause) => repositoryFailure("read", cause),
    });
  }

  save(config: PersistedGatewayConfig): Effect.Effect<void, GatewayError> {
    return Effect.tryPromise({
      try: async () => {
        await mkdir(dirname(this.filename), { recursive: true });
        const temporary = `${this.filename}.${process.pid}.${crypto.randomUUID()}.tmp`;
        await writeFile(temporary, `${JSON.stringify(config, null, 2)}\n`, {
          encoding: "utf8",
          mode: 0o600,
        });
        await rename(temporary, this.filename);
      },
      catch: (cause) => repositoryFailure("write", cause),
    });
  }
}

export class MemoryGatewayConfigRepository implements GatewayConfigRepositoryService {
  value?: PersistedGatewayConfig;

  load(): Effect.Effect<PersistedGatewayConfig | undefined> {
    return Effect.sync(() => this.value);
  }

  save(config: PersistedGatewayConfig): Effect.Effect<void> {
    return Effect.sync(() => {
      this.value = config;
    });
  }
}

export const GatewayConfigRepositoryLive = (
  filename: string,
): Layer.Layer<GatewayConfigRepository> =>
  Layer.succeed(GatewayConfigRepository, new FileGatewayConfigRepository(filename));

export const GatewayConfigRepositoryMemory = (
  repository: MemoryGatewayConfigRepository = new MemoryGatewayConfigRepository(),
): Layer.Layer<GatewayConfigRepository> => Layer.succeed(GatewayConfigRepository, repository);
