#!/usr/bin/env node
import { join, resolve } from "node:path";
import { NodeRuntime } from "@effect/platform-node";
import { Console, Effect } from "effect";
import { HttpRouter } from "effect/unstable/http";
import { loadConfig, type MaskirovkaConfig } from "./config";
import { canonicalJson } from "./domain/canonical";
import { normalizeRequest } from "./domain/protocol";
import { GatewayError } from "./domain/types";
import {
  FileCacheRepository,
  MemoryCacheRepository,
  type CacheRepositoryService,
} from "./repositories/cache-repository";
import { MemoryGatewayConfigRepository } from "./repositories/config-repository";
import { MemoryRequestLogRepository } from "./repositories/request-log-repository";
import { createMaskirovkaApp } from "./router";
import { MockSeat } from "./seats/mock-seat";
import type { SeatAdapter } from "./seats/seat-adapter";
import { GatewayService } from "./services/gateway-service";
import { SeatRegistry } from "./services/seat-registry";

const packageRoot = resolve(import.meta.dirname, "..");
const hasFlag = (name: string): boolean => process.argv.includes(name);
const ciConfig = () =>
  loadConfig({ ENVIRONMENT: "local", DEV_ACCESS_EMAIL: "ci@localhost" }, packageRoot);

const sampleBody = {
  model: "stavka/commander",
  instructions: "You are a deterministic military planner.",
  input: "Hold the current objective and return no commands.",
  text: {
    format: {
      type: "json_schema",
      name: "decision",
      schema: {
        type: "object",
        properties: {
          summary: { type: "string" },
          commands: { type: "array", items: { type: "object" } },
        },
        required: ["summary", "commands"],
        additionalProperties: false,
      },
    },
  },
} as const;

const sampleAnthropicBody = {
  model: "stavka/commander",
  max_tokens: 64,
  messages: [{ role: "user", content: "Hold the current objective and return no commands." }],
  output_config: {
    format: {
      type: "json_schema",
      schema: sampleBody.text.format.schema,
    },
  },
} as const;

const memoryService = (
  config: MaskirovkaConfig,
  cache: CacheRepositoryService = new MemoryCacheRepository(),
  adapters: readonly SeatAdapter[] = [new MockSeat()],
): Effect.Effect<GatewayService, GatewayError> =>
  Effect.gen(function* () {
    const configRepository = new MemoryGatewayConfigRepository();
    const registry = new SeatRegistry(
      config.aliases,
      config.seats,
      configRepository,
      config.apiFallbackAliases,
    );
    const service = new GatewayService(
      config,
      registry,
      cache,
      new MemoryRequestLogRepository(),
      adapters,
    );
    yield* service.initialize();
    return service;
  });

const withWebHandler = <A, E, R>(
  app: ReturnType<typeof createMaskirovkaApp>,
  use: (handler: (request: Request) => Promise<Response>) => Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R | import("effect/Scope").Scope> =>
  Effect.acquireRelease(
    Effect.sync(() =>
      HttpRouter.toWebHandler(app, {
        disableLogger: true,
        routerConfig: { ignoreTrailingSlash: false },
      }),
    ),
    ({ dispose }) => Effect.promise(() => dispose()),
  ).pipe(Effect.flatMap(({ handler }) => use(handler)));

const runSmoke = (): Effect.Effect<void, unknown> =>
  Effect.scoped(
    Effect.gen(function* () {
      const loaded = yield* ciConfig();
      const { apiKey: _apiKey, ...withoutKey } = loaded;
      const config: MaskirovkaConfig = { ...withoutKey, mode: "live" };
      const service = yield* memoryService(config);
      const app = createMaskirovkaApp({
        config,
        service,
        assets: { read: () => Effect.succeed(undefined) },
      });
      const responses = yield* withWebHandler(app, (handler) =>
        Effect.all(
          [
            Effect.tryPromise(() => handler(new Request("http://maskirovka.local/healthz"))),
            Effect.tryPromise(() => handler(new Request("http://maskirovka.local/v1/models"))),
            Effect.tryPromise(() =>
              handler(
                new Request("http://maskirovka.local/v1/responses", {
                  method: "POST",
                  headers: { "content-type": "application/json" },
                  body: JSON.stringify(sampleBody),
                }),
              ),
            ),
            Effect.tryPromise(() =>
              handler(
                new Request("http://maskirovka.local/v1/messages?beta=true", {
                  method: "POST",
                  headers: { "content-type": "application/json" },
                  body: JSON.stringify({
                    model: "stavka/sergeant",
                    max_tokens: 64,
                    messages: [{ role: "user", content: "Hold position." }],
                  }),
                }),
              ),
            ),
          ],
          { concurrency: "unbounded" },
        ),
      );
      if (responses.some((response) => !response.ok)) {
        return yield* Effect.fail(
          new Error(
            `Smoke failed with statuses ${responses.map((response) => response.status).join(", ")}`,
          ),
        );
      }
      yield* Console.log(
        JSON.stringify({
          ok: true,
          statuses: responses.map((response) => response.status),
        }),
      );
    }),
  );

const runEval = (): Effect.Effect<void, unknown> =>
  Effect.gen(function* () {
    const base = yield* ciConfig();
    if (!hasFlag("--replay") && base.mode !== "replay") {
      return yield* Effect.fail(
        new Error("eval requires --replay; record/live evals are deliberate operator actions"),
      );
    }
    let networkCalls = 0;
    const forbiddenSeat: SeatAdapter = {
      id: "mock",
      invoke: () =>
        Effect.sync(() => {
          networkCalls += 1;
          throw new Error("Replay attempted to invoke a seat");
        }),
    };
    const replay = yield* memoryService(
      { ...base, mode: "replay" },
      new FileCacheRepository(join(packageRoot, "replay-corpus")),
      [forbiddenSeat],
    );
    const scenarios = [
      normalizeRequest("openai-responses", sampleBody),
      normalizeRequest("anthropic-messages", sampleAnthropicBody),
    ];
    for (const scenario of scenarios) {
      const replayed = yield* replay.run(scenario);
      if (!replayed.metadata.cacheHit || networkCalls !== 0) {
        return yield* Effect.fail(new Error("Tracked replay corpus touched a seat"));
      }
      const second = yield* replay.run(scenario);
      if (canonicalJson(replayed.body) !== canonicalJson(second.body)) {
        return yield* Effect.fail(new Error("Replay corpus was not byte-deterministic"));
      }
    }
    yield* Console.log(
      JSON.stringify({
        ok: true,
        mode: "replay",
        cacheHit: true,
        networkCalls,
        scenarios: scenarios.length,
      }),
    );
  });

const main = Effect.gen(function* () {
  const command = process.argv[2];
  if (command === "smoke") return yield* runSmoke();
  if (command === "eval") return yield* runEval();
  return yield* Effect.fail(
    new Error(
      "Use smoke or eval --replay for CI. Run the app and live models at https://stavka.sands.red.",
    ),
  );
});

NodeRuntime.runMain(main);
