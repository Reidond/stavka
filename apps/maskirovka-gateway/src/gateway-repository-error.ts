import { Effect, Schema } from "effect";

export class GatewayRepositoryError extends Schema.TaggedErrorClass<GatewayRepositoryError>(
  "stavka/maskirovka-gateway/GatewayRepositoryError",
)("GatewayRepositoryError", {
  operation: Schema.String,
  message: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {}

export const repositoryEffect = <A>(
  operation: string,
  evaluate: () => A,
): Effect.Effect<A, GatewayRepositoryError> =>
  Effect.try({
    try: evaluate,
    catch: (cause) =>
      new GatewayRepositoryError({
        operation,
        message: cause instanceof Error ? cause.message : "Gateway repository operation failed",
        cause,
      }),
  });
