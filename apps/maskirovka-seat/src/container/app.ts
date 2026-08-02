import { Context, Effect, Layer } from "effect";
import { HttpEffect, HttpRouter, HttpServer, HttpServerResponse } from "effect/unstable/http";
import { HttpApiBuilder } from "effect/unstable/httpapi";

import {
  AUTH_CHECKPOINT_HEADER,
  AUTH_STATE_FINGERPRINT_HEADER,
  encodeAuthCheckpoint,
  type AuthCheckpoint,
} from "../auth-checkpoint";
import { decodeAnthropicMessagesRequest, decodeOpenAIResponsesRequest } from "../contracts";
import type { SeatProvider } from "../config";
import {
  BadGatewayError,
  BadRequestError,
  ContainerApi,
  NotFoundError,
  PayloadTooLargeError,
  GatewayTimeoutError,
  ServiceUnavailableError,
  TooManyRequestsError,
  UnsupportedMediaTypeError,
} from "../http-contract";
import { readBoundedJson, RequestBodyError } from "../request-body";
import { ProviderInvocationError, type SeatRunner } from "./runner";

export interface ContainerAppConfig {
  readonly seatId: string;
  readonly provider: SeatProvider;
  readonly aliases: Readonly<Record<string, string>>;
}

export interface ContainerAppDependencies {
  readonly config: ContainerAppConfig;
  readonly runner: SeatRunner;
  readonly authConfigured: Effect.Effect<boolean>;
  readonly authCheckpoint: (
    baseFingerprint: string | undefined,
  ) => Effect.Effect<AuthCheckpoint | undefined>;
  readonly now?: () => number;
}

export class ContainerRuntime extends Context.Service<ContainerRuntime, ContainerAppDependencies>()(
  "stavka/maskirovka-seat/ContainerRuntime",
) {}

const errorBody = (code: string, message: string, parameter?: string) => ({
  error: {
    code,
    message,
    ...(parameter ? { param: parameter } : {}),
  },
});

const badRequest = (code: string, message: string, parameter?: string): BadRequestError =>
  new BadRequestError(errorBody(code, message, parameter));

const notFound = (code: string, message: string): NotFoundError =>
  new NotFoundError(errorBody(code, message));

const decodeBody = <T, E>(
  request: Parameters<typeof readBoundedJson>[0],
  decode: (input: unknown) => Effect.Effect<T, E>,
): Effect.Effect<T, BadRequestError | PayloadTooLargeError | UnsupportedMediaTypeError> =>
  readBoundedJson(request).pipe(
    Effect.flatMap(decode),
    Effect.mapError((error) => {
      if (error instanceof RequestBodyError) {
        if (error.code === "PAYLOAD_TOO_LARGE") {
          return new PayloadTooLargeError(errorBody(error.code, error.message));
        }
        if (error.code === "UNSUPPORTED_ENCODING") {
          return new UnsupportedMediaTypeError(errorBody(error.code, error.message));
        }
        return badRequest(error.code, error.message);
      }
      const dialectError = error as { readonly message?: unknown; readonly parameter?: unknown };
      return badRequest(
        "INVALID_REQUEST",
        typeof dialectError.message === "string" ? dialectError.message : "Invalid request",
        typeof dialectError.parameter === "string" ? dialectError.parameter : undefined,
      );
    }),
  );

const providerFailure = (
  error: ProviderInvocationError,
): BadGatewayError | GatewayTimeoutError | ServiceUnavailableError | TooManyRequestsError => {
  console.error(
    JSON.stringify({
      message: "Maskirovka subscription provider request failed",
      provider: error.provider,
      error: error.message,
    }),
  );
  const body = {
    error: {
      code: error.reason === "auth"
        ? "PROVIDER_AUTH_FAILED"
        : error.reason === "rate_limit"
          ? "PROVIDER_RATE_LIMITED"
          : error.reason === "timeout"
            ? "PROVIDER_TIMEOUT"
            : "PROVIDER_ERROR",
      message: "Subscription provider request failed",
      retryable: error.retryable,
      ...(error.resolvedModel ? { resolved_model: error.resolvedModel } : {}),
      ...(error.usage
        ? {
            usage: {
              input_tokens: error.usage.inputTokens,
              output_tokens: error.usage.outputTokens,
              ...(error.usage.cachedInputTokens === undefined
                ? {}
                : { cached_input_tokens: error.usage.cachedInputTokens }),
              ...(error.usage.estimatedCostUsd === undefined
                ? {}
                : { estimated_cost_usd: error.usage.estimatedCostUsd }),
            },
          }
        : {}),
    },
  };
  if (error.reason === "auth") return new ServiceUnavailableError(body);
  if (error.reason === "rate_limit") return new TooManyRequestsError(body);
  if (error.reason === "timeout") return new GatewayTimeoutError(body);
  return new BadGatewayError(body);
};

const addCheckpointHeader = (
  checkpoint: ContainerAppDependencies["authCheckpoint"],
): Effect.Effect<void, never, import("effect/unstable/http/HttpServerRequest").HttpServerRequest> =>
  HttpEffect.appendPreResponseHandler((request, response) =>
    checkpoint(request.headers[AUTH_STATE_FINGERPRINT_HEADER]).pipe(
      Effect.map((rotated) =>
        rotated
          ? HttpServerResponse.setHeader(
              response,
              AUTH_CHECKPOINT_HEADER,
              encodeAuthCheckpoint(rotated),
            )
          : response,
      ),
    ),
  );

const ContainerGroupLive = HttpApiBuilder.group(ContainerApi, "container", (handlers) =>
  handlers
    .handle("health", () =>
      Effect.gen(function* () {
        const dependencies = yield* ContainerRuntime;
        const configured = yield* dependencies.authConfigured;
        return HttpServerResponse.jsonUnsafe(
          {
            ok: configured,
            service: "stavka-maskirovka-seat-container",
            seat_id: dependencies.config.seatId,
            provider: dependencies.config.provider,
            models: Object.values(dependencies.config.aliases),
            now: (dependencies.now ?? Date.now)(),
          },
          {
            status: configured ? 200 : 503,
            headers: { "cache-control": "no-store" },
          },
        );
      }),
    )
    .handle("models", () =>
      Effect.gen(function* () {
        const dependencies = yield* ContainerRuntime;
        return {
          object: "list" as const,
          data: Object.entries(dependencies.config.aliases).map(([alias, model]) => ({
            id: alias,
            object: "model" as const,
            owned_by: `maskirovka:${dependencies.config.provider}`,
            resolution: { model },
          })),
        };
      }),
    )
    .handleRaw("responses", ({ request }) =>
      Effect.gen(function* () {
        const dependencies = yield* ContainerRuntime;
        if (dependencies.config.provider !== "codex") {
          return yield* Effect.fail(notFound("DIALECT_NOT_SERVED", "Codex seat required"));
        }
        yield* addCheckpointHeader(dependencies.authCheckpoint);
        const input = yield* decodeBody(request, decodeOpenAIResponsesRequest);
        return yield* dependencies.runner
          .runResponses(input)
          .pipe(Effect.mapError(providerFailure));
      }),
    )
    .handleRaw("messages", ({ request }) =>
      Effect.gen(function* () {
        const dependencies = yield* ContainerRuntime;
        if (dependencies.config.provider !== "claude") {
          return yield* Effect.fail(notFound("DIALECT_NOT_SERVED", "Claude seat required"));
        }
        yield* addCheckpointHeader(dependencies.authCheckpoint);
        const input = yield* decodeBody(request, decodeAnthropicMessagesRequest);
        return yield* dependencies.runner.runMessages(input).pipe(Effect.mapError(providerFailure));
      }),
    )
    .handle("legacyChatCompletions", () =>
      Effect.fail(
        notFound("LEGACY_DIALECT_REMOVED", "Chat Completions is not available; use /v1/responses"),
      ),
    ),
);

export const createContainerRoutes = (dependencies: ContainerAppDependencies) =>
  HttpApiBuilder.layer(ContainerApi).pipe(
    Layer.provide(ContainerGroupLive),
    HttpRouter.provideRequest(Layer.succeed(ContainerRuntime)(dependencies)),
  );

export const createContainerTestHandler = (dependencies: ContainerAppDependencies) =>
  HttpRouter.toWebHandler(
    createContainerRoutes(dependencies).pipe(Layer.provide(HttpServer.layerServices)),
    { disableLogger: true },
  );
