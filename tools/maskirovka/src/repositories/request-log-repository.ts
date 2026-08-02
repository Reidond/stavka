import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { Context, Effect, Layer } from "effect";

import { GatewayError, type RequestMetadata } from "../domain/types";

export interface RequestLogRepositoryService {
  readonly append: (entry: RequestMetadata) => Effect.Effect<void, GatewayError>;
  readonly latest: (limit: number) => Effect.Effect<readonly RequestMetadata[], GatewayError>;
}

export class RequestLogRepository extends Context.Service<
  RequestLogRepository,
  RequestLogRepositoryService
>()("@stavka/maskirovka/RequestLogRepository") {}

const repositoryFailure = (cause: unknown): GatewayError =>
  new GatewayError(500, "REQUEST_LOG_REPOSITORY_FAILURE", "Unable to append the request log", [
    cause instanceof Error ? cause.message : "Unknown request log error",
  ]);

export class FileRequestLogRepository implements RequestLogRepositoryService {
  private readonly recent: RequestMetadata[] = [];

  constructor(private readonly filename: string, private readonly retain = 500) {}

  append(entry: RequestMetadata): Effect.Effect<void, GatewayError> {
    return Effect.tryPromise({
      try: async () => {
        this.recent.push(entry);
        if (this.recent.length > this.retain) {
          this.recent.splice(0, this.recent.length - this.retain);
        }
        await mkdir(dirname(this.filename), { recursive: true });
        await appendFile(this.filename, `${JSON.stringify(entry)}\n`, {
          encoding: "utf8",
          mode: 0o600,
        });
      },
      catch: repositoryFailure,
    });
  }

  latest(limit: number): Effect.Effect<readonly RequestMetadata[]> {
    return Effect.sync(() =>
      this.recent.slice(-Math.max(0, Math.min(limit, this.retain))).reverse());
  }
}

export class MemoryRequestLogRepository implements RequestLogRepositoryService {
  readonly entries: RequestMetadata[] = [];

  append(entry: RequestMetadata): Effect.Effect<void> {
    return Effect.sync(() => {
      this.entries.push(entry);
    });
  }

  latest(limit: number): Effect.Effect<readonly RequestMetadata[]> {
    return Effect.sync(() => this.entries.slice(-limit).reverse());
  }
}

export const RequestLogRepositoryLive = (
  filename: string,
  retain = 500,
): Layer.Layer<RequestLogRepository> =>
  Layer.succeed(RequestLogRepository, new FileRequestLogRepository(filename, retain));

export const RequestLogRepositoryMemory = (
  repository: MemoryRequestLogRepository = new MemoryRequestLogRepository(),
): Layer.Layer<RequestLogRepository> => Layer.succeed(RequestLogRepository, repository);
