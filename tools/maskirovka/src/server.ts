import { createServer, type Server } from "node:http";
import { NodeHttpServer } from "@effect/platform-node";
import { Effect, Layer, Scope } from "effect";
import { HttpRouter } from "effect/unstable/http";

import type { MaskirovkaConfig } from "./config";
import { FileStaticAssetRepository } from "./repositories/static-asset-repository";
import { createMaskirovkaApp } from "./router";
import type { GatewayService } from "./services/gateway-service";

const routerOptions = {
  routerConfig: { ignoreTrailingSlash: false },
} as const;

export const MaskirovkaServerLive = (
  config: MaskirovkaConfig,
  service: GatewayService,
  evaluate: () => Server = createServer,
) => HttpRouter.serve(
  createMaskirovkaApp({
    config,
    service,
    assets: new FileStaticAssetRepository(config.dashboardDirectory),
  }),
  routerOptions,
).pipe(
  Layer.provide(NodeHttpServer.layer(evaluate, {
    host: config.host,
    port: config.port,
  })),
);

export const serveMaskirovka = (
  config: MaskirovkaConfig,
  service: GatewayService,
): Effect.Effect<never, import("effect/unstable/http/HttpServerError").ServeError> =>
  Layer.launch(MaskirovkaServerLive(config, service));

const awaitListening = (server: Server): Effect.Effect<void> =>
  server.listening
    ? Effect.void
    : Effect.callback((resume) => {
        const listening = (): void => resume(Effect.void);
        server.once("listening", listening);
        return Effect.sync(() => server.off("listening", listening));
      });

/** Scoped integration-test adapter; closing the scope interrupts and closes the Node server. */
export const startServer = (
  config: MaskirovkaConfig,
  service: GatewayService,
): Effect.Effect<Server, never, Scope.Scope> => Effect.gen(function*() {
  const server = createServer();
  yield* Layer.launch(MaskirovkaServerLive(config, service, () => server)).pipe(
    Effect.forkScoped,
  );
  yield* awaitListening(server);
  return server;
});
