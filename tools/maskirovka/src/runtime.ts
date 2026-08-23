import { join } from "node:path";
import { ClaudeAgentProvider, ClaudeApiProvider } from "@stavka/model-provider-claude";
import { CodexProvider } from "@stavka/model-provider-codex";
import { Effect, Layer } from "effect";

import type { MaskirovkaConfig } from "./config";
import { GatewayError } from "./domain/types";
import { FileCacheRepository, type CacheRepositoryService } from "./repositories/cache-repository";
import {
  FileGatewayConfigRepository,
  type GatewayConfigRepositoryService,
} from "./repositories/config-repository";
import {
  FileRequestLogRepository,
  type RequestLogRepositoryService,
} from "./repositories/request-log-repository";
import { FileRuntimeDirectoryRepository } from "./repositories/runtime-directory-repository";
import {
  FileWindowTrackerRepository,
  type WindowTrackerRepositoryService,
} from "./repositories/window-tracker-repository";
import { ApiSeat } from "./seats/api-seat";
import { ClaudeSeat } from "./seats/claude-seat";
import { CodexSeat } from "./seats/codex-seat";
import { MockSeat } from "./seats/mock-seat";
import type { SeatAdapter } from "./seats/seat-adapter";
import { loadProviderCredential } from "./provider-account";
import { Gateway, GatewayService } from "./services/gateway-service";
import { SeatRegistry } from "./services/seat-registry";
import { WindowTracker } from "./services/window-tracker";

export interface RuntimeOverrides {
  readonly cache?: CacheRepositoryService;
  readonly logs?: RequestLogRepositoryService;
  readonly gatewayConfig?: GatewayConfigRepositoryService;
  readonly windowTracker?: WindowTrackerRepositoryService;
  readonly adapters?: readonly SeatAdapter[];
}

const withProviderHealth = (
  config: MaskirovkaConfig,
  claudeAvailable: boolean,
  codexAvailable: boolean,
): Effect.Effect<MaskirovkaConfig> =>
  Effect.succeed({
    ...config,
    seats: config.seats.map((seat) =>
      seat.id === "claude"
        ? { ...seat, status: claudeAvailable ? ("healthy" as const) : ("unavailable" as const) }
        : seat.id === "codex"
          ? { ...seat, status: codexAvailable ? ("healthy" as const) : ("unavailable" as const) }
          : seat,
    ),
  });

export const createGatewayService = (
  config: MaskirovkaConfig,
  overrides: RuntimeOverrides = {},
): Effect.Effect<GatewayService, import("./domain/types").GatewayError> =>
  Effect.gen(function* () {
    const [claudeCredential, codexCredential] = yield* Effect.all(
      [loadProviderCredential("claude"), loadProviderCredential("codex")],
      { concurrency: "unbounded" },
    ).pipe(
      Effect.mapError((error) => new GatewayError(500, "PROVIDER_ACCOUNT_INVALID", error.message)),
    );
    const claudeAvailable =
      claudeCredential?.kind === "claude-subscription" || claudeCredential?.kind === "api-key";
    const codexAvailable = codexCredential?.kind === "codex-chatgpt-oauth";
    const checkedConfig = yield* withProviderHealth(config, claudeAvailable, codexAvailable);
    yield* new FileRuntimeDirectoryRepository().ensure([
      config.cacheDirectory,
      config.stateDirectory,
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
        ...(claudeCredential?.kind === "claude-subscription"
          ? [new ClaudeSeat(new ClaudeAgentProvider({ credential: claudeCredential }))]
          : claudeCredential?.kind === "api-key"
            ? [new ClaudeSeat(new ClaudeApiProvider({ credential: claudeCredential }))]
            : []),
        ...(codexCredential?.kind === "codex-chatgpt-oauth"
          ? [new CodexSeat(new CodexProvider({ credential: codexCredential }))]
          : []),
        new ApiSeat(config.openAiApiKey, config.anthropicApiKey),
      ],
      new WindowTracker(
        {
          claudeMonthlyCreditUsd: config.claudeMonthlyCreditUsd,
          codexWindowCalls: config.codexWindowCallLimit,
          codexWindowTokens: config.codexWindowTokenLimit,
          codexWindowMs: config.codexWindowHours * 60 * 60 * 1_000,
        },
        overrides.windowTracker ??
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
