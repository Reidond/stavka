import { Container, type StopParams } from "@cloudflare/containers";
import type {
  AccountAccessPrincipal,
  AccountScope,
  AccountSession,
  ActiveAccountSession,
  OrganizationUser,
  SignUpPayload,
} from "@stavka/access-auth";
import {
  refreshCodexCredential,
  type OwnedProviderAccountPublic,
  type ProviderId,
  type ProvisionProviderAccountPayload,
} from "@stavka/provider-auth";
import { Effect, Semaphore } from "effect";

import type { GatewayAuthCheckpoint } from "./auth-checkpoint";
import {
  gatewayProviders,
  type GatewayAlias,
  type GatewayEnv,
  type GatewayProvider,
  type GatewaySeat,
  type GatewayTier,
  gatewayTiers,
  readGatewayConfig,
} from "./config";
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
import {
  DurableProviderAccountRepository,
  type PersistedProviderAccount,
} from "./provider-account-repository";
import { DurableOrganizationRepository } from "./organization-repository";

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
  readonly providerAccounts: readonly OwnedProviderAccountPublic[];
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

export interface GatewayAuthMetadata {
  readonly provider: GatewayProvider;
  readonly configured: boolean;
  readonly persisted: boolean;
  readonly activeAccount?: string;
  readonly revision: number;
  readonly updated_at?: number;
}

const isRunning = (status: string): boolean => status === "running" || status === "healthy";

const errorResponse = (code: string, message: string, status = 503): Response =>
  Response.json({ error: { code, message } }, { status, headers: { "cache-control": "no-store" } });

export class MaskirovkaGateway extends Container<GatewayEnv> {
  override defaultPort = 4141;
  override requiredPorts = [4141];
  override sleepAfter = "15m";
  override enableInternet = true;
  override pingEndpoint = "/healthz";
  override envVars = { NODE_ENV: "production", PORT: "4141" };

  private readonly providerAccounts: DurableProviderAccountRepository;
  private readonly organizations: DurableOrganizationRepository;
  private readonly config: GatewayConfigRepositoryService;
  private readonly requests: DurableRequestMetadataRepository;
  private readonly window: DurableWindowTrackerRepository;
  private readonly startLock = Semaphore.makeUnsafe(1);

  constructor(ctx: DurableObjectState<{}>, env: GatewayEnv) {
    super(ctx, env);
    this.organizations = new DurableOrganizationRepository(ctx.storage);
    this.providerAccounts = new DurableProviderAccountRepository(
      ctx.storage.sql,
      env.STAVKA_PROVIDER_VAULT_KEY,
    );
    this.config = new DurableGatewayConfigRepository(ctx.storage.sql);
    this.requests = new DurableRequestMetadataRepository(ctx.storage.sql);
    this.window = new DurableWindowTrackerRepository(ctx.storage.sql);
    Effect.runSync(
      Effect.all([
        this.organizations.initialize,
        this.providerAccounts.initialize,
        this.config.initialize,
        this.requests.initialize,
        this.window.initialize,
      ]).pipe(Effect.orDie),
    );
    this.sleepAfter = readGatewayConfig(env).sleepAfter;
  }

  async getGatewayStatus(scope?: AccountScope): Promise<GatewayStatus> {
    return Effect.runPromise(this.statusEffect(scope));
  }

  async getAccountSession(principal: AccountAccessPrincipal): Promise<AccountSession> {
    return Effect.runPromise(this.organizations.session(principal));
  }

  async signUpAccount(
    principal: AccountAccessPrincipal,
    payload: SignUpPayload,
  ): Promise<ActiveAccountSession> {
    return Effect.runPromise(this.organizations.signUp(principal, payload));
  }

  async listOrganizationUsers(scope: AccountScope): Promise<readonly OrganizationUser[]> {
    return Effect.runPromise(this.organizations.listUsers(scope));
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

  async listProviderAccounts(scope: AccountScope): Promise<readonly OwnedProviderAccountPublic[]> {
    return Effect.runPromise(this.providerAccounts.list(scope));
  }

  async putProviderAccount(
    scope: AccountScope,
    provider: ProviderId,
    name: string,
    payload: ProvisionProviderAccountPayload,
  ): Promise<OwnedProviderAccountPublic> {
    return Effect.runPromise(
      Effect.gen({ self: this }, function* () {
        const persisted = yield* this.providerAccounts.put(scope, provider, name, payload);
        yield* this.restartForConfiguration();
        return persisted;
      }),
    );
  }

  async activateProviderAccount(
    scope: AccountScope,
    provider: ProviderId,
    name: string,
  ): Promise<OwnedProviderAccountPublic> {
    return Effect.runPromise(
      Effect.gen({ self: this }, function* () {
        const persisted = yield* this.providerAccounts.activate(scope, provider, name);
        yield* this.restartForConfiguration();
        return persisted;
      }),
    );
  }

  async deleteProviderAccount(
    scope: AccountScope,
    provider: ProviderId,
    name: string,
  ): Promise<void> {
    return Effect.runPromise(
      Effect.gen({ self: this }, function* () {
        yield* this.providerAccounts.delete(scope, provider, name);
        yield* this.restartForConfiguration();
      }),
    );
  }

  async testProviderAccount(
    scope: AccountScope,
    provider: ProviderId,
    name: string,
  ): Promise<OwnedProviderAccountPublic> {
    return Effect.runPromise(
      this.providerAccounts
        .read(scope, provider, name)
        .pipe(
          Effect.flatMap((account) =>
            account
              ? Effect.succeed(publicAccount(account))
              : Effect.fail(new Error(`Unknown provider account ${provider}/${name}`)),
          ),
        ),
    );
  }

  async fetchForAccount(scope: AccountScope, request: Request): Promise<Response> {
    return Effect.runPromise(this.forwardEffect(scope, request), { signal: request.signal });
  }

  override async fetch(_request: Request): Promise<Response> {
    return errorResponse(
      "USER_AUTHORIZATION_REQUIRED",
      "Provider execution requires an authorized Stavka user",
      403,
    );
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

  private activeProviderAccounts(
    scope: AccountScope,
  ): Effect.Effect<readonly PersistedProviderAccount[], unknown> {
    return Effect.gen({ self: this }, function* () {
      const accounts: PersistedProviderAccount[] = [];
      for (const provider of gatewayProviders) {
        let account = yield* this.providerAccounts.active(scope, provider);
        if (!account) continue;
        if (
          provider === "codex" &&
          account.credential.kind === "codex-chatgpt-oauth" &&
          account.credential.expiresAt <= Date.now() + 300_000
        ) {
          const refreshed = yield* refreshCodexCredential(account.credential).pipe(
            Effect.mapError((error) => new Error(error.message)),
          );
          yield* this.providerAccounts.put(scope, provider, account.name, {
            label: account.label,
            authKind: account.authKind,
            credential: refreshed,
            ...(account.remoteAccountId ? { remoteAccountId: account.remoteAccountId } : {}),
            ...(account.remoteWorkspaceId ? { remoteWorkspaceId: account.remoteWorkspaceId } : {}),
            activate: true,
          });
          account = yield* this.providerAccounts.active(scope, provider);
        }
        if (account) accounts.push(account);
      }
      return accounts;
    });
  }

  private statusEffect(scope?: AccountScope): Effect.Effect<GatewayStatus, unknown> {
    return Effect.gen({ self: this }, function* () {
      const [config, accounts, runtime, snapshot, count, state] = yield* Effect.all(
        [
          this.readConfig(),
          scope ? this.providerAccounts.list(scope) : Effect.succeed([]),
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
          const persisted = accounts.find((entry) => entry.provider === provider && entry.active);
          return [provider, persisted ? metadataFromAccount(persisted) : emptyMetadata(provider)];
        }),
      ) as Record<GatewayProvider, GatewayAuthMetadata>;
      const configured = gatewayProviders.some((provider) => authMetadata[provider].configured);
      const currentWindow = snapshot ?? initialGatewayWindowSnapshot();
      return {
        // Machine health has no account scope and must never decrypt or expose
        // user credentials. It reports gateway liveness; scoped admin status
        // additionally reports whether that user's providers are configured.
        ok: !config.killed && (scope === undefined || configured),
        service: "stavka-maskirovka-gateway" as const,
        mode: readGatewayConfig(this.env).mode,
        killed: config.killed,
        aliases: config.aliases,
        container: {
          status: state.status,
          last_change: state.lastChange || runtime.lastChange,
        },
        auth: authMetadata,
        providerAccounts: accounts,
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

  private forwardEffect(scope: AccountScope, request: Request): Effect.Effect<Response, never> {
    return Effect.gen({ self: this }, function* () {
      const config = yield* this.readConfig().pipe(Effect.catch(() => Effect.succeed(undefined)));
      if (config?.killed) return errorResponse("GATEWAY_KILLED", "Gateway traffic is disabled");
      const accounts = yield* this.activeProviderAccounts(scope).pipe(
        Effect.catch(() => Effect.succeed([])),
      );
      if (accounts.length === 0)
        return errorResponse(
          "GATEWAY_AUTH_MISSING",
          "No subscription credential is configured for this user",
        );
      const headers = new Headers(request.headers);
      // Routing metadata is decided by the inference service, never by the
      // caller: strip every inbound x-maskirovka-* header before forwarding.
      const inboundHeaderNames = [...headers.keys()];
      for (const name of inboundHeaderNames) {
        if (name.toLowerCase().startsWith("x-maskirovka-")) headers.delete(name);
      }
      const requestId = crypto.randomUUID();
      headers.set("x-maskirovka-request-id", requestId);
      headers.delete("authorization");
      headers.delete("cf-access-jwt-assertion");
      const started = Date.now();
      const internal = new Request(request, { headers });
      const response = yield* this.startLock
        .withPermit(
          Effect.gen({ self: this }, function* () {
            yield* this.ensureContainerReady(accounts);
            return yield* Effect.tryPromise({
              try: () => this.containerFetch(internal),
              catch: (cause) => cause,
            });
          }),
        )
        .pipe(
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
      // Persist only metadata returned by the inference service itself.
      const trusted = new Headers(response.headers);
      const seatHeader = trusted.get("x-maskirovka-seat") ?? undefined;
      const providerHeader = trusted.get("x-maskirovka-provider") ?? undefined;
      const tierHeader = trusted.get("x-maskirovka-tier") ?? undefined;
      const numberHeader = (name: string): number | undefined => {
        const raw = trusted.get(name);
        if (raw === null) return undefined;
        const parsed = Number(raw);
        return Number.isFinite(parsed) ? parsed : undefined;
      };
      const metadata: GatewayRequestMetadata = {
        requestId,
        timestamp: started,
        method: request.method,
        ...(providerHeader === "claude" || providerHeader === "codex"
          ? { provider: providerHeader }
          : {}),
        ...(seatHeader && gatewaySeat(seatHeader) ? { seat: seatHeader } : {}),
        ...(tierHeader !== undefined && gatewayTier(tierHeader) ? { tier: tierHeader } : {}),
        ...(trusted.get("x-maskirovka-model")
          ? { model: trusted.get("x-maskirovka-model") as string }
          : {}),
        status: response.status,
        latencyMs: Math.max(0, Date.now() - started),
        queueDepth: numberHeader("x-maskirovka-queue-depth") ?? 0,
        ...(trusted.get("x-maskirovka-cache")
          ? { cacheHit: trusted.get("x-maskirovka-cache") === "hit" }
          : {}),
        ...withDefined(numberHeader("x-maskirovka-input-tokens"), (inputTokens) => ({
          inputTokens,
        })),
        ...withDefined(numberHeader("x-maskirovka-output-tokens"), (outputTokens) => ({
          outputTokens,
        })),
        ...withDefined(numberHeader("x-maskirovka-cost-actual-usd"), (actualCostUsd) => ({
          actualCostUsd,
        })),
        ...withDefined(numberHeader("x-maskirovka-cost-list-usd"), (listCostUsd) => ({
          listCostUsd,
        })),
        ...withDefined(numberHeader("x-maskirovka-cost-plan-credit-usd"), (planCreditUsd) => ({
          planCreditUsd,
        })),
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
      // Enforce the actual streamed byte count; Content-Length is untrusted.
      const limitBytes = numberFromEnv(
        (this.env as GatewayEnv).MASKIROVKA_MAX_RESPONSE_BYTES,
        DEFAULT_MAX_RESPONSE_BYTES,
      );
      return new Response(limitStreamBytes(response.body, limitBytes), {
        status: response.status,
        statusText: response.statusText,
        headers: outputHeaders,
      });
    });
  }

  private ensureContainerReady(
    accounts: readonly PersistedProviderAccount[],
  ): Effect.Effect<void, unknown> {
    return Effect.gen({ self: this }, function* () {
      const fingerprint = yield* this.combinedFingerprint(accounts);
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
      yield* this.startContainer(accounts, fingerprint);
    });
  }

  private startContainer(
    accounts: readonly PersistedProviderAccount[],
    fingerprint: string,
  ): Effect.Effect<void, unknown> {
    return Effect.gen({ self: this }, function* () {
      const config = yield* this.readConfig();
      const env = this.env;
      const byTier = new Map(config.aliases.map((alias) => [alias.tier, alias]));
      const checkpoint: GatewayAuthCheckpoint = {
        version: 2,
        providers: Object.fromEntries(
          accounts.map((entry) => [
            entry.provider,
            {
              name: entry.name,
              auth_kind: entry.authKind,
              credential: entry.credential,
              revision: entry.revision,
            },
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

  private combinedFingerprintSync(accounts: readonly PersistedProviderAccount[]): string {
    return accounts
      .map(
        (entry) =>
          `${entry.organizationId}:${entry.ownerUserId}:${entry.provider}:${entry.name}:${entry.revision}`,
      )
      .sort()
      .join("|");
  }

  private combinedFingerprint(
    accounts: readonly PersistedProviderAccount[],
  ): Effect.Effect<string, Error> {
    return Effect.tryPromise({
      try: async () => {
        const digest = await crypto.subtle.digest(
          "SHA-256",
          new TextEncoder().encode(this.combinedFingerprintSync(accounts)),
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

const gatewayTier = (value: string): value is GatewayTier =>
  gatewayTiers.includes(value as GatewayTier);

const DEFAULT_MAX_RESPONSE_BYTES = 10 * 1024 * 1024;

const numberFromEnv = (raw: string | undefined, fallback: number): number => {
  if (raw === undefined) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

/**
 * Caps the actual streamed byte count of a proxied response. The stream
 * errors once the limit is exceeded, regardless of any Content-Length header.
 */
export const limitStreamBytes = (
  body: ReadableStream<Uint8Array> | null,
  maxBytes: number,
): ReadableStream<Uint8Array> | null => {
  if (body === null) return body;
  let total = 0;
  return body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        total += chunk.byteLength;
        if (total > maxBytes) {
          controller.error(new Error(`response exceeded ${maxBytes} byte limit`));
          return;
        }
        controller.enqueue(chunk);
      },
    }),
  );
};

const withDefined = <T, R>(value: T | undefined, project: (defined: T) => R): Partial<R> =>
  value === undefined ? {} : project(value);

const metadataFromAccount = (persisted: OwnedProviderAccountPublic): GatewayAuthMetadata => ({
  provider: persisted.provider,
  configured: true,
  persisted: true,
  activeAccount: persisted.name,
  revision: persisted.revision,
  updated_at: persisted.updatedAt,
});

const emptyMetadata = (provider: GatewayProvider): GatewayAuthMetadata => ({
  provider,
  configured: false,
  persisted: false,
  revision: 0,
});

const publicAccount = (account: PersistedProviderAccount): OwnedProviderAccountPublic => {
  const { credential: _credential, ...metadata } = account;
  return metadata;
};
