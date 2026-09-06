import { resolve } from "node:path";
import type { AccessConfig, AccessPermission } from "@stavka/access-auth";
import { Config, ConfigProvider, Context, Effect, Layer } from "effect";

import {
  seatKinds,
  tierAliases,
  type AliasResolution,
  type GatewayMode,
  type SeatDefinition,
  type SeatKind,
  type TierAlias,
} from "./domain/types";

export interface MaskirovkaConfig {
  readonly host: string;
  readonly port: number;
  readonly mode: GatewayMode;
  readonly cacheDirectory: string;
  readonly stateDirectory: string;
  readonly apiKey?: string;
  /** Hosted traffic is admitted by the private gateway's owner/grant gate. */
  readonly liveSergeantBudget: number | "hosted";
  readonly budgetPolicy: "fallback" | "stretch";
  readonly claudeMonthlyCreditUsd: number;
  readonly codexWindowCallLimit: number;
  readonly codexWindowTokenLimit: number;
  readonly codexWindowHours: number;
  readonly aliases: readonly AliasResolution[];
  readonly apiFallbackAliases: readonly AliasResolution[];
  readonly seats: readonly SeatDefinition[];
  readonly openAiApiKey?: string;
  readonly anthropicApiKey?: string;
  readonly dashboardDirectory: string;
  readonly access?: AccessConfig;
}

export class MaskirovkaConfiguration extends Context.Service<
  MaskirovkaConfiguration,
  MaskirovkaConfig
>()("@stavka/maskirovka/Configuration") {}

const envNumber = (value: string | undefined, fallback: number): number => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const envMode = (value: string | undefined): GatewayMode => {
  if (value === undefined || value === "") return "live";
  if (value === "live" || value === "record" || value === "replay") return value;
  throw new Error(
    `MASKIROVKA_MODE must be live, record, or replay; received ${JSON.stringify(value)}`,
  );
};

const envSeat = (value: string | undefined, fallback: SeatKind): SeatKind =>
  seatKinds.includes(value as SeatKind) ? (value as SeatKind) : fallback;

const aliasModel = (tier: TierAlias, seat: SeatKind, env: NodeJS.ProcessEnv): string => {
  if (tier === "stavka/commander") {
    return env.MASKIROVKA_COMMANDER_MODEL ?? (seat === "claude" ? "claude-fable-5" : "gpt-5.6-sol");
  }
  if (tier === "stavka/sergeant") {
    return (
      env.MASKIROVKA_SERGEANT_MODEL ?? (seat === "claude" ? "claude-sonnet-5" : "gpt-5.6-luna")
    );
  }
  return env.MASKIROVKA_HEAVY_MODEL ?? (seat === "claude" ? "claude-opus-5" : "gpt-5.6-terra");
};

const apiFallbackModel = (
  tier: TierAlias,
  env: NodeJS.ProcessEnv,
  preferAnthropic: boolean,
): string => {
  const configured =
    tier === "stavka/commander"
      ? env.MASKIROVKA_API_COMMANDER_MODEL
      : tier === "stavka/sergeant"
        ? env.MASKIROVKA_API_SERGEANT_MODEL
        : env.MASKIROVKA_API_HEAVY_MODEL;
  return configured ?? aliasModel(tier, preferAnthropic ? "claude" : "api", env);
};

export const readConfig = (
  env: NodeJS.ProcessEnv = process.env,
  cwd: string = process.cwd(),
): MaskirovkaConfig => {
  const seatByTier: Record<TierAlias, SeatKind> = {
    "stavka/commander": envSeat(env.MASKIROVKA_COMMANDER_SEAT, "mock"),
    "stavka/sergeant": envSeat(env.MASKIROVKA_SERGEANT_SEAT, "mock"),
    "stavka/heavy": envSeat(env.MASKIROVKA_HEAVY_SEAT, "mock"),
  };
  const preferAnthropicApi = !env.OPENAI_API_KEY && Boolean(env.ANTHROPIC_API_KEY);
  const aliases = tierAliases.map((tier) => ({
    tier,
    seat: seatByTier[tier],
    model:
      seatByTier[tier] === "api"
        ? apiFallbackModel(tier, env, preferAnthropicApi)
        : aliasModel(tier, seatByTier[tier], env),
  }));
  const modelsBySeat = (seat: SeatKind): string[] =>
    aliases.filter((alias) => alias.seat === seat).map((alias) => alias.model);
  const apiAvailable = Boolean(env.OPENAI_API_KEY || env.ANTHROPIC_API_KEY);
  const claudeMonthlyCreditUsd = Math.max(
    0,
    envNumber(env.MASKIROVKA_CLAUDE_MONTHLY_CREDIT_USD ?? env.MASKIROVKA_CLAUDE_BUDGET_USD, 0),
  );
  const apiFallbackAliases = tierAliases.map(
    (tier): AliasResolution => ({
      tier,
      seat: "api",
      model: apiFallbackModel(tier, env, preferAnthropicApi),
    }),
  );
  const environment =
    env.ENVIRONMENT === "local" || env.ENVIRONMENT === "preview" || env.ENVIRONMENT === "production"
      ? env.ENVIRONMENT
      : "production";
  const automationPermissions = (env.MASKIROVKA_ACCESS_AUTOMATION_PERMISSIONS ?? "read")
    .split(",")
    .map((permission) => permission.trim())
    .filter(
      (permission): permission is AccessPermission =>
        permission === "read" || permission === "operate" || permission === "admin",
    );
  return {
    host: env.MASKIROVKA_HOST ?? "127.0.0.1",
    port: Math.max(1, Math.min(65_535, Math.floor(envNumber(env.MASKIROVKA_PORT, 4_141)))),
    mode: envMode(env.MASKIROVKA_MODE),
    cacheDirectory: resolve(cwd, env.MASKIROVKA_CACHE_DIR ?? ".maskirovka/cache"),
    stateDirectory: resolve(cwd, env.MASKIROVKA_STATE_DIR ?? ".maskirovka/state"),
    ...(env.MASKIROVKA_SEAT_KEY ? { apiKey: env.MASKIROVKA_SEAT_KEY } : {}),
    liveSergeantBudget:
      env.MASKIROVKA_LIVE_SERGEANTS === "hosted"
        ? "hosted"
        : Math.max(0, Math.floor(envNumber(env.MASKIROVKA_LIVE_SERGEANTS, 0))),
    budgetPolicy: env.MASKIROVKA_BUDGET_POLICY === "stretch" ? "stretch" : "fallback",
    claudeMonthlyCreditUsd,
    codexWindowCallLimit: Math.max(
      0,
      Math.floor(envNumber(env.MASKIROVKA_CODEX_WINDOW_CALL_LIMIT, 0)),
    ),
    codexWindowTokenLimit: Math.max(
      0,
      Math.floor(envNumber(env.MASKIROVKA_CODEX_WINDOW_TOKEN_LIMIT, 0)),
    ),
    codexWindowHours: Math.max(1, envNumber(env.MASKIROVKA_CODEX_WINDOW_HOURS, 5)),
    aliases,
    apiFallbackAliases,
    seats: [
      {
        id: "mock",
        name: "Deterministic mock",
        mode: "local",
        models: modelsBySeat("mock"),
        monthlyBudgetUsd: 0,
        priority: 100,
        status: "healthy",
        exhausted: false,
      },
      {
        id: "claude",
        name: "Claude Agent SDK",
        mode: "local",
        models: modelsBySeat("claude"),
        monthlyBudgetUsd: claudeMonthlyCreditUsd,
        priority: 20,
        status: "unchecked",
        exhausted: false,
      },
      {
        id: "codex",
        name: "Stavka Codex",
        mode: "local",
        models: modelsBySeat("codex"),
        monthlyBudgetUsd: Math.max(0, envNumber(env.MASKIROVKA_CODEX_BUDGET_USD, 0)),
        priority: 30,
        status: "unchecked",
        exhausted: false,
      },
      {
        id: "api",
        name: "Metered API fallback",
        mode: "api",
        models: apiFallbackAliases.map((alias) => alias.model),
        monthlyBudgetUsd: Math.max(0, envNumber(env.MASKIROVKA_API_BUDGET_USD, 0)),
        priority: 0,
        status: apiAvailable ? "healthy" : "unavailable",
        exhausted: false,
      },
    ],
    ...(env.OPENAI_API_KEY ? { openAiApiKey: env.OPENAI_API_KEY } : {}),
    ...(env.ANTHROPIC_API_KEY ? { anthropicApiKey: env.ANTHROPIC_API_KEY } : {}),
    dashboardDirectory: resolve(cwd, "dist/dashboard"),
    access: {
      environment,
      teamDomain: env.ACCESS_TEAM_DOMAIN ?? "",
      audience: env.ACCESS_AUD ?? "",
      ...(env.DEV_ACCESS_EMAIL ? { devEmail: env.DEV_ACCESS_EMAIL } : {}),
      automationPermissions,
    },
  };
};

const configKeys = [
  "MASKIROVKA_HOST",
  "MASKIROVKA_PORT",
  "MASKIROVKA_MODE",
  "MASKIROVKA_CACHE_DIR",
  "MASKIROVKA_STATE_DIR",
  "MASKIROVKA_SEAT_KEY",
  "MASKIROVKA_LIVE_SERGEANTS",
  "MASKIROVKA_BUDGET_POLICY",
  "MASKIROVKA_COMMANDER_SEAT",
  "MASKIROVKA_SERGEANT_SEAT",
  "MASKIROVKA_HEAVY_SEAT",
  "MASKIROVKA_COMMANDER_MODEL",
  "MASKIROVKA_SERGEANT_MODEL",
  "MASKIROVKA_HEAVY_MODEL",
  "MASKIROVKA_CLAUDE_BUDGET_USD",
  "MASKIROVKA_CLAUDE_MONTHLY_CREDIT_USD",
  "MASKIROVKA_CODEX_BUDGET_USD",
  "MASKIROVKA_CODEX_WINDOW_CALL_LIMIT",
  "MASKIROVKA_CODEX_WINDOW_TOKEN_LIMIT",
  "MASKIROVKA_CODEX_WINDOW_HOURS",
  "MASKIROVKA_API_BUDGET_USD",
  "MASKIROVKA_API_COMMANDER_MODEL",
  "MASKIROVKA_API_SERGEANT_MODEL",
  "MASKIROVKA_API_HEAVY_MODEL",
  "MASKIROVKA_ACCESS_AUTOMATION_PERMISSIONS",
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "ENVIRONMENT",
  "ACCESS_TEAM_DOMAIN",
  "ACCESS_AUD",
  "DEV_ACCESS_EMAIL",
] as const;

const ConfigEnvironment = Config.all(
  Object.fromEntries(
    configKeys.map((key) => [key, Config.string(key).pipe(Config.withDefault(""))]),
  ) as Record<(typeof configKeys)[number], Config.Config<string>>,
);

export const MaskirovkaConfigDefinition = (
  cwd: string = process.cwd(),
): Config.Config<MaskirovkaConfig> =>
  ConfigEnvironment.pipe(
    Config.map((values) =>
      readConfig(
        Object.fromEntries(Object.entries(values).filter(([, value]) => value !== "")),
        cwd,
      ),
    ),
  );

export const loadConfig = (
  environment: NodeJS.ProcessEnv = process.env,
  cwd: string = process.cwd(),
): Effect.Effect<MaskirovkaConfig, Config.ConfigError> =>
  MaskirovkaConfigDefinition(cwd).parse(ConfigProvider.fromUnknown(environment));

export const MaskirovkaConfigurationLive = (
  cwd: string = process.cwd(),
): Layer.Layer<MaskirovkaConfiguration, Config.ConfigError> =>
  Layer.effect(MaskirovkaConfiguration, MaskirovkaConfigDefinition(cwd));
