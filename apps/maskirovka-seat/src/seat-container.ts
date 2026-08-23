import { Container, type StopParams } from "@cloudflare/containers";
import {
  ProviderCredentialSchema,
  type ProviderAccountPublic,
  type ProviderId,
  type ProvisionProviderAccountPayload,
} from "@stavka/provider-auth";
import { Effect, Schema, Semaphore } from "effect";

import {
  AUTH_CHECKPOINT_HEADER,
  AUTH_STATE_FINGERPRINT_HEADER,
  authTokenFingerprint,
  decodeAuthCheckpoint,
} from "./auth-checkpoint";
import { encodeBase64Url } from "./base64";
import { readSeatConfig, type SeatConfig, type SeatEnv, type SeatProvider } from "./config";
import type {
  HostedSeatDialect,
  HostedSeatOperationsStatus,
  HostedSeatRequestLog,
  HostedSeatStatus,
} from "./hosted-seat-runtime";
import { providerLifecycleIsHealthy, providerLifecycleTransition } from "./provider-health";
import { SeatInvocationGovernor, SeatQueueFullError } from "./seat-invocation-governor";
import {
  HOSTED_REQUEST_LOG_LIMIT,
  SeatStateRepository,
  type PersistedAuthState,
} from "./seat-state-repository";

const stateIsRunning = (status: string): boolean => status === "running" || status === "healthy";
const SEAT_CONCURRENCY = 1;
const SEAT_MAX_QUEUE = 8;

const errorJson = (code: string, message: string, retry = false): Response =>
  Response.json(
    { error: { code, message } },
    {
      status: 503,
      headers: {
        "cache-control": "no-store",
        ...(retry ? { "retry-after": "1" } : {}),
      },
    },
  );

const credentialFromEncoded = (encoded: string) =>
  Schema.decodeUnknownSync(ProviderCredentialSchema)(
    JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as unknown,
  );

const encodeCredential = (credential: typeof ProviderCredentialSchema.Type): string =>
  Buffer.from(JSON.stringify(credential), "utf8").toString("base64url");

export class MaskirovkaSeat extends Container<SeatEnv> {
  override defaultPort = 4141;
  override requiredPorts = [4141];
  override sleepAfter = "15m";
  override enableInternet = true;
  override pingEndpoint = "/healthz";
  override envVars = { NODE_ENV: "production", PORT: "4141" };

  private readonly repository: SeatStateRepository;
  private readonly startLock = Semaphore.makeUnsafe(1);
  private readonly invocationGovernor = new SeatInvocationGovernor(
    SEAT_CONCURRENCY,
    SEAT_MAX_QUEUE,
  );

  constructor(ctx: DurableObjectState<{}>, env: SeatEnv) {
    super(ctx, env);
    this.repository = new SeatStateRepository(ctx.storage.sql, env.STAVKA_PROVIDER_VAULT_KEY);
    Effect.runSync(this.repository.initialize.pipe(Effect.orDie));
    this.sleepAfter = readSeatConfig(env).sleepAfter;
  }

  async getSeatStatus(): Promise<HostedSeatStatus> {
    return Effect.runPromise(this.getSeatStatusEffect());
  }

  async getOperationsStatus(): Promise<HostedSeatOperationsStatus> {
    return Effect.runPromise(this.getOperationsStatusEffect());
  }

  async listRecentRequests(limit: number): Promise<readonly HostedSeatRequestLog[]> {
    return Effect.runPromise(this.repository.listRecentRequests(limit));
  }

  async remapAlias(alias: string, model: string): Promise<HostedSeatOperationsStatus> {
    return Effect.runPromise(
      Effect.gen({ self: this }, function* () {
        const config = readSeatConfig(this.env);
        yield* this.repository.remapAlias(alias, model, config.aliases, Date.now());
        return yield* this.getOperationsStatusEffect();
      }),
    );
  }

  async setKillSwitch(enabled: boolean): Promise<HostedSeatOperationsStatus> {
    return Effect.runPromise(
      Effect.gen({ self: this }, function* () {
        yield* this.repository.setKilled(enabled, Date.now());
        return yield* this.getOperationsStatusEffect();
      }),
    );
  }

  async listProviderAccounts(): Promise<readonly ProviderAccountPublic[]> {
    return Effect.runPromise(this.repository.listProviderAccounts());
  }

  async putProviderAccount(
    provider: ProviderId,
    name: string,
    payload: ProvisionProviderAccountPayload,
  ): Promise<ProviderAccountPublic> {
    return Effect.runPromise(
      Effect.gen({ self: this }, function* () {
        const config = readSeatConfig(this.env);
        if (provider !== config.provider)
          throw new Error(`This leaf serves ${config.provider} only`);
        const encoded = encodeCredential(payload.credential);
        const persisted = yield* this.repository.putProviderAccount(
          provider,
          name,
          payload,
          encoded,
          yield* authTokenFingerprint(encoded),
          Date.now(),
        );
        yield* this.restartForProviderAccount();
        return persisted;
      }),
    );
  }

  async testProviderAccount(provider: ProviderId, name: string): Promise<ProviderAccountPublic> {
    const accounts = await this.listProviderAccounts();
    const account = accounts.find(
      (candidate) => candidate.provider === provider && candidate.name === name,
    );
    if (!account) throw new Error(`Unknown provider account ${provider}/${name}`);
    await Effect.runPromise(this.repository.readAuth(provider as SeatProvider));
    return account;
  }

  async deleteProviderAccount(provider: ProviderId, name: string): Promise<void> {
    return Effect.runPromise(
      Effect.gen({ self: this }, function* () {
        const account = (yield* this.repository.listProviderAccounts()).find(
          (candidate) => candidate.provider === provider && candidate.name === name,
        );
        if (!account) throw new Error(`Unknown provider account ${provider}/${name}`);
        yield* this.repository.deleteProviderAccount(provider);
        yield* this.restartForProviderAccount();
      }),
    );
  }

  override async fetch(request: Request): Promise<Response> {
    return Effect.runPromise(this.loggedFetchEffect(request), { signal: request.signal });
  }

  override onStart(): void {
    Effect.runSync(this.repository.recordLifecycle("running", Date.now()).pipe(Effect.orDie));
  }

  override onStop(params: StopParams): void {
    Effect.runSync(
      this.repository
        .recordLifecycle(`stopped:${params.reason}:${params.exitCode}`, Date.now())
        .pipe(Effect.orDie),
    );
  }

  override onError(error: unknown): void {
    const message = error instanceof Error ? error.message : "Unknown container error";
    Effect.runSync(
      this.repository.recordLifecycle("error", Date.now(), message).pipe(Effect.orDie),
    );
    console.error(JSON.stringify({ message: "Maskirovka seat container error", error: message }));
  }

  override async onActivityExpired(): Promise<void> {
    return Effect.runPromise(
      Effect.gen({ self: this }, function* () {
        yield* this.repository.recordLifecycle("sleeping", Date.now());
        yield* Effect.tryPromise({
          try: () => this.stop("SIGTERM"),
          catch: (cause) => cause,
        });
      }).pipe(Effect.orDie),
    );
  }

  private getSeatStatusEffect(): Effect.Effect<HostedSeatStatus, unknown> {
    return Effect.gen({ self: this }, function* () {
      const config = readSeatConfig(this.env);
      const [persisted, lifecycle, containerState, controls] = yield* Effect.all(
        [
          this.repository.readAuth(config.provider),
          this.repository.readLifecycle,
          Effect.tryPromise({ try: () => this.getState(), catch: (cause) => cause }),
          this.repository.readControls(config.aliases),
        ] as const,
        { concurrency: "unbounded" },
      );
      const configured = persisted !== undefined;
      return {
        ok:
          configured &&
          !controls.killed &&
          providerLifecycleIsHealthy(lifecycle?.status) &&
          (containerState.status === "stopped" || stateIsRunning(containerState.status)),
        service: "stavka-maskirovka-seat",
        seat_id: config.seatId,
        provider: config.provider,
        aliases: controls.aliases,
        container: {
          status: containerState.status,
          last_change: lifecycle?.lastChange ?? containerState.lastChange,
        },
        auth: {
          configured,
          persisted: persisted !== undefined,
          revision: persisted?.revision ?? 0,
          ...(persisted ? { updated_at: persisted.updatedAt } : {}),
        },
        controls: {
          killed: controls.killed,
          updated_at: controls.updatedAt,
        },
      };
    });
  }

  private getOperationsStatusEffect(): Effect.Effect<HostedSeatOperationsStatus, unknown> {
    return Effect.gen({ self: this }, function* () {
      const [status, retained] = yield* Effect.all(
        [this.getSeatStatusEffect(), this.repository.countRequests] as const,
        { concurrency: "unbounded" },
      );
      return {
        ...status,
        requests: {
          retained,
          limit: HOSTED_REQUEST_LOG_LIMIT,
          metadata_only: true,
        },
        capabilities: {
          scope: "single-hosted-seat",
          tier_remap: "model-only",
          kill_switch: "this-seat-only",
          unsupported: ["seat-registry", "fallback-routing", "budget-accounting"],
        },
      };
    });
  }

  private loggedFetchEffect(request: Request): Effect.Effect<Response, never> {
    return Effect.gen({ self: this }, function* () {
      const startedAt = Date.now();
      const queue = yield* this.invocationGovernor.snapshot;
      const response = yield* this.invocationGovernor.run(this.fetchEffect(request)).pipe(
        Effect.catch((cause) =>
          cause instanceof SeatQueueFullError
            ? Effect.succeed(
                errorJson(
                  "SEAT_QUEUE_FULL",
                  "Seat invocation queue is full; retry with backoff",
                  true,
                ),
              )
            : Effect.fail(cause),
        ),
        Effect.catch((cause) =>
          Effect.gen({ self: this }, function* () {
            const message = cause instanceof Error ? cause.message : "Hosted seat request failed";
            yield* Effect.logError("Maskirovka hosted seat failed", { cause });
            return errorJson("SEAT_UNAVAILABLE", message);
          }).pipe(Effect.annotateLogs({ seat_id: readSeatConfig(this.env).seatId })),
        ),
      );
      const dialect = request.headers.get("x-maskirovka-dialect");
      if (dialect === "openai-responses" || dialect === "anthropic-messages") {
        const log: HostedSeatRequestLog = {
          request_id: request.headers.get("x-maskirovka-request-id") ?? crypto.randomUUID(),
          timestamp: startedAt,
          dialect: dialect satisfies HostedSeatDialect,
          alias: request.headers.get("x-maskirovka-alias") ?? "unknown",
          model: request.headers.get("x-maskirovka-model") ?? "unknown",
          status: response.status,
          latency_ms: Math.max(0, Date.now() - startedAt),
          queue_depth: queue.queueDepth,
        };
        yield* this.repository
          .recordRequest(log)
          .pipe(
            Effect.catch((cause) =>
              Effect.logError("Failed to persist Maskirovka request metadata", { cause }),
            ),
          );
      }
      return response;
    });
  }

  private fetchEffect(request: Request): Effect.Effect<Response, unknown> {
    return Effect.gen({ self: this }, function* () {
      const config = readSeatConfig(this.env);
      const controls = yield* this.repository.readControls(config.aliases);
      if (controls.killed) {
        return errorJson("SEAT_KILLED", "Hosted seat traffic is disabled by the operator");
      }
      const authState = yield* this.resolveAuthState(config.provider);
      if (!authState) {
        return errorJson(
          "SEAT_AUTH_MISSING",
          `No ${config.provider} subscription credential is configured`,
        );
      }

      yield* this.ensureContainerReady(config, authState);
      const authFingerprint = yield* authTokenFingerprint(authState.token);
      const internalHeaders = new Headers(request.headers);
      internalHeaders.set(AUTH_STATE_FINGERPRINT_HEADER, authFingerprint);
      const internalRequest = new Request(request, { headers: internalHeaders });
      const upstream = yield* Effect.tryPromise({
        try: () => this.containerFetch(internalRequest),
        catch: (cause) => cause,
      }).pipe(
        Effect.catch((cause) =>
          Effect.gen({ self: this }, function* () {
            const message = cause instanceof Error ? cause.message : "Container request failed";
            yield* this.repository.recordLifecycle("disconnected", Date.now(), message);
            yield* Effect.logError("Maskirovka seat container disconnected", {
              seat_id: config.seatId,
              provider: config.provider,
              cause,
            });
            return undefined;
          }),
        ),
      );
      if (!upstream) {
        return errorJson(
          "SEAT_DISCONNECTED",
          "Seat container disconnected; retry to reconnect",
          true,
        );
      }

      const headers = new Headers(upstream.headers);
      const checkpointHeader = headers.get(AUTH_CHECKPOINT_HEADER);
      headers.delete(AUTH_CHECKPOINT_HEADER);
      if (checkpointHeader) yield* this.persistCheckpoint(config, checkpointHeader);
      if (request.headers.has("x-maskirovka-dialect")) {
        const currentLifecycle = yield* this.repository.readLifecycle;
        const transition = providerLifecycleTransition(currentLifecycle?.status, upstream.status);
        if (transition) {
          yield* this.repository.recordLifecycle(
            transition,
            Date.now(),
            transition === "running" ? undefined : `Provider returned HTTP ${upstream.status}`,
          );
        }
      }
      return new Response(upstream.body, {
        status: upstream.status,
        statusText: upstream.statusText,
        headers,
      });
    });
  }

  private resolveAuthState(
    provider: SeatProvider,
  ): Effect.Effect<PersistedAuthState | undefined, unknown> {
    return this.repository.readAuth(provider);
  }

  private restartForProviderAccount(): Effect.Effect<void, unknown> {
    return Effect.gen({ self: this }, function* () {
      const state = yield* Effect.tryPromise({
        try: () => this.getState(),
        catch: (cause) => cause,
      });
      if (stateIsRunning(state.status)) {
        yield* this.repository.recordLifecycle("restarting_auth", Date.now());
        yield* Effect.tryPromise({ try: () => this.stop("SIGTERM"), catch: (cause) => cause });
      }
    });
  }

  private ensureContainerReady(
    config: SeatConfig,
    authState: PersistedAuthState,
  ): Effect.Effect<void, unknown> {
    return this.startLock.withPermit(
      Effect.gen({ self: this }, function* () {
        const desiredFingerprint = yield* authTokenFingerprint(authState.token);
        const [state, injectedFingerprint] = yield* Effect.all(
          [
            Effect.tryPromise({
              try: () => this.getState(),
              catch: (cause) => cause,
            }),
            this.repository.readContainerAuthFingerprint,
          ] as const,
          { concurrency: "unbounded" },
        );
        if (stateIsRunning(state.status) && injectedFingerprint === desiredFingerprint) return;
        if (stateIsRunning(state.status)) {
          yield* this.repository.recordLifecycle("restarting_auth", Date.now());
          yield* Effect.tryPromise({
            try: () => this.stop("SIGTERM"),
            catch: (cause) => cause,
          });
        }
        yield* this.startContainer(config, authState, desiredFingerprint);
      }),
    );
  }

  private startContainer(
    config: SeatConfig,
    authState: PersistedAuthState,
    authFingerprint: string,
  ): Effect.Effect<void, unknown> {
    return Effect.gen({ self: this }, function* () {
      yield* this.repository.recordLifecycle("starting", Date.now());
      const checkpoint = JSON.stringify({
        version: 2,
        provider: authState.provider,
        credential: credentialFromEncoded(authState.token),
        base_fingerprint: authFingerprint,
        observed_at: authState.updatedAt,
      });
      yield* Effect.tryPromise({
        try: () =>
          this.startAndWaitForPorts({
            ports: this.requiredPorts,
            startOptions: {
              enableInternet: true,
              labels: { seat_id: config.seatId, provider: config.provider },
              envVars: {
                NODE_ENV: "production",
                PORT: String(this.defaultPort),
                MASKIROVKA_SEAT_ID: config.seatId,
                MASKIROVKA_PROVIDER: config.provider,
                MASKIROVKA_MODEL_ALIASES: JSON.stringify(config.aliases),
                MASKIROVKA_AUTH_STATE_B64: encodeBase64Url(checkpoint),
              },
            },
            cancellationOptions: {
              instanceGetTimeoutMS: 8_000,
              portReadyTimeoutMS: 30_000,
              waitInterval: 300,
            },
          }),
        catch: (cause) => cause,
      });
      yield* this.repository.writeContainerAuthFingerprint(authFingerprint);
      yield* this.repository.recordLifecycle("running", Date.now());
    });
  }

  private persistCheckpoint(config: SeatConfig, header: string): Effect.Effect<void> {
    return Effect.gen({ self: this }, function* () {
      const checkpoint = yield* Effect.try({
        try: () => decodeAuthCheckpoint(header),
        catch: (cause) => cause,
      });
      if (checkpoint.provider !== config.provider) {
        return yield* Effect.fail(new Error("Checkpoint provider mismatch"));
      }
      const existing = yield* this.repository.readAuth(config.provider);
      if (!existing)
        return yield* Effect.fail(new Error("Checkpoint received before auth bootstrap"));
      const checkpointEncoded = encodeCredential(checkpoint.credential);
      if (existing.token === checkpointEncoded) {
        const existingFingerprint = yield* authTokenFingerprint(existing.token);
        yield* this.repository.writeContainerAuthFingerprint(existingFingerprint);
        return;
      }
      const currentFingerprint = yield* authTokenFingerprint(existing.token);
      if (currentFingerprint !== checkpoint.base_fingerprint) {
        return yield* Effect.fail(new Error("Checkpoint base fingerprint is stale"));
      }
      const persisted = yield* this.repository.checkpointAuth(
        checkpoint.provider,
        checkpointEncoded,
        checkpoint.observed_at,
      );
      yield* this.repository.writeContainerAuthFingerprint(
        yield* authTokenFingerprint(persisted.token),
      );
    }).pipe(
      Effect.catch((cause) =>
        Effect.gen({ self: this }, function* () {
          const message = cause instanceof Error ? cause.message : "Invalid auth checkpoint";
          yield* this.repository
            .recordLifecycle("checkpoint_error", Date.now(), message)
            .pipe(Effect.orDie);
          yield* Effect.logError("Rejected Maskirovka auth checkpoint", {
            seat_id: config.seatId,
            provider: config.provider,
            cause,
          });
        }),
      ),
    );
  }
}
