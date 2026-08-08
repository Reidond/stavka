import { Container, type StopParams } from "@cloudflare/containers";
import { Effect, Semaphore } from "effect";

import { authTokenFingerprint, type GatewayAuthCheckpoint } from "./auth-checkpoint";
import {
  bootstrapCredential,
  gatewayProviders,
  type GatewayAlias,
  type GatewayEnv,
  type GatewayProvider,
  type GatewaySeat,
  type GatewayTier,
  readGatewayConfig,
} from "./config";
import {
  DurableAuthStateRepository,
  type GatewayAuthMetadata,
  type PersistedGatewayAuth,
} from "./auth-state-repository";
import {
  DurableGatewayConfigRepository,
  type GatewayConfigRepositoryService,
  type PersistedGatewayConfig,
} from "./gateway-config-repository";
import {
  DurableRequestMetadataRepository,
  type GatewayRequestMetadata,
} from "./request-metadata-repository";
import {
  DurableWindowTrackerRepository,
  initialGatewayWindowSnapshot,
} from "./window-tracker-repository";
import { encodeBase64Url } from "./base64";

export interface GatewayModelsResponse {
  readonly object: "list";
  readonly data: readonly {
    readonly id: GatewayTier;
    readonly object: "model";
    readonly created: 0;
    readonly owned_by: "stavka";
    readonly resolution: { readonly seat: GatewaySeat; readonly model: string };
  }[];
}

export interface GatewayStatus {
  readonly ok: boolean;
  readonly service: "stavka-maskirovka-gateway";
  readonly mode: "live" | "record" | "replay";
  readonly killed: boolean;
  readonly aliases: readonly GatewayAlias[];
  readonly container: { readonly status: string; readonly last_change: number };
  readonly auth: Readonly<Record<GatewayProvider, GatewayAuthMetadata>>;
  readonly config: { readonly revision: number; readonly updated_at: number };
  readonly window: {
    readonly durable: true;
    readonly tracked_since: string;
    readonly requests: number;
    readonly reservations: number;
  };
  readonly requests: {
    readonly retained: number;
    readonly limit: 500;
    readonly metadata_only: true;
  };
}

export interface GatewayAdminAuthResult extends GatewayAuthMetadata {
  readonly persisted: boolean;
}

const isRunning = (status: string): boolean => status === "running" || status === "healthy";

const errorResponse = (code: string, message: string, status = 503): Response =>
  Response.json({ error: { code, message } }, { status, headers: { "cache-control": "no-store" } });

const providerTokenFor = (auth: readonly PersistedGatewayAuth[], provider: GatewayProvider) =>
  auth.find((entry) => entry.provider === provider);

export class MaskirovkaGateway extends Container<GatewayEnv> {
  override defaultPort = 4141;
  override requiredPorts = [4141];
  override sleepAfter = "15m";
  override enableInternet = true;
  override pingEndpoint = "/healthz";
  override envVars = { NODE_ENV: "production", PORT: "4141" };

  private readonly auth: DurableAuthStateRepository;
  private readonly config: GatewayConfigRepositoryService;
  private readonly requests: DurableRequestMetadataRepository;
  private readonly window: DurableWindowTrackerRepository;
  private readonly startLock = Semaphore.makeUnsafe(1);

  constructor(ctx: DurableObjectState<{}>, env: GatewayEnv) {
    super(ctx, env);
    this.auth = new DurableAuthStateRepository(ctx.storage.sql);
    this.config = new DurableGatewayConfigRepository(ctx.storage.sql);
    this.requests = new DurableRequestMetadataRepository(ctx.storage.sql);
    this.window = new DurableWindowTrackerRepository(ctx.storage.sql);
    Effect.runSync(
      Effect.all([
        this.auth.initialize,
        this.config.initialize,
        this.requests.initialize,
        this.window.initialize,
      ]).pipe(Effect.orDie),
    );
    this.sleepAfter = readGatewayConfig(env).sleepAfter;
  }

  async getGatewayStatus(): Promise<GatewayStatus> {
    return Effect.runPromise(this.statusEffect());
  }

  async getModels(): Promise<GatewayModelsResponse> {
    return Effect.runPromise(
      Effect.gen({ self: this }, function* () {
        const config = yield* this.readConfig();
        return {
          object: "list" as const,
          data: config.aliases.map((alias) => ({
            id: alias.tier,
            object: "model" as const,
            created: 0 as const,
            owned_by: "stavka" as const,
            resolution: { seat: alias.seat, model: alias.model },
          })),
        } satisfies GatewayModelsResponse;
      }),
    );
  }

  async listRecentRequests(limit: number): Promise<readonly GatewayRequestMetadata[]> {
    return Effect.runPromise(this.requests.latest(limit));
  }

  async remapAlias(tier: GatewayTier, seat: GatewaySeat, model: string): Promise<GatewayStatus> {
    return Effect.runPromise(
      Effect.gen({ self: this }, function* () {
        const current = yield* this.readConfig();
        const aliases = [
          ...current.aliases.filter((alias) => alias.tier !== tier),
          { tier, seat, model: model.trim() },
        ].sort((left, right) => left.tier.localeCompare(right.tier));
        yield* this.config.save({
          ...current,
          aliases,
          revision: current.revision + 1,
          updatedAt: Date.now(),
        });
        yield* this.restartForConfiguration();
        return yield* this.statusEffect();
      }),
    );
  }

  async setKillSwitch(enabled: boolean): Promise<GatewayStatus> {
    return Effect.runPromise(
      Effect.gen({ self: this }, function* () {
        const current = yield* this.readConfig();
        yield* this.config.save({
          ...current,
          killed: enabled,
          revision: current.revision + 1,
          updatedAt: Date.now(),
        });
        return yield* this.statusEffect();
      }),
    );
  }

  async putAuth(provider: GatewayProvider, token: string): Promise<GatewayAdminAuthResult> {
    return Effect.runPromise(
      Effect.gen({ self: this }, function* () {
        const normalized = token.trim();
        if (normalized.length === 0 || normalized.length > 12_000) {
          return yield* Effect.fail(new Error("Auth token must be between 1 and 12000 characters"));
        }
        const fingerprint = yield* authTokenFingerprint(normalized);
        const persisted = yield* this.auth.replace(provider, normalized, fingerprint, Date.now());
        yield* this.restartForConfiguration();
        return metadataFromAuth(persisted);
      }),
    );
  }

  async deleteAuth(provider: GatewayProvider): Promise<GatewayAdminAuthResult> {
    return Effect.runPromise(
      Effect.gen({ self: this }, function* () {
        yield* this.auth.clear(provider);
        yield* this.restartForConfiguration();
        const persisted = yield* this.auth.read(provider);
        return persisted ? metadataFromAuth(persisted) : emptyMetadata(provider);
      }),
    );
  }

  override async fetch(request: Request): Promise<Response> {
    return Effect.runPromise(this.forwardEffect(request), { signal: request.signal });
  }

  override onStart(): void {
    const runtime = Effect.runSync(this.config.runtime.pipe(Effect.orDie));
    Effect.runSync(
      this.config.saveRuntime(runtime.fingerprint ?? "", "running", Date.now()).pipe(Effect.orDie),
    );
  }

  override onStop(params: StopParams): void {
    const runtime = Effect.runSync(this.config.runtime.pipe(Effect.orDie));
    Effect.runSync(
      this.config
        .saveRuntime(
          runtime.fingerprint ?? "",
          `stopped:${params.reason}:${params.exitCode}`,
          Date.now(),
        )
        .pipe(Effect.orDie),
    );
  }

  override onError(error: unknown): void {
    const message = error instanceof Error ? error.message : "Unknown container error";
    const runtime = Effect.runSync(this.config.runtime.pipe(Effect.orDie));
    Effect.runSync(
      this.config
        .saveRuntime(runtime.fingerprint ?? "", `error:${message}`, Date.now())
        .pipe(Effect.orDie),
    );
    console.error(
      JSON.stringify({ message: "Maskirovka gateway container error", error: message }),
    );
  }

  override async onActivityExpired(): Promise<void> {
    return Effect.runPromise(
      Effect.gen({ self: this }, function* () {
        const runtime = yield* this.config.runtime;
        yield* this.config.saveRuntime(runtime.fingerprint ?? "", "sleeping", Date.now());
        yield* Effect.tryPromise({ try: () => this.stop("SIGTERM"), catch: (cause) => cause });
      }).pipe(Effect.orDie),
    );
  }

  private readConfig(): Effect.Effect<PersistedGatewayConfig, unknown> {
    return Effect.gen({ self: this }, function* () {
      const persisted = yield* this.config.load;
      if (persisted) return persisted;
      const defaults = readGatewayConfig(this.env);
      const initial: PersistedGatewayConfig = {
        aliases: defaults.aliases,
        killed: false,
        revision: 1,
        updatedAt: Date.now(),
      };
      yield* this.config.save(initial);
      return initial;
    });
  }

  private syncBootstrapAuth(): Effect.Effect<readonly PersistedGatewayAuth[], unknown> {
    return Effect.gen({ self: this }, function* () {
      for (const provider of gatewayProviders) {
        const bootstrap = bootstrapCredential(this.env, provider);
        if (!bootstrap) continue;
        const fingerprint = yield* authTokenFingerprint(bootstrap);
        const existing = yield* this.auth.read(provider);
        if (!existing || existing.fingerprint !== fingerprint) {
          yield* this.auth.replace(provider, bootstrap, fingerprint, Date.now());
        }
      }
      return yield* this.auth.list;
    });
  }

  private statusEffect(): Effect.Effect<GatewayStatus, unknown> {
    return Effect.gen({ self: this }, function* () {
      const [config, auth, runtime, snapshot, count, state] = yield* Effect.all(
        [
          this.readConfig(),
          this.syncBootstrapAuth(),
          this.config.runtime,
          this.window.read,
          this.requests.count,
          Effect.tryPromise({
            try: () => this.getState(),
            catch: () => ({ status: "stopped", lastChange: 0 }),
          }),
        ] as const,
        { concurrency: "unbounded" },
      );
      const authMetadata = Object.fromEntries(
        gatewayProviders.map((provider) => {
          const persisted = providerTokenFor(auth, provider);
          return [provider, persisted ? metadataFromAuth(persisted) : emptyMetadata(provider)];
        }),
      ) as Record<GatewayProvider, GatewayAuthMetadata>;
      const configured = gatewayProviders.some((provider) => authMetadata[provider].configured);
      const currentWindow = snapshot ?? initialGatewayWindowSnapshot();
      return {
        ok: configured && !config.killed,
        service: "stavka-maskirovka-gateway" as const,
        mode: readGatewayConfig(this.env).mode,
        killed: config.killed,
        aliases: config.aliases,
        container: {
          status: state.status,
          last_change: state.lastChange || runtime.lastChange,
        },
        auth: authMetadata,
        config: { revision: config.revision, updated_at: config.updatedAt },
        window: {
          durable: true as const,
          tracked_since: currentWindow.trackedSince,
          requests: currentWindow.requests,
          reservations: currentWindow.reservations,
        },
        requests: { retained: count, limit: 500 as const, metadata_only: true as const },
      } satisfies GatewayStatus;
    });
  }

  private forwardEffect(request: Request): Effect.Effect<Response, never> {
    return Effect.gen({ self: this }, function* () {
      const config = yield* this.readConfig().pipe(Effect.catch(() => Effect.succeed(undefined)));
      if (config?.killed) return errorResponse("GATEWAY_KILLED", "Gateway traffic is disabled");
      const auth = yield* this.syncBootstrapAuth().pipe(Effect.catch(() => Effect.succeed([])));
      if (auth.length === 0)
        return errorResponse("GATEWAY_AUTH_MISSING", "No subscription credential is configured");
      yield* this.ensureContainerReady(auth);
      const headers = new Headers(request.headers);
      const requestId = headers.get("x-maskirovka-request-id") ?? crypto.randomUUID();
      headers.set("x-maskirovka-request-id", requestId);
      headers.delete("authorization");
      headers.delete("cf-access-jwt-assertion");
      const started = Date.now();
      const internal = new Request(request, { headers });
      const response = yield* Effect.tryPromise({
        try: () => this.containerFetch(internal),
        catch: (cause) => cause,
      }).pipe(
        Effect.catch((cause) =>
          Effect.succeed(
            errorResponse(
              "GATEWAY_DISCONNECTED",
              cause instanceof Error ? cause.message : "Gateway container disconnected",
              503,
            ),
          ),
        ),
      );
      const providerHeader = headers.get("x-maskirovka-provider");
      const seatHeader = headers.get("x-maskirovka-seat");
      const modelHeader = headers.get("x-maskirovka-model");
      const metadata: GatewayRequestMetadata = {
        requestId,
        timestamp: started,
        method: request.method,
        ...(providerHeader === "claude" || providerHeader === "codex"
          ? { provider: providerHeader }
          : {}),
        ...(seatHeader && gatewaySeat(seatHeader) ? { seat: seatHeader } : {}),
        ...(modelHeader ? { model: modelHeader } : {}),
        status: response.status,
        latencyMs: Math.max(0, Date.now() - started),
        queueDepth: Number(headers.get("x-maskirovka-queue-depth") ?? 0) || 0,
      };
      yield* this.requests.append(metadata).pipe(Effect.catch(() => Effect.void));
      const currentWindow =
        (yield* this.window.read.pipe(Effect.catch(() => Effect.succeed(undefined)))) ??
        initialGatewayWindowSnapshot();
      yield* this.window
        .save({ ...currentWindow, requests: currentWindow.requests + 1, updatedAt: Date.now() })
        .pipe(Effect.catch(() => Effect.void));
      const outputHeaders = new Headers(response.headers);
      outputHeaders.delete("x-maskirovka-auth-checkpoint");
      return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers: outputHeaders,
      });
    }).pipe(
      Effect.catch((cause) =>
        Effect.succeed(
          errorResponse(
            "GATEWAY_UNAVAILABLE",
            cause instanceof Error ? cause.message : "Gateway request failed",
            503,
          ),
        ),
      ),
    );
  }

  private ensureContainerReady(
    auth: readonly PersistedGatewayAuth[],
  ): Effect.Effect<void, unknown> {
    return this.startLock.withPermit(
      Effect.gen({ self: this }, function* () {
        const fingerprint = yield* this.combinedFingerprint(auth);
        const [state, runtime] = yield* Effect.all(
          [
            Effect.tryPromise({ try: () => this.getState(), catch: (cause) => cause }),
            this.config.runtime,
          ] as const,
          { concurrency: "unbounded" },
        );
        if (isRunning(state.status) && runtime.fingerprint === fingerprint) return;
        if (isRunning(state.status))
          yield* Effect.tryPromise({ try: () => this.stop("SIGTERM"), catch: (cause) => cause });
        yield* this.startContainer(auth, fingerprint);
      }),
    );
  }

  private startContainer(
    auth: readonly PersistedGatewayAuth[],
    fingerprint: string,
  ): Effect.Effect<void, unknown> {
    return Effect.gen({ self: this }, function* () {
      const config = yield* this.readConfig();
      const env = this.env;
      const byTier = new Map(config.aliases.map((alias) => [alias.tier, alias]));
      const checkpoint: GatewayAuthCheckpoint = {
        version: 1,
        providers: Object.fromEntries(
          auth.map((entry) => [
            entry.provider,
            { token: entry.token, fingerprint: entry.fingerprint },
          ]),
        ) as GatewayAuthCheckpoint["providers"],
        observed_at: Date.now(),
      };
      const startEnv: Record<string, string> = {
        NODE_ENV: "production",
        PORT: String(this.defaultPort),
        MASKIROVKA_HOST: "0.0.0.0",
        MASKIROVKA_PORT: String(this.defaultPort),
        MASKIROVKA_MODE: readGatewayConfig(env).mode,
        MASKIROVKA_STATE_DIR: "/tmp/maskirovka-state",
        MASKIROVKA_CACHE_DIR: "/tmp/maskirovka-cache",
        MASKIROVKA_AUTH_STATE_B64: encodeBase64Url(JSON.stringify(checkpoint)),
        MASKIROVKA_CLAUDE_MONTHLY_CREDIT_USD: String(readGatewayConfig(env).claudeMonthlyCreditUsd),
        MASKIROVKA_CODEX_WINDOW_CALL_LIMIT: String(readGatewayConfig(env).codexWindowCallLimit),
        MASKIROVKA_CODEX_WINDOW_TOKEN_LIMIT: String(readGatewayConfig(env).codexWindowTokenLimit),
        MASKIROVKA_CODEX_WINDOW_HOURS: String(readGatewayConfig(env).codexWindowHours),
      };
      for (const [tier, variable] of [
        ["commander", "COMMANDER"],
        ["sergeant", "SERGEANT"],
        ["heavy", "HEAVY"],
      ] as const) {
        const alias = byTier.get(`stavka/${tier}` as GatewayTier);
        if (!alias) continue;
        startEnv[`MASKIROVKA_${variable}_SEAT`] = alias.seat;
        startEnv[`MASKIROVKA_${variable}_MODEL`] = alias.model;
      }
      yield* Effect.tryPromise({
        try: () =>
          this.startAndWaitForPorts({
            ports: this.requiredPorts,
            startOptions: {
              enableInternet: true,
              labels: {
                gateway_id: readGatewayConfig(env).gatewayId,
                config_revision: String(config.revision),
              },
              envVars: startEnv,
            },
            cancellationOptions: {
              instanceGetTimeoutMS: 8_000,
              portReadyTimeoutMS: 30_000,
              waitInterval: 300,
            },
          }),
        catch: (cause) => cause,
      });
      yield* this.config.saveRuntime(fingerprint, "running", Date.now());
    });
  }

  private restartForConfiguration(): Effect.Effect<void, unknown> {
    return Effect.tryPromise({ try: () => this.getState(), catch: (cause) => cause }).pipe(
      Effect.flatMap((state) =>
        isRunning(state.status)
          ? Effect.tryPromise({ try: () => this.stop("SIGTERM"), catch: (cause) => cause })
          : Effect.void,
      ),
    );
  }

  private combinedFingerprintSync(auth: readonly PersistedGatewayAuth[]): string {
    return auth
      .map((entry) => `${entry.provider}:${entry.fingerprint}`)
      .sort()
      .join("|");
  }

  private combinedFingerprint(auth: readonly PersistedGatewayAuth[]): Effect.Effect<string, Error> {
    return Effect.tryPromise({
      try: async () => {
        const digest = await crypto.subtle.digest(
          "SHA-256",
          new TextEncoder().encode(this.combinedFingerprintSync(auth)),
        );
        return Array.from(new Uint8Array(digest), (byte) =>
          byte.toString(16).padStart(2, "0"),
        ).join("");
      },
      catch: (cause) =>
        cause instanceof Error ? cause : new Error("Unable to fingerprint gateway auth"),
    });
  }
}

const gatewaySeat = (value: string): value is GatewaySeat =>
  ["mock", "claude", "codex", "api"].includes(value as GatewaySeat);

const metadataFromAuth = (persisted: PersistedGatewayAuth): GatewayAdminAuthResult => ({
  provider: persisted.provider,
  configured: true,
  persisted: true,
  revision: persisted.revision,
  updated_at: persisted.updatedAt,
});

const emptyMetadata = (provider: GatewayProvider): GatewayAdminAuthResult => ({
  provider,
  configured: false,
  persisted: false,
  revision: 0,
});
