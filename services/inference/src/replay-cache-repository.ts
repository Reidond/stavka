import { Context, Effect } from "effect";

export class ReplayCacheError extends Error {
  constructor(
    readonly operation: "get" | "put",
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

export interface ReplayCacheRepositoryService {
  readonly get: (key: string) => Effect.Effect<unknown | undefined, ReplayCacheError>;
  readonly put: (key: string, value: unknown) => Effect.Effect<void, ReplayCacheError>;
}

export class ReplayCacheRepository extends Context.Service<
  ReplayCacheRepository,
  ReplayCacheRepositoryService
>()("stavka/maskirovka-gateway/ReplayCacheRepository") {}

/** R2-backed replay port; live provider requests do not require this binding. */
export class R2ReplayCacheRepository implements ReplayCacheRepositoryService {
  constructor(private readonly bucket: R2Bucket) {}

  get(key: string): Effect.Effect<unknown | undefined, ReplayCacheError> {
    return Effect.tryPromise({
      try: async () => {
        const object = await this.bucket.get(key);
        if (!object) return undefined;
        return JSON.parse(await object.text()) as unknown;
      },
      catch: (cause) =>
        new ReplayCacheError(
          "get",
          cause instanceof Error ? cause.message : "Replay cache read failed",
          {
            cause,
          },
        ),
    });
  }

  put(key: string, value: unknown): Effect.Effect<void, ReplayCacheError> {
    return Effect.tryPromise({
      try: () =>
        this.bucket.put(key, JSON.stringify(value), {
          httpMetadata: { contentType: "application/json" },
        }),
      catch: (cause) =>
        new ReplayCacheError(
          "put",
          cause instanceof Error ? cause.message : "Replay cache write failed",
          {
            cause,
          },
        ),
    });
  }
}

export class MemoryReplayCacheRepository implements ReplayCacheRepositoryService {
  private readonly values = new Map<string, unknown>();

  get(key: string): Effect.Effect<unknown | undefined> {
    return Effect.sync(() => this.values.get(key));
  }

  put(key: string, value: unknown): Effect.Effect<void> {
    return Effect.sync(() => {
      this.values.set(key, structuredClone(value));
    });
  }
}
