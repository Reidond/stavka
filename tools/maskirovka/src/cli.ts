#!/usr/bin/env node
import { hostname } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { NodeRuntime } from "@effect/platform-node";
import { Console, Effect } from "effect";
import { HttpRouter } from "effect/unstable/http";

import { loadConfig, type MaskirovkaConfig } from "./config";
import { canonicalJson } from "./domain/canonical";
import { normalizeRequest } from "./domain/protocol";
import { GatewayError, type SeatInvocation } from "./domain/types";
import {
  FileCacheRepository,
  MemoryCacheRepository,
  type CacheRepositoryService,
} from "./repositories/cache-repository";
import { ProcessCliProbeRepository } from "./repositories/cli-probe-repository";
import { MemoryGatewayConfigRepository } from "./repositories/config-repository";
import { FileDevVarsRepository } from "./repositories/dev-vars-repository";
import { MemoryRequestLogRepository } from "./repositories/request-log-repository";
import { FileRuntimeDirectoryRepository } from "./repositories/runtime-directory-repository";
import { FileWindowTrackerRepository } from "./repositories/window-tracker-repository";
import { createMaskirovkaApp } from "./router";
import { createGatewayService } from "./runtime";
import { ClaudeSeat } from "./seats/claude-seat";
import { CodexSeat } from "./seats/codex-seat";
import { MockSeat } from "./seats/mock-seat";
import type { SeatAdapter } from "./seats/seat-adapter";
import { serveMaskirovka } from "./server";
import { DoctorService } from "./services/doctor-service";
import { GatewayService } from "./services/gateway-service";
import { runContributorSeat } from "./services/contributor-seat-service";
import { SeatRegistry } from "./services/seat-registry";
import { WindowTracker } from "./services/window-tracker";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = resolve(packageRoot, "../..");

const argumentValue = (name: string): string | undefined => {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
};

const hasFlag = (name: string): boolean => process.argv.includes(name);

const configWithArguments = (
  forceLocal = false,
): Effect.Effect<MaskirovkaConfig, import("effect/Config").ConfigError> => {
  const mode = argumentValue("--mode");
  const host = argumentValue("--host");
  const port = argumentValue("--port");
  const key = argumentValue("--key");
  const liveSergeants = argumentValue("--live-sergeants");
  return loadConfig(
    {
      ...process.env,
      ...(forceLocal
        ? {
            ENVIRONMENT: "local",
            DEV_ACCESS_EMAIL: process.env.DEV_ACCESS_EMAIL ?? "developer@localhost",
          }
        : {}),
      ...(mode ? { MASKIROVKA_MODE: mode } : {}),
      ...(host ? { MASKIROVKA_HOST: host } : {}),
      ...(port ? { MASKIROVKA_PORT: port } : {}),
      ...(key ? { MASKIROVKA_SEAT_KEY: key } : {}),
      ...(liveSergeants ? { MASKIROVKA_LIVE_SERGEANTS: liveSergeants } : {}),
    },
    packageRoot,
  );
};

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

const printDoctor = (
  config: MaskirovkaConfig,
  write = true,
): Effect.Effect<boolean, GatewayError> =>
  Effect.gen(function* () {
    const codexWorkspace = join(config.stateDirectory, "codex-workspace");
    yield* new FileRuntimeDirectoryRepository().ensure([codexWorkspace]);
    const pingRequest = (seat: "claude" | "codex"): SeatInvocation => ({
      dialect: seat === "claude" ? "anthropic-messages" : "openai-responses",
      tier: "stavka/sergeant",
      request: { model: "stavka/sergeant", input: "Reply OK" },
      prompt: "Reply with OK only.",
      model: seat === "claude" ? "claude-sonnet-5" : "gpt-5.6-luna",
    });
    const doctor = new DoctorService(
      config,
      new ProcessCliProbeRepository(),
      new FileDevVarsRepository(),
      repositoryRoot,
      (seat) =>
        seat === "claude"
          ? new ClaudeSeat().invoke(pingRequest(seat)).pipe(Effect.asVoid)
          : new CodexSeat(codexWorkspace).invoke(pingRequest(seat)).pipe(Effect.asVoid),
    );
    const report = yield* doctor.run({ live: hasFlag("--live"), write });
    yield* Console.log(JSON.stringify(report, null, 2));
    return report.ok;
  });

const contributorModelDefaults = {
  claude: {
    "stavka/commander": "claude-fable-5",
    "stavka/sergeant": "claude-sonnet-5",
    "stavka/heavy": "claude-opus-5",
  },
  codex: {
    "stavka/commander": "gpt-5.6-sol",
    "stavka/sergeant": "gpt-5.6-luna",
    "stavka/heavy": "gpt-5.6-terra",
  },
} as const;

const contributorSeatId = (provider: "claude" | "codex"): string => {
  const machine = hostname()
    .toLowerCase()
    .replace(/[^a-z0-9._:-]+/gu, "-")
    .slice(0, 96);
  return `${machine || "maskirovka"}-${provider}`;
};

const runContributor = (
  config: MaskirovkaConfig,
  endpoint: string,
  token: string,
): Effect.Effect<never, unknown> =>
  Effect.gen(function* () {
    const parsedEndpoint = yield* Effect.try({
      try: () => new URL(endpoint),
      catch: (cause) => new Error("--register must be a valid ws:// or wss:// URL", { cause }),
    });
    if (parsedEndpoint.protocol !== "ws:" && parsedEndpoint.protocol !== "wss:") {
      return yield* Effect.fail(new Error("--register must use ws:// or wss://"));
    }
    if (token.trim() === "") {
      return yield* Effect.fail(new Error("serve --register requires a non-empty --token"));
    }
    const selectedProvider = argumentValue("--provider");
    if (
      selectedProvider !== undefined &&
      selectedProvider !== "claude" &&
      selectedProvider !== "codex"
    ) {
      return yield* Effect.fail(new Error("--provider must be claude or codex"));
    }
    const providers = (["claude", "codex"] as const).filter(
      (provider) => selectedProvider === undefined || selectedProvider === provider,
    );
    const configured = providers.flatMap((provider) => {
      const seat = config.seats.find((candidate) => candidate.id === provider);
      return seat !== undefined && seat.monthlyBudgetUsd > 0 ? [{ provider, seat }] : [];
    });
    if (configured.length === 0) {
      return yield* Effect.fail(
        new Error(
          "No contributor seat has a positive budget; configure MASKIROVKA_CLAUDE_MONTHLY_CREDIT_USD or MASKIROVKA_CODEX_BUDGET_USD",
        ),
      );
    }
    const explicitSeatId = argumentValue("--seat-id");
    if (explicitSeatId !== undefined && configured.length !== 1) {
      return yield* Effect.fail(new Error("--seat-id requires selecting one --provider"));
    }
    if (
      explicitSeatId !== undefined &&
      (explicitSeatId.length > 128 || !/^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/u.test(explicitSeatId))
    ) {
      return yield* Effect.fail(
        new Error("--seat-id must be a valid contributor protocol seat id"),
      );
    }
    const codexWorkspace = join(config.stateDirectory, "codex-workspace");
    if (configured.some(({ provider }) => provider === "codex")) {
      yield* new FileRuntimeDirectoryRepository().ensure([codexWorkspace]);
    }
    yield* Console.log(
      `Registering contributor seat(s): ${configured.map(({ provider }) => provider).join(", ")}`,
    );
    const programs = configured.map(({ provider, seat }) => {
      const id = explicitSeatId ?? contributorSeatId(provider);
      const configuredModel = (tier: "stavka/commander" | "stavka/sergeant" | "stavka/heavy") =>
        config.aliases.find((alias) => alias.seat === provider && alias.tier === tier)?.model ??
        contributorModelDefaults[provider][tier];
      return runContributorSeat({
        endpoint: parsedEndpoint.toString(),
        token,
        id,
        name: `${hostname()} ${provider} subscription seat`.slice(0, 160),
        provider,
        models: ["stavka/commander", "stavka/sergeant", "stavka/heavy"],
        monthlyBudgetUsd: seat.monthlyBudgetUsd,
        priority: seat.priority,
        modelByTier: {
          "stavka/commander": configuredModel("stavka/commander"),
          "stavka/sergeant": configuredModel("stavka/sergeant"),
          "stavka/heavy": configuredModel("stavka/heavy"),
        },
        adapter: provider === "claude" ? new ClaudeSeat() : new CodexSeat(codexWorkspace),
        codexWindowCallLimit: config.codexWindowCallLimit,
        codexWindowTokenLimit: config.codexWindowTokenLimit,
        codexWindowHours: config.codexWindowHours,
        tracker: new WindowTracker(
          {
            claudeMonthlyCreditUsd: provider === "claude" ? config.claudeMonthlyCreditUsd : 0,
            codexWindowCalls: config.codexWindowCallLimit,
            codexWindowTokens: config.codexWindowTokenLimit,
            codexWindowMs: config.codexWindowHours * 60 * 60 * 1_000,
          },
          new FileWindowTrackerRepository(
            join(config.stateDirectory, `contributor-${id}-usage.json`),
          ),
        ),
      });
    });
    yield* Effect.all(programs, { concurrency: "unbounded", discard: true });
    return yield* Effect.never;
  });

const runServer = (command: "up" | "serve"): Effect.Effect<never, unknown> =>
  Effect.gen(function* () {
    const config = yield* configWithArguments(command === "up");
    if (command === "serve" && hasFlag("--register")) {
      const endpoint = argumentValue("--register");
      const token = argumentValue("--token");
      if (endpoint === undefined || token === undefined) {
        return yield* Effect.fail(
          new Error("serve --register requires a WebSocket URL and --token <registration-token>"),
        );
      }
      return yield* runContributor(config, endpoint, token);
    }
    if (command === "up" && !["127.0.0.1", "::1", "localhost"].includes(config.host)) {
      return yield* Effect.fail(new Error("Development mode may bind only to localhost"));
    }
    if (command === "serve" && !config.apiKey) {
      return yield* Effect.fail(new Error("serve requires MASKIROVKA_SEAT_KEY or --key"));
    }
    if (command === "up") yield* printDoctor(config);
    const service = yield* createGatewayService(config);
    yield* Console.log(
      `Maskirovka ${config.mode} gateway listening on http://${config.host}:${config.port}`,
    );
    return yield* serveMaskirovka(config, service);
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
      const loaded = yield* configWithArguments(true);
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
    const base = yield* configWithArguments();
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

const runDeploySeat = (): Effect.Effect<void, GatewayError> =>
  Effect.gen(function* () {
    const apply = hasFlag("--apply");
    const action = apply ? "deploy" : "build";
    const result = yield* new ProcessCliProbeRepository().run(
      "pnpm",
      ["--filter", "@stavka/maskirovka-seat", action],
      10 * 60 * 1_000,
    );
    if (result.output) yield* Console.log(result.output);
    if (!result.ok) {
      return yield* Effect.fail(
        new GatewayError(500, "SEAT_DEPLOY_FAILED", `maskirovka-seat ${action} failed`),
      );
    }
    if (!apply) {
      yield* Console.log("Dry-run complete. Re-run deploy-seat --apply to publish deliberately.");
    }
  });

const main: Effect.Effect<void, unknown> = Effect.gen(function* () {
  const command = process.argv[2] ?? "up";
  if (command === "up" || command === "serve") return yield* runServer(command);
  if (command === "doctor") {
    const config = yield* configWithArguments();
    if (!(yield* printDoctor(config, !hasFlag("--no-write")))) {
      process.exitCode = 1;
    }
    return;
  }
  if (command === "models") {
    const config = yield* configWithArguments();
    yield* Console.log(JSON.stringify({ aliases: config.aliases, seats: config.seats }, null, 2));
    return;
  }
  if (command === "smoke") return yield* runSmoke();
  if (command === "eval") return yield* runEval();
  if (command === "deploy-seat") return yield* runDeploySeat();
  return yield* Effect.fail(
    new Error(
      `Unknown command ${command}. Use up, serve, doctor, models, smoke, eval, or deploy-seat. Contributor seats use serve --register <wss-url> --token <token>.`,
    ),
  );
});

NodeRuntime.runMain(main);
