import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { Context, Effect, Layer, Schema } from "effect";

import { GatewayError, seatKinds } from "../domain/types";

const PersistedWindowEntry = Schema.Struct({
  seat: Schema.Literals(seatKinds),
  at: Schema.Number,
  tokens: Schema.Number,
  outcome: Schema.optional(Schema.Literals(["success", "failure"])),
  failureCode: Schema.optional(Schema.String),
});

const PersistedMonthlyUsage = Schema.Struct({
  seat: Schema.Literals(seatKinds),
  month: Schema.String,
  usd: Schema.Number,
});

const PersistedReservation = Schema.Struct({
  id: Schema.String,
  seat: Schema.Literals(seatKinds),
  at: Schema.Number,
  expiresAt: Schema.Number,
  expectedTokens: Schema.Number,
  expectedPlanCreditUsd: Schema.Number,
});

export const PersistedWindowTracker = Schema.Struct({
  version: Schema.Literal(1),
  startedAt: Schema.String,
  entries: Schema.Array(PersistedWindowEntry),
  monthlyUsage: Schema.Array(PersistedMonthlyUsage),
  reservations: Schema.optional(Schema.Array(PersistedReservation)),
  totals: Schema.Struct({
    requests: Schema.Number,
    cacheHits: Schema.Number,
    inputTokens: Schema.Number,
    outputTokens: Schema.Number,
    actualCostUsd: Schema.Number,
    planCreditUsd: Schema.Number,
    apiListEquivalentUsd: Schema.Number,
    savedVsApiUsd: Schema.Number,
  }),
});
export type PersistedWindowTracker = typeof PersistedWindowTracker.Type;

export interface WindowTrackerRepositoryService {
  readonly durable: boolean;
  readonly load: () => Effect.Effect<PersistedWindowTracker | undefined, GatewayError>;
  readonly save: (snapshot: PersistedWindowTracker) => Effect.Effect<void, GatewayError>;
}

export class WindowTrackerRepository extends Context.Service<
  WindowTrackerRepository,
  WindowTrackerRepositoryService
>()("@stavka/maskirovka/WindowTrackerRepository") {}

const repositoryFailure = (operation: string, cause: unknown): GatewayError =>
  new GatewayError(
    500,
    "WINDOW_TRACKER_REPOSITORY_FAILURE",
    `Unable to ${operation} usage tracker`,
    [cause instanceof Error ? cause.message : "Unknown usage tracker repository error"],
  );

export class FileWindowTrackerRepository implements WindowTrackerRepositoryService {
  readonly durable = true;

  constructor(private readonly filename: string) {}

  load(): Effect.Effect<PersistedWindowTracker | undefined, GatewayError> {
    return Effect.tryPromise({
      try: async () => {
        try {
          return await readFile(this.filename, "utf8");
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
          throw error;
        }
      },
      catch: (cause) => repositoryFailure("read", cause),
    }).pipe(
      Effect.flatMap((encoded) =>
        encoded === undefined
          ? Effect.succeed(undefined)
          : Schema.decodeUnknownEffect(Schema.fromJsonString(PersistedWindowTracker), {
              onExcessProperty: "error",
            })(encoded).pipe(Effect.mapError((cause) => repositoryFailure("decode", cause))),
      ),
    );
  }

  save(snapshot: PersistedWindowTracker): Effect.Effect<void, GatewayError> {
    return Schema.encodeEffect(Schema.fromJsonString(PersistedWindowTracker))(snapshot).pipe(
      Effect.mapError((cause) => repositoryFailure("encode", cause)),
      Effect.flatMap((encoded) =>
        Effect.tryPromise({
          try: async () => {
            await mkdir(dirname(this.filename), { recursive: true });
            const temporary = `${this.filename}.${process.pid}.${crypto.randomUUID()}.tmp`;
            await writeFile(temporary, `${encoded}\n`, { encoding: "utf8", mode: 0o600 });
            await rename(temporary, this.filename);
          },
          catch: (cause) => repositoryFailure("write", cause),
        }),
      ),
    );
  }
}

export class MemoryWindowTrackerRepository implements WindowTrackerRepositoryService {
  readonly durable = false;
  value?: PersistedWindowTracker;

  load(): Effect.Effect<PersistedWindowTracker | undefined> {
    return Effect.sync(() => this.value);
  }

  save(snapshot: PersistedWindowTracker): Effect.Effect<void> {
    return Effect.sync(() => {
      this.value = structuredClone(snapshot);
    });
  }
}

export const WindowTrackerRepositoryLive = (
  filename: string,
): Layer.Layer<WindowTrackerRepository> =>
  Layer.succeed(WindowTrackerRepository, new FileWindowTrackerRepository(filename));
