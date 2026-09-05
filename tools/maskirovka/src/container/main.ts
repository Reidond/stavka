import { NodeRuntime } from "@effect/platform-node";
import { Effect, Layer } from "effect";

import { loadConfig } from "../config";
import { createGatewayService } from "../runtime";
import { MaskirovkaServerLive } from "../server";
import { restoreGatewaySubscriptionAuth } from "./auth-state";

/**
 * Production Container entrypoint. It reads only the injected environment,
 * restores subscription credentials from MASKIROVKA_AUTH_STATE_B64, and launches
 * the existing gateway HttpApi through Effect Layers. CI smoke/replay commands stay outside the hosted image.
 */
const program = Effect.gen(function* () {
  yield* restoreGatewaySubscriptionAuth();
  const config = yield* loadConfig(process.env, process.cwd());
  const service = yield* createGatewayService(config);
  yield* Effect.logInfo("Maskirovka gateway container listening", {
    port: config.port,
    aliases: config.aliases.map((alias) => `${alias.tier}:${alias.seat}`),
  });
  return yield* Layer.launch(MaskirovkaServerLive(config, service));
});

NodeRuntime.runMain(program);
