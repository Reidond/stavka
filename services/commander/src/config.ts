import type { AccessConfig, AccessPermission } from "@stavka/access-auth";
import type { DoctrineId, LlmTierAlias } from "@stavka/protocol";
import { Context, Data, Effect, Schema } from "effect";

export type AiProvider = "mock" | "openai" | "anthropic";

export interface Env {
  readonly ORCHESTRATOR: DurableObjectNamespace<import("./durable/orchestrator").OrchestratorAgent>;
  readonly TERRAIN_CACHE: KVNamespace;
  readonly SESSION_EXPORTS?: R2Bucket;
  readonly API_KEY: string;
  readonly ENVIRONMENT?: string;
  readonly DEV_ACCESS_EMAIL?: string;
  readonly ACCESS_TEAM_DOMAIN?: string;
  readonly ACCESS_AUD?: string;
  readonly ACCESS_AUTOMATION_PERMISSIONS?: string;
  readonly COMMANDER_MODEL?: string;
  readonly SERGEANT_MODEL?: string;
  readonly HEAVY_MODEL?: string;
  readonly DECISION_INTERVAL_SECONDS?: string;
  readonly DOCTRINE?: string;
  readonly MAX_ACTIVE_UNITS?: string;
  readonly DIFFICULTY?: string;
  readonly PLAYER_SCALING?: string;
  readonly TICK_INTERVAL_IDLE_MS?: string;
  readonly TICK_INTERVAL_ACTIVE_MS?: string;
  readonly TICK_INTERVAL_BURST_MS?: string;
  readonly STAVKA_AI_PROVIDER?: string;
  readonly STAVKA_AI_BASE_URL?: string;
  readonly STAVKA_AI_KEY?: string;
  /**
   * Private service binding to the inference Worker. When present it carries
   * all model traffic and no public inference origin is needed.
   */
  readonly INFERENCE_SERVICE?: Fetcher;
  readonly STAVKA_SEAT_EXHAUSTION_POLICY?: string;
  readonly STAVKA_SEAT_STRETCH_MULTIPLIER?: string;
  readonly STAVKA_SEAT_HEARTBEAT_TTL_SECONDS?: string;
  readonly STAVKA_SEAT_JOB_TIMEOUT_SECONDS?: string;
  readonly SEAT_REGISTRATION_TOKEN?: string;
  /** JSON object mapping seat ids to independently revocable bearer keys. */
  readonly STAVKA_SEAT_KEYS?: string;
}

export class CommanderEnvironment extends Context.Service<CommanderEnvironment, Env>()(
  "@stavka/commander/Environment",
) {}

export class CommanderConfigError extends Data.TaggedError("CommanderConfigError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

const numberFrom = (value: string | undefined, fallback: number): number => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

export interface CommanderConfig {
  readonly commanderModel: LlmTierAlias;
  readonly sergeantModel: LlmTierAlias;
  readonly heavyModel: LlmTierAlias;
  readonly decisionIntervalSeconds: number;
  readonly doctrine: DoctrineId;
  readonly maxActiveUnits: number;
  readonly difficulty: number;
  readonly playerScaling: boolean;
  readonly tickIdleMs: number;
  readonly tickActiveMs: number;
  readonly tickBurstMs: number;
  readonly aiProvider: AiProvider;
  readonly aiBaseUrl: string;
  readonly aiKey?: string;
  /** Service binding fetch for inference; when set, traffic never leaves the private network. */
  readonly inferenceService?: Fetcher;
  readonly seatExhaustionPolicy: "fallback" | "stretch";
  readonly seatStretchMultiplier: number;
  readonly seatHeartbeatTtlSeconds: number;
  readonly seatJobTimeoutSeconds: number;
  readonly seatKeys: Readonly<Record<string, string>>;
}

const SeatKeys = Schema.Record(
  Schema.String,
  Schema.String.pipe(Schema.check(Schema.isTrimmed(), Schema.isNonEmpty())),
);

const seatKeysFrom = (value: string | undefined): Readonly<Record<string, string>> =>
  value === undefined ? {} : Schema.decodeUnknownSync(SeatKeys)(JSON.parse(value));

const tierAliasFrom = (value: string | undefined, fallback: LlmTierAlias): LlmTierAlias =>
  value === "stavka/commander" || value === "stavka/sergeant" || value === "stavka/heavy"
    ? value
    : fallback;

const doctrineFrom = (value: string | undefined): DoctrineId =>
  value === "aggressive" || value === "defensive" ? value : "balanced";

const maskirovkaBaseUrl = (value: string | undefined): string => {
  const normalized = (value ?? "http://127.0.0.1:4141").replace(/\/$/, "");
  let url: URL;
  try {
    url = new URL(normalized);
  } catch {
    throw new Error("STAVKA_AI_BASE_URL must be a valid Maskirovka HTTP(S) URL");
  }
  if (
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    url.hostname === "api.openai.com" ||
    url.hostname === "api.anthropic.com"
  ) {
    throw new Error("STAVKA_AI_BASE_URL must point to Maskirovka, not a provider API");
  }
  return normalized;
};

export const readConfig = (env: Env): CommanderConfig => {
  const rawProvider = env.STAVKA_AI_PROVIDER ?? "mock";
  const aiProvider: AiProvider =
    rawProvider === "openai" || rawProvider === "anthropic" ? rawProvider : "mock";
  return {
    commanderModel: tierAliasFrom(env.COMMANDER_MODEL, "stavka/commander"),
    sergeantModel: tierAliasFrom(env.SERGEANT_MODEL, "stavka/sergeant"),
    heavyModel: tierAliasFrom(env.HEAVY_MODEL, "stavka/heavy"),
    decisionIntervalSeconds: Math.max(1, numberFrom(env.DECISION_INTERVAL_SECONDS, 45)),
    doctrine: doctrineFrom(env.DOCTRINE),
    maxActiveUnits: Math.max(1, Math.floor(numberFrom(env.MAX_ACTIVE_UNITS, 50))),
    difficulty: Math.min(1, Math.max(0, numberFrom(env.DIFFICULTY, 0.5))),
    playerScaling: env.PLAYER_SCALING !== "false",
    tickIdleMs: Math.max(300, numberFrom(env.TICK_INTERVAL_IDLE_MS, 2_000)),
    tickActiveMs: Math.max(300, numberFrom(env.TICK_INTERVAL_ACTIVE_MS, 750)),
    tickBurstMs: Math.max(300, numberFrom(env.TICK_INTERVAL_BURST_MS, 300)),
    aiProvider,
    aiBaseUrl: maskirovkaBaseUrl(env.STAVKA_AI_BASE_URL),
    ...(env.INFERENCE_SERVICE ? { inferenceService: env.INFERENCE_SERVICE } : {}),
    ...(env.STAVKA_AI_KEY ? { aiKey: env.STAVKA_AI_KEY } : {}),
    seatExhaustionPolicy: env.STAVKA_SEAT_EXHAUSTION_POLICY === "stretch" ? "stretch" : "fallback",
    seatStretchMultiplier: Math.min(
      20,
      Math.max(1, numberFrom(env.STAVKA_SEAT_STRETCH_MULTIPLIER, 4)),
    ),
    seatHeartbeatTtlSeconds: Math.min(
      300,
      Math.max(10, Math.floor(numberFrom(env.STAVKA_SEAT_HEARTBEAT_TTL_SECONDS, 45))),
    ),
    seatJobTimeoutSeconds: Math.min(
      120,
      Math.max(5, Math.floor(numberFrom(env.STAVKA_SEAT_JOB_TIMEOUT_SECONDS, 30))),
    ),
    seatKeys: seatKeysFrom(env.STAVKA_SEAT_KEYS),
  };
};

/** Resolve Worker bindings at the Effect boundary and report invalid configuration as data. */
export const readConfigEffect = (env: Env): Effect.Effect<CommanderConfig, CommanderConfigError> =>
  Effect.try({
    try: () => readConfig(env),
    catch: (cause) =>
      new CommanderConfigError({
        message: cause instanceof Error ? cause.message : "Invalid Commander configuration",
        cause,
      }),
  });

export const commanderConfig: Effect.Effect<
  CommanderConfig,
  CommanderConfigError,
  CommanderEnvironment
> = CommanderEnvironment.pipe(Effect.flatMap(readConfigEffect));

const automationPermissions = (value: string | undefined): readonly AccessPermission[] => {
  const allowed = new Set<AccessPermission>(["read", "operate", "admin"]);
  const configured = (value ?? "")
    .split(",")
    .map((permission) => permission.trim())
    .filter((permission): permission is AccessPermission =>
      allowed.has(permission as AccessPermission),
    );
  return [...new Set<AccessPermission>(["read", ...configured])];
};

export const accessConfig = (env: Env): AccessConfig => ({
  environment:
    env.ENVIRONMENT === "local"
      ? "local"
      : env.ENVIRONMENT === "preview"
        ? "preview"
        : "production",
  teamDomain: env.ACCESS_TEAM_DOMAIN ?? "",
  audience: env.ACCESS_AUD ?? "",
  ...(env.DEV_ACCESS_EMAIL ? { devEmail: env.DEV_ACCESS_EMAIL } : {}),
  automationPermissions: automationPermissions(env.ACCESS_AUTOMATION_PERMISSIONS),
});
