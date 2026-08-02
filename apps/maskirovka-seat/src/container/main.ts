import { NodeHttpServer, NodeRuntime } from "@effect/platform-node";
import { Config, Effect, Layer } from "effect";
import { HttpRouter } from "effect/unstable/http";
import { createServer } from "node:http";

import { parseAliases, parseProvider } from "../config";
import { createContainerRoutes } from "./app";
import { restoreSubscriptionAuth } from "./auth-state";
import { LiveSeatRunner } from "./runner";

const EnvironmentConfig = Config.all({
  provider: Config.string("MASKIROVKA_PROVIDER"),
  seatId: Config.string("MASKIROVKA_SEAT_ID"),
  aliases: Config.string("MASKIROVKA_MODEL_ALIASES"),
  port: Config.number("PORT").pipe(Config.withDefault(4141)),
});

const program = Effect.gen(function* () {
  const environment = yield* EnvironmentConfig;
  const provider = yield* Effect.try({
    try: () => parseProvider(environment.provider),
    catch: (cause) => cause,
  });
  const aliases = yield* Effect.try({
    try: () => parseAliases(environment.aliases),
    catch: (cause) => cause,
  });
  if (!Number.isInteger(environment.port) || environment.port <= 0 || environment.port > 65_535) {
    return yield* Effect.fail(new Error("PORT must be a valid TCP port"));
  }

  const authState = yield* restoreSubscriptionAuth(provider);

  const routes = createContainerRoutes({
    config: { provider, seatId: environment.seatId, aliases },
    runner: new LiveSeatRunner(provider),
    authConfigured: authState.configured,
    authCheckpoint: authState.checkpointAfterRotation,
  });

  yield* Effect.logInfo("Maskirovka seat container listening", {
    seat_id: environment.seatId,
    provider,
    port: environment.port,
    models: Object.values(aliases),
  });

  return yield* Layer.launch(
    HttpRouter.serve(routes).pipe(
      Layer.provide(
        NodeHttpServer.layer(createServer, {
          host: "0.0.0.0",
          port: environment.port,
        }),
      ),
    ),
  );
});

NodeRuntime.runMain(program);
