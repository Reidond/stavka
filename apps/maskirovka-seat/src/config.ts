import type { AccessConfig } from "@stavka/access-auth";

import type { MaskirovkaSeat } from "./seat-container";

export type SeatProvider = "claude" | "codex";

/** Direct Worker secrets are not represented by wrangler's generated bindings. */
interface SeatSecretBindings {
  readonly MASKIROVKA_SEAT_KEY?: string;
  readonly CLAUDE_CODE_OAUTH_TOKEN?: string;
  readonly CODEX_ACCESS_TOKEN?: string;
  readonly DEV_ACCESS_EMAIL?: string;
  readonly ACCESS_TEAM_DOMAIN?: string;
  readonly ACCESS_AUD?: string;
  readonly ASSETS?: Fetcher;
}

type RuntimeBindings = Omit<
  Cloudflare.Env,
  "ENVIRONMENT" | "SEAT_ID" | "SEAT_PROVIDER" | "MODEL_ALIASES" | "CONTAINER_SLEEP_AFTER"
>;

export type SeatEnv = RuntimeBindings &
  SeatSecretBindings & {
    readonly MASKIROVKA_SEAT: DurableObjectNamespace<MaskirovkaSeat>;
    readonly ENVIRONMENT: string;
    readonly SEAT_ID: string;
    readonly SEAT_PROVIDER: string;
    readonly MODEL_ALIASES: string;
    readonly CONTAINER_SLEEP_AFTER: string;
  };

export interface SeatConfig {
  readonly environment: string;
  readonly seatId: string;
  readonly provider: SeatProvider;
  readonly aliases: Readonly<Record<string, string>>;
  readonly sleepAfter: string;
}

const isStringRecord = (value: unknown): value is Record<string, string> => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  return Object.entries(value).every(
    ([alias, model]) =>
      alias.startsWith("stavka/") &&
      alias.length <= 128 &&
      typeof model === "string" &&
      model.length > 0,
  );
};

export const parseProvider = (value: string): SeatProvider => {
  if (value === "claude" || value === "codex") return value;
  throw new Error(`Unsupported seat provider: ${value}`);
};

export const parseAliases = (value: string): Readonly<Record<string, string>> => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error("MODEL_ALIASES must be a JSON object");
  }
  if (!isStringRecord(parsed) || Object.keys(parsed).length === 0) {
    throw new Error("MODEL_ALIASES must map at least one stavka/* alias to a model");
  }
  return Object.freeze({ ...parsed });
};

export const readSeatConfig = (env: SeatEnv): SeatConfig => ({
  environment: env.ENVIRONMENT,
  seatId: env.SEAT_ID,
  provider: parseProvider(env.SEAT_PROVIDER),
  aliases: parseAliases(env.MODEL_ALIASES),
  sleepAfter: env.CONTAINER_SLEEP_AFTER,
});

export const credentialForProvider = (env: SeatEnv, provider: SeatProvider): string | undefined =>
  provider === "claude" ? env.CLAUDE_CODE_OAUTH_TOKEN : env.CODEX_ACCESS_TOKEN;

export const hostedAccessConfig = (env: SeatEnv): AccessConfig => ({
  environment:
    env.ENVIRONMENT === "local" || env.ENVIRONMENT === "preview" ? env.ENVIRONMENT : "production",
  teamDomain: env.ACCESS_TEAM_DOMAIN ?? "",
  audience: env.ACCESS_AUD ?? "",
  automationPermissions: ["read"],
  ...(env.ENVIRONMENT === "local" && env.DEV_ACCESS_EMAIL
    ? { devEmail: env.DEV_ACCESS_EMAIL }
    : {}),
});
