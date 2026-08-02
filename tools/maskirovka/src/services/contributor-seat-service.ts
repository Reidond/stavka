import {
  Command,
  LlmContributorClientMessage,
  LlmContributorServerMessage,
  PROTOCOL_VERSION,
} from "@stavka/protocol";
import {
  Clock,
  Data,
  Deferred,
  Duration,
  Effect,
  Queue,
  Ref,
  Schedule,
  Schema,
} from "effect";
import * as Socket from "effect/unstable/socket/Socket";
import { WebSocket as NodeWebSocket } from "ws";

import {
  GatewayError,
  type SeatInvocation,
  type SeatResult,
  type SeatUsage,
  type TierAlias,
} from "../domain/types";
import type { SeatAdapter } from "../seats/seat-adapter";
import { FairGovernor } from "./fair-governor";
import { estimateApiListCost, WindowTracker } from "./window-tracker";

const ContributorDecision = Schema.Struct({
  summary: Schema.String,
  commands: Schema.Array(Command),
});
type ContributorDecision = typeof ContributorDecision.Type;

const decisionDocument = Schema.toJsonSchemaDocument(ContributorDecision);
const decisionJsonSchema = (Object.keys(decisionDocument.definitions).length === 0
  ? decisionDocument.schema
  : { ...decisionDocument.schema, $defs: decisionDocument.definitions }
) as Readonly<Record<string, unknown>>;

type ContributorProvider = "claude" | "codex";
type ContributorStatus = "healthy" | "exhausted";

export interface ContributorSeatOptions {
  readonly endpoint: string;
  readonly token: string;
  readonly id: string;
  readonly name: string;
  readonly provider: ContributorProvider;
  readonly models: readonly TierAlias[];
  readonly monthlyBudgetUsd: number;
  readonly priority: number;
  readonly modelByTier: Readonly<Record<TierAlias, string>>;
  readonly adapter: SeatAdapter;
  readonly concurrency?: number;
  readonly codexWindowCallLimit?: number;
  readonly codexWindowTokenLimit?: number;
  readonly codexWindowHours?: number;
  readonly tracker?: WindowTracker;
}

export class ContributorConnectionError extends Data.TaggedError(
  "ContributorConnectionError",
)<{
  readonly code: string;
  readonly message: string;
  readonly cause?: unknown;
}> {}

class ContributorDeadlineError extends Data.TaggedError("ContributorDeadlineError")<{
  readonly message: string;
}> {}

const socketAcquire = (
  endpoint: string,
  token: string,
): Effect.Effect<globalThis.WebSocket, Socket.SocketError, import("effect/Scope").Scope> =>
  Effect.acquireRelease(
    Effect.try({
      try: () => new NodeWebSocket(endpoint, {
        headers: { authorization: `Bearer ${token}` },
      }) as unknown as globalThis.WebSocket,
      catch: (cause) => new Socket.SocketError({
        reason: new Socket.SocketOpenError({ kind: "Unknown", cause }),
      }),
    }),
    (socket) => Effect.sync(() => {
      try {
        socket.close(1000, "Maskirovka contributor stopped");
      } catch {
        // The constructor boundary may be interrupted before `ws` reaches CONNECTING.
      }
    }),
  );

const connectionFailure = (
  code: string,
  message: string,
  cause?: unknown,
): ContributorConnectionError => new ContributorConnectionError({
  code,
  message,
  ...(cause === undefined ? {} : { cause }),
});

const jobFailure = (cause: unknown): {
  readonly code: string;
  readonly message: string;
  readonly retryable: boolean;
  readonly usage?: SeatUsage;
} => {
  if (cause instanceof GatewayError) {
    return {
      code: cause.code,
      message: cause.message,
      retryable: cause.status === 429 || cause.status >= 500,
      ...(cause.providerUsage === undefined ? {} : { usage: cause.providerUsage }),
    };
  }
  if (cause instanceof ContributorDeadlineError) {
    return { code: "SEAT_JOB_TIMEOUT", message: cause.message, retryable: true };
  }
  return {
    code: "SEAT_INVOCATION_FAILED",
    message: cause instanceof Error ? cause.message : "Contributor seat invocation failed",
    retryable: true,
  };
};

const decodeDecision = (
  result: SeatResult,
): Effect.Effect<ContributorDecision, GatewayError> => (result.structured === undefined
  ? Schema.decodeUnknownEffect(Schema.fromJsonString(ContributorDecision))(result.text)
  : Schema.decodeUnknownEffect(ContributorDecision)(result.structured)
).pipe(
  Effect.mapError((cause) => new GatewayError(
    502,
    "INVALID_SEAT_RESPONSE",
    "Subscription seat returned an invalid Stavka decision",
    [String(cause)],
  )),
);

const reconnectSchedule = Schedule.exponential("1 second").pipe(
  Schedule.modifyDelay(({ duration }) =>
    Effect.succeed(Duration.min(duration, Duration.seconds(30)))),
  Schedule.jittered,
);

/**
 * Runs one outbound-only subscription seat until interrupted. Every connection
 * owns its writer queue, heartbeat, and invocation fibers in a scope, so a
 * disconnect cancels in-flight SDK calls before the reconnect schedule runs.
 */
export const runContributorSeat = (
  options: ContributorSeatOptions,
): Effect.Effect<never, ContributorConnectionError> => Effect.gen(function*() {
  const tracker = options.tracker ?? new WindowTracker({
    claudeMonthlyCreditUsd: options.provider === "claude" ? options.monthlyBudgetUsd : 0,
    codexWindowCalls: options.codexWindowCallLimit ?? 0,
    codexWindowTokens: options.codexWindowTokenLimit ?? 0,
    codexWindowMs: (options.codexWindowHours ?? 5) * 60 * 60 * 1_000,
  });
  yield* tracker.initialize().pipe(Effect.mapError((cause) => connectionFailure(
    "USAGE_TRACKER_FAILURE",
    "Could not restore contributor usage headroom",
    cause,
  )));
  const governor = new FairGovernor(options.concurrency ?? (options.provider === "claude" ? 2 : 1));

  const connectOnce = Effect.scoped(Effect.gen(function*() {
    const outbound = yield* Queue.unbounded<string>();
    const heartbeatTtl = yield* Ref.make(45);
    const registered = yield* Deferred.make<void>();
    const socket = yield* Socket.fromWebSocket(
      socketAcquire(options.endpoint, options.token),
      { closeCodeIsError: () => true, openTimeout: "10 seconds" },
    );
    const write = yield* socket.writer;

    const encode = (message: LlmContributorClientMessage): Effect.Effect<
      string,
      ContributorConnectionError
    > => Schema.encodeEffect(Schema.fromJsonString(LlmContributorClientMessage))(message).pipe(
      Effect.mapError((cause) => connectionFailure(
        "INVALID_CLIENT_MESSAGE",
        "Could not encode contributor protocol message",
        cause,
      )),
    );
    const send = (message: LlmContributorClientMessage): Effect.Effect<
      void,
      ContributorConnectionError
    > => encode(message).pipe(
      Effect.flatMap((encoded) => Queue.offer(outbound, encoded)),
      Effect.asVoid,
    );

    const status = (): Effect.Effect<ContributorStatus> => Effect.sync(() =>
      tracker.isExhausted(options.provider) ||
          (options.provider === "claude" &&
            tracker.monthlySeatUsage("claude") >= options.monthlyBudgetUsd)
        ? "exhausted"
        : "healthy");

    const heartbeat = Effect.gen(function*() {
      yield* Deferred.await(registered).pipe(Effect.timeoutOrElse({
        duration: "15 seconds",
        orElse: () => Effect.fail(connectionFailure(
          "REGISTRATION_TIMEOUT",
          "Commander did not acknowledge contributor registration",
        )),
      }));
      while (true) {
        const snapshot = yield* Effect.sync(() => governor.snapshot());
        yield* send({
          protocol_version: PROTOCOL_VERSION,
          type: "heartbeat",
          seat_id: options.id,
          status: yield* status(),
          active: snapshot.active,
          queue_depth: snapshot.queueDepth,
        });
        const ttl = yield* Ref.get(heartbeatTtl);
        yield* Effect.sleep(`${Math.max(1, Math.floor(ttl / 2))} seconds`);
      }
    });
    const invoke = (
      message: Extract<LlmContributorServerMessage, { readonly type: "invoke" }>,
    ): Effect.Effect<void, ContributorConnectionError> => Effect.gen(function*() {
      const failure = yield* Effect.result(Effect.gen(function*() {
        if (message.invocation.tier !== message.invocation.model) {
          return yield* Effect.fail(new GatewayError(
            400,
            "INVALID_SEAT_MODEL",
            "Contributor invocation model must match its Stavka tier alias",
          ));
        }
        const expectedDialect = options.provider === "claude"
          ? "anthropic-messages"
          : "openai-responses";
        if (message.invocation.dialect !== expectedDialect) {
          return yield* Effect.fail(new GatewayError(
            400,
            "INVALID_SEAT_DIALECT",
            `${options.provider} contributor cannot serve ${message.invocation.dialect}`,
          ));
        }
        if (
          options.provider === "claude" &&
          tracker.monthlySeatUsage("claude") >= options.monthlyBudgetUsd
        ) {
          return yield* Effect.fail(new GatewayError(
            429,
            "SEAT_BUDGET_EXHAUSTED",
            "Contributor seat monthly budget is exhausted",
          ));
        }
        const now = yield* Clock.currentTimeMillis;
        const deadline = Date.parse(message.deadline_at);
        if (!Number.isFinite(deadline) || deadline <= now) {
          return yield* Effect.fail(new ContributorDeadlineError({
            message: `Contributor job ${message.job_id} deadline has elapsed`,
          }));
        }
        const request: SeatInvocation = {
          dialect: message.invocation.dialect,
          tier: message.invocation.tier,
          request: {
            model: message.invocation.tier,
            input: message.invocation.prompt,
          },
          prompt: message.invocation.prompt,
          outputSchema: decisionJsonSchema,
          structuredOutputName: "stavka_decision",
          model: options.modelByTier[message.invocation.tier],
        };
        const completed = yield* governor.run(
          Effect.acquireUseRelease(
            tracker.reserve({
              seat: options.provider,
              tier: message.invocation.tier,
              expectedUsage: {
                inputTokens: Math.max(1, Math.ceil(message.invocation.prompt.length / 4)),
                outputTokens: 1_024,
              },
              ttlMs: deadline - now,
            }),
            (reservation) => options.adapter.invoke(request).pipe(
              Effect.flatMap((result) => {
                const usage = {
                  inputTokens: Math.max(0, Math.floor(result.usage.inputTokens)),
                  outputTokens: Math.max(0, Math.floor(result.usage.outputTokens)),
                  ...(result.usage.cachedInputTokens === undefined
                    ? {}
                    : {
                        cachedInputTokens: Math.max(
                          0,
                          Math.floor(result.usage.cachedInputTokens),
                        ),
                      }),
                };
                const planCreditUsd = result.usage.planCreditUsd ?? estimateApiListCost(
                  message.invocation.tier,
                  usage,
                );
                return Effect.result(decodeDecision(result)).pipe(
                  Effect.flatMap((decoded) => tracker.reconcile(reservation, {
                    seat: options.provider,
                    tier: message.invocation.tier,
                    usage,
                    cacheHit: false,
                    actualCostUsd: 0,
                    planCreditUsd,
                    ...(decoded._tag === "Failure"
                      ? {
                          outcome: "failure" as const,
                          failureCode: decoded.failure.code,
                        }
                      : {}),
                  }).pipe(
                    Effect.flatMap((accounting) => decoded._tag === "Failure"
                      ? Effect.fail(new GatewayError(
                          decoded.failure.status,
                          decoded.failure.code,
                          decoded.failure.message,
                          decoded.failure.details,
                          {
                            ...usage,
                            planCreditUsd,
                          },
                        ))
                      : Effect.succeed({
                          accounting,
                          decision: decoded.success,
                          planCreditUsd,
                          result,
                          usage,
                        })),
                  )),
                );
              }),
              Effect.catch((error) => {
                if (error.providerUsage === undefined || error.code === "INVALID_SEAT_RESPONSE") {
                  return Effect.fail(error);
                }
                const usage = {
                  inputTokens: Math.max(0, Math.floor(error.providerUsage.inputTokens)),
                  outputTokens: Math.max(0, Math.floor(error.providerUsage.outputTokens)),
                  ...(error.providerUsage.cachedInputTokens === undefined
                    ? {}
                    : {
                        cachedInputTokens: Math.max(
                          0,
                          Math.floor(error.providerUsage.cachedInputTokens),
                        ),
                      }),
                };
                const planCreditUsd = error.providerUsage.planCreditUsd ?? estimateApiListCost(
                  message.invocation.tier,
                  usage,
                );
                return tracker.reconcile(reservation, {
                  seat: options.provider,
                  tier: message.invocation.tier,
                  usage,
                  cacheHit: false,
                  actualCostUsd: 0,
                  planCreditUsd,
                  outcome: "failure",
                  failureCode: error.code,
                }).pipe(Effect.andThen(Effect.fail(error)));
              }),
            ),
            (reservation) => tracker.refund(reservation),
          ),
        ).pipe(
          Effect.timeoutOrElse({
            duration: Math.max(1, deadline - now),
            orElse: () => Effect.fail(new ContributorDeadlineError({
              message: `Contributor job ${message.job_id} exceeded its deadline`,
            })),
          }),
        );
        yield* send({
          protocol_version: PROTOCOL_VERSION,
          type: "result",
          job_id: message.job_id,
          seat_id: options.id,
          ok: true,
          decision: completed.decision,
          raw_response: completed.result.text,
          resolved_model: request.model,
          usage: {
            input_tokens: completed.usage.inputTokens,
            output_tokens: completed.usage.outputTokens,
            ...(completed.usage.cachedInputTokens === undefined
              ? {}
              : { cached_input_tokens: completed.usage.cachedInputTokens }),
            estimated_cost_usd: Math.max(0, completed.planCreditUsd),
          },
        });
        if (tracker.isExhausted(options.provider) ||
          (options.provider === "claude" &&
            completed.accounting.budgetUsedUsd >= options.monthlyBudgetUsd)) {
          yield* Effect.logWarning(`Contributor seat ${options.id} exhausted its configured budget`);
        }
      }));
      if (failure._tag === "Success") return;
      const encoded = jobFailure(failure.failure);
      const failureUsage = encoded.usage;
      yield* send({
        protocol_version: PROTOCOL_VERSION,
        type: "result",
        job_id: message.job_id,
        seat_id: options.id,
        ok: false,
        code: encoded.code,
        message: encoded.message,
        retryable: encoded.retryable,
        exhausted: encoded.code === "SEAT_BUDGET_EXHAUSTED" ||
          encoded.code === "SEAT_PLAN_WINDOW_EXHAUSTED",
        resolved_model: options.modelByTier[message.invocation.tier],
        ...(failureUsage === undefined
          ? {}
          : {
              usage: {
                input_tokens: Math.max(0, Math.floor(failureUsage.inputTokens)),
                output_tokens: Math.max(0, Math.floor(failureUsage.outputTokens)),
                ...(failureUsage.cachedInputTokens === undefined
                  ? {}
                  : {
                      cached_input_tokens: Math.max(
                        0,
                        Math.floor(failureUsage.cachedInputTokens),
                      ),
                    }),
                estimated_cost_usd: Math.max(
                  0,
                  failureUsage.planCreditUsd ?? failureUsage.actualCostUsd ?? 0,
                ),
              },
            }),
      });
    });

    const receive = (raw: string): Effect.Effect<void, ContributorConnectionError> =>
      Schema.decodeUnknownEffect(
        Schema.fromJsonString(LlmContributorServerMessage),
        { onExcessProperty: "error" },
      )(raw).pipe(
        Effect.mapError((cause) => connectionFailure(
          "INVALID_SERVER_MESSAGE",
          "Commander sent an invalid contributor protocol message",
          cause,
        )),
        Effect.flatMap((message) => {
          if (message.type === "error") {
            return Effect.fail(connectionFailure(message.code, message.message));
          }
          if (message.type === "registered") {
            if (message.seat_id !== options.id) {
              return Effect.fail(connectionFailure(
                "SEAT_ID_MISMATCH",
                "Commander registered a different contributor seat id",
              ));
            }
            return Ref.set(heartbeatTtl, message.heartbeat_ttl_seconds).pipe(
              Effect.andThen(Deferred.succeed(registered, undefined)),
              Effect.andThen(Effect.logInfo(`Contributor seat ${options.id} registered`)),
            );
          }
          if (message.type === "heartbeat_ack") {
            return message.seat_id === options.id
              ? Effect.void
              : Effect.fail(connectionFailure(
                "SEAT_ID_MISMATCH",
                "Commander acknowledged a different contributor seat id",
              ));
          }
          if (message.type === "result_ack") {
            return message.accepted
              ? Effect.void
              : Effect.logWarning(`Commander rejected contributor job ${message.job_id}`);
          }
          if (message.seat_id !== options.id) {
            return Effect.fail(connectionFailure(
              "SEAT_ID_MISMATCH",
              "Commander invoked a different contributor seat id",
            ));
          }
          return invoke(message);
        }),
      );

    const writer = Queue.take(outbound).pipe(
      Effect.flatMap(write),
      Effect.forever,
      Effect.mapError((cause) => connectionFailure(
        "SOCKET_WRITE_FAILED",
        "Contributor WebSocket write failed",
        cause,
      )),
    );
    const registration = yield* encode({
      protocol_version: PROTOCOL_VERSION,
      type: "register",
      seat: {
        id: options.id,
        name: options.name,
        models: options.models,
        monthlyBudgetUsd: options.monthlyBudgetUsd,
        priority: options.priority,
        mode: "contributor",
        provider: options.provider,
      },
    });
    const reader = socket.runString(receive, {
      onOpen: Queue.offer(outbound, registration).pipe(Effect.asVoid),
    }).pipe(
      Effect.mapError((cause) => cause instanceof ContributorConnectionError
        ? cause
        : connectionFailure(
          "SOCKET_READ_FAILED",
          "Contributor WebSocket connection failed",
          cause,
        )),
    );
    return yield* Effect.raceFirst(reader, Effect.raceFirst(writer, heartbeat));
  })).pipe(
    Effect.andThen(Effect.fail(connectionFailure(
      "SOCKET_DISCONNECTED",
      "Contributor WebSocket disconnected",
    ))),
  );

  return yield* connectOnce.pipe(
    Effect.catch((cause) => Effect.logWarning(
      `Contributor seat ${options.id} disconnected (${cause.code}); reconnecting`,
    ).pipe(Effect.andThen(Effect.fail(cause)))),
    Effect.retry(reconnectSchedule),
  );
});
