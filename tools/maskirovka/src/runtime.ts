import { join } from "node:path";
import { Effect, Layer } from "effect";

import type { MaskirovkaConfig } from "./config";
import { FileCacheRepository, type CacheRepositoryService } from "./repositories/cache-repository";
import {
  FileGatewayConfigRepository,
  type GatewayConfigRepositoryService,
} from "./repositories/config-repository";
import {
  ProcessCliProbeRepository,
  type CliProbeRepositoryService,
} from "./repositories/cli-probe-repository";
import {
  FileRequestLogRepository,
  type RequestLogRepositoryService,
} from "./repositories/request-log-repository";
import { FileRuntimeDirectoryRepository } from "./repositories/runtime-directory-repository";
import { FileWindowTrackerRepository } from "./repositories/window-tracker-repository";
import { ApiSeat } from "./seats/api-seat";
import { ClaudeSeat } from "./seats/claude-seat";
import { CodexSeat } from "./seats/codex-seat";
import { MockSeat } from "./seats/mock-seat";
import type { SeatAdapter } from "./seats/seat-adapter";
import { Gateway, GatewayService } from "./services/gateway-service";
import { SeatRegistry } from "./services/seat-registry";
import { WindowTracker } from "./services/window-tracker";

export interface RuntimeOverrides {
  readonly cache?: CacheRepositoryService;
  readonly logs?: RequestLogRepositoryService;
  readonly gatewayConfig?: GatewayConfigRepositoryService;
  readonly adapters?: readonly SeatAdapter[];
  readonly probes?: CliProbeRepositoryService;
}

const withCheckedSeatHealth = (
  config: MaskirovkaConfig,
  probes: CliProbeRepositoryService,
): Effect.Effect<MaskirovkaConfig, import("./domain/types").GatewayError> =>
  Effect.gen(function* () {
    const [claude, codex] = yield* Effect.all(
      [probes.run("claude", ["auth", "status"]), probes.run("codex", ["login", "status"])],
      { concurrency: "unbounded" },
    );
    return {
      ...config,
      seats: config.seats.map((seat) =>
        seat.id === "claude"
          ? { ...seat, status: claude.ok ? ("healthy" as const) : ("unavailable" as const) }
          : seat.id === "codex"
            ? { ...seat, status: codex.ok ? ("healthy" as const) : ("unavailable" as const) }
            : seat,
      ),
    };
  });

export const createGatewayService = (
  config: MaskirovkaConfig,
  overrides: RuntimeOverrides = {},
): Effect.Effect<GatewayService, import("./domain/types").GatewayError> =>
  Effect.gen(function* () {
    const checkedConfig = yield* withCheckedSeatHealth(
      config,
      overrides.probes ?? new ProcessCliProbeRepository(),
    );
    const codexWorkspace = join(config.stateDirectory, "codex-workspace");
    yield* new FileRuntimeDirectoryRepository().ensure([
      config.cacheDirectory,
      config.stateDirectory,
      codexWorkspace,
    ]);
    const repository =
      overrides.gatewayConfig ??
      new FileGatewayConfigRepository(join(config.stateDirectory, "gateway.json"));
    const registry = new SeatRegistry(
      checkedConfig.aliases,
      checkedConfig.seats,
      repository,
      checkedConfig.apiFallbackAliases,
    );
    const service = new GatewayService(
      checkedConfig,
      registry,
      overrides.cache ?? new FileCacheRepository(config.cacheDirectory),
      overrides.logs ??
        new FileRequestLogRepository(join(config.stateDirectory, "requests.ndjson")),
      overrides.adapters ?? [
        new MockSeat(),
        new ClaudeSeat(),
        new CodexSeat(codexWorkspace),
        new ApiSeat(config.openAiApiKey, config.anthropicApiKey),
      ],
      new WindowTracker(
        {
          claudeMonthlyCreditUsd: config.claudeMonthlyCreditUsd,
          codexWindowCalls: config.codexWindowCallLimit,
          codexWindowTokens: config.codexWindowTokenLimit,
          codexWindowMs: config.codexWindowHours * 60 * 60 * 1_000,
        },
        new FileWindowTrackerRepository(join(config.stateDirectory, "usage-tracker.json")),
      ),
    );
    yield* service.initialize();
    return service;
  });

export const GatewayRuntimeLive = (
  config: MaskirovkaConfig,
  overrides: RuntimeOverrides = {},
): Layer.Layer<Gateway, import("./domain/types").GatewayError> =>
  Layer.effect(Gateway, createGatewayService(config, overrides));
