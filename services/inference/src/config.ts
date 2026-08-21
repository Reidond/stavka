import type { AccessConfig } from "@stavka/access-auth";

import type { MaskirovkaGateway } from "./gateway-container";

export const gatewayProviders = ["claude", "codex"] as const;
export type GatewayProvider = (typeof gatewayProviders)[number];

export const gatewayTiers = ["stavka/commander", "stavka/sergeant", "stavka/heavy"] as const;
export type GatewayTier = (typeof gatewayTiers)[number];

export const gatewaySeats = ["mock", "claude", "codex", "api"] as const;
export type GatewaySeat = (typeof gatewaySeats)[number];

export interface GatewayAlias {
  readonly tier: GatewayTier;
  readonly seat: GatewaySeat;
  readonly model: string;
}

export interface GatewayEnvSecrets {
  readonly MASKIROVKA_GATEWAY_KEY?: string;
  readonly CLAUDE_CODE_OAUTH_TOKEN?: string;
  readonly CODEX_ACCESS_TOKEN?: string;
  readonly ACCESS_TEAM_DOMAIN?: string;
  readonly ACCESS_AUD?: string;
  readonly DEV_ACCESS_EMAIL?: string;
}

type RuntimeBindings = Omit<
  Cloudflare.Env,
  | "ENVIRONMENT"
  | "GATEWAY_ID"
  | "MODEL_ALIASES"
  | "CONTAINER_SLEEP_AFTER"
  | "MASKIROVKA_MODE"
  | "MASKIROVKA_CLAUDE_MONTHLY_CREDIT_USD"
  | "MASKIROVKA_CODEX_WINDOW_CALL_LIMIT"
  | "MASKIROVKA_CODEX_WINDOW_TOKEN_LIMIT"
  | "MASKIROVKA_CODEX_WINDOW_HOURS"
>;

export type GatewayEnv = RuntimeBindings &
  GatewayEnvSecrets & {
    readonly MASKIROVKA_GATEWAY: DurableObjectNamespace<MaskirovkaGateway>;
    readonly ASSETS: Fetcher;
    readonly REPLAY_CACHE: R2Bucket;
    readonly ENVIRONMENT: string;
    readonly GATEWAY_ID: string;
    readonly MODEL_ALIASES: string;
    readonly CONTAINER_SLEEP_AFTER: string;
    readonly MASKIROVKA_MODE: string;
    readonly MASKIROVKA_CLAUDE_MONTHLY_CREDIT_USD: string;
    readonly MASKIROVKA_CODEX_WINDOW_CALL_LIMIT: string;
    readonly MASKIROVKA_CODEX_WINDOW_TOKEN_LIMIT: string;
    readonly MASKIROVKA_CODEX_WINDOW_HOURS: string;
  };

export interface GatewayRuntimeConfig {
  readonly environment: string;
  readonly gatewayId: string;
  readonly aliases: readonly GatewayAlias[];
  readonly sleepAfter: string;
  readonly mode: "live" | "record" | "replay";
  readonly claudeMonthlyCreditUsd: number;
  readonly codexWindowCallLimit: number;
  readonly codexWindowTokenLimit: number;
  readonly codexWindowHours: number;
}

const DEFAULT_ALIASES: readonly GatewayAlias[] = [
  { tier: "stavka/commander", seat: "claude", model: "claude-fable-5" },
  { tier: "stavka/sergeant", seat: "codex", model: "gpt-5.6-luna" },
  { tier: "stavka/heavy", seat: "codex", model: "gpt-5.6-terra" },
];

const parseNumber = (value: string | undefined, fallback: number): number => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const parseAliases = (value: string): readonly GatewayAlias[] => {
  try {
    const decoded = JSON.parse(value) as unknown;
    if (Array.isArray(decoded)) {
      const aliases = decoded.filter((candidate): candidate is GatewayAlias => {
        if (typeof candidate !== "object" || candidate === null) return false;
        const item = candidate as Record<string, unknown>;
        return (
          typeof item.tier === "string" &&
          gatewayTiers.includes(item.tier as GatewayTier) &&
          typeof item.seat === "string" &&
          gatewaySeats.includes(item.seat as GatewaySeat) &&
          typeof item.model === "string" &&
          item.model.trim().length > 0
        );
      });
      if (aliases.length === gatewayTiers.length) return aliases;
    }
    if (typeof decoded === "object" && decoded !== null && !Array.isArray(decoded)) {
      const aliases = gatewayTiers.flatMap((tier) => {
        const item = (decoded as Record<string, unknown>)[tier];
        if (typeof item === "string" && item.trim()) {
          return [
            {
              tier,
              seat: item.startsWith("claude-") ? ("claude" as const) : ("codex" as const),
              model: item,
            },
          ];
        }
        if (typeof item !== "object" || item === null) return [];
        const entry = item as Record<string, unknown>;
        if (
          typeof entry.seat !== "string" ||
          !gatewaySeats.includes(entry.seat as GatewaySeat) ||
          typeof entry.model !== "string" ||
          !entry.model.trim()
        )
          return [];
        return [{ tier, seat: entry.seat as GatewaySeat, model: entry.model }];
      });
      if (aliases.length === gatewayTiers.length) return aliases;
    }
  } catch {
    // Invalid local vars fall back to safe, dual-provider defaults.
  }
  return DEFAULT_ALIASES;
};

export const readGatewayConfig = (env: GatewayEnv): GatewayRuntimeConfig => ({
  environment: env.ENVIRONMENT,
  gatewayId: env.GATEWAY_ID || "default-gateway",
  aliases: parseAliases(env.MODEL_ALIASES),
  sleepAfter: env.CONTAINER_SLEEP_AFTER || "15m",
  mode:
    env.MASKIROVKA_MODE === "record" || env.MASKIROVKA_MODE === "replay"
      ? env.MASKIROVKA_MODE
      : "live",
  claudeMonthlyCreditUsd: Math.max(0, parseNumber(env.MASKIROVKA_CLAUDE_MONTHLY_CREDIT_USD, 0)),
  codexWindowCallLimit: Math.max(
    0,
    Math.floor(parseNumber(env.MASKIROVKA_CODEX_WINDOW_CALL_LIMIT, 0)),
  ),
  codexWindowTokenLimit: Math.max(
    0,
    Math.floor(parseNumber(env.MASKIROVKA_CODEX_WINDOW_TOKEN_LIMIT, 0)),
  ),
  codexWindowHours: Math.max(1, parseNumber(env.MASKIROVKA_CODEX_WINDOW_HOURS, 5)),
});

export const hostedAccessConfig = (env: GatewayEnv): AccessConfig => ({
  environment:
    env.ENVIRONMENT === "local" || env.ENVIRONMENT === "preview" ? env.ENVIRONMENT : "production",
  teamDomain: env.ACCESS_TEAM_DOMAIN ?? "",
  audience: env.ACCESS_AUD ?? "",
  automationPermissions: ["read"],
  ...(env.ENVIRONMENT === "local" && env.DEV_ACCESS_EMAIL
    ? { devEmail: env.DEV_ACCESS_EMAIL }
    : {}),
});

export const bootstrapCredential = (
  env: GatewayEnv,
  provider: GatewayProvider,
): string | undefined =>
  provider === "claude" ? env.CLAUDE_CODE_OAUTH_TOKEN : env.CODEX_ACCESS_TOKEN;
