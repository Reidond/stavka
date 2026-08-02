import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import {
  decodeLlmContributorClientMessage,
  type LlmContributorClientMessage,
} from "@stavka/protocol";
import { Effect, Fiber } from "effect";
import { describe, expect, it } from "vitest";
import { WebSocket, WebSocketServer } from "ws";

import { MemoryWindowTrackerRepository } from "../src/repositories/window-tracker-repository";
import type { SeatAdapter } from "../src/seats/seat-adapter";
import { runContributorSeat } from "../src/services/contributor-seat-service";
import { WindowTracker } from "../src/services/window-tracker";

interface DeferredValue<A> {
  readonly promise: Promise<A>;
  readonly resolve: (value: A) => void;
}

const deferred = <A>(): DeferredValue<A> => {
  let resolve!: (value: A) => void;
  const promise = new Promise<A>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
};

const withTimeout = <A>(promise: Promise<A>, label: string): Promise<A> =>
  Promise.race([
    promise,
    new Promise<never>((_resolve, reject) => {
      setTimeout(() => reject(new Error(`Timed out waiting for ${label}`)), 5_000);
    }),
  ]);

describe("outbound contributor seat", () => {
  it("authenticates, registers, heartbeats, serves jobs, and cancels on shutdown", async () => {
    const httpServer = createServer();
    const webSocketServer = new WebSocketServer({ server: httpServer });
    const registered = deferred<LlmContributorClientMessage>();
    const heartbeat = deferred<LlmContributorClientMessage>();
    const result = deferred<LlmContributorClientMessage>();
    const invalidResult = deferred<LlmContributorClientMessage>();
    const invocationStarted = deferred<void>();
    const invocationCancelled = deferred<void>();
    const socketClosed = deferred<void>();
    let authorization: string | undefined;
    let connectedSocket: WebSocket | undefined;

    webSocketServer.on("connection", (socket, request) => {
      connectedSocket = socket;
      authorization = request.headers.authorization;
      socket.on("message", (raw) => {
        const message = decodeLlmContributorClientMessage(JSON.parse(raw.toString()));
        if (message.type === "register") {
          registered.resolve(message);
          socket.send(JSON.stringify({
            protocol_version: 1,
            type: "registered",
            seat_id: message.seat.id,
            heartbeat_ttl_seconds: 1,
          }));
          return;
        }
        if (message.type === "heartbeat") {
          heartbeat.resolve(message);
          socket.send(JSON.stringify({
            protocol_version: 1,
            type: "heartbeat_ack",
            seat_id: message.seat_id,
            expires_at: new Date(Date.now() + 1_000).toISOString(),
          }));
          return;
        }
        if (message.type === "result" && message.job_id === "job_invalid") {
          invalidResult.resolve(message);
        } else {
          result.resolve(message);
        }
      });
      socket.on("close", () => socketClosed.resolve());
    });

    await new Promise<void>((resolve, reject) => {
      httpServer.once("error", reject);
      httpServer.listen(0, "127.0.0.1", resolve);
    });
    const address = httpServer.address() as AddressInfo;
    const adapter: SeatAdapter = {
      id: "claude",
      invoke: (request) => request.prompt === "cancel this job"
        ? Effect.sync(() => invocationStarted.resolve()).pipe(
            Effect.andThen(Effect.never),
            Effect.onInterrupt(() => Effect.sync(() => invocationCancelled.resolve())),
          )
        : request.prompt === "invalid response"
          ? Effect.succeed({
              text: "not-json",
              usage: { inputTokens: 5, outputTokens: 4, planCreditUsd: 0.1 },
            })
        : Effect.succeed({
            text: JSON.stringify({ summary: "hold", commands: [] }),
            structured: { summary: "hold", commands: [] },
            usage: { inputTokens: 11, outputTokens: 7, cachedInputTokens: 3 },
          }),
    };
    const trackerRepository = new MemoryWindowTrackerRepository();
    const tracker = new WindowTracker({
      claudeMonthlyCreditUsd: 20,
      codexWindowCalls: 0,
      codexWindowTokens: 0,
      codexWindowMs: 5 * 60 * 60 * 1_000,
    }, trackerRepository);
    const client = Effect.runFork(runContributorSeat({
      endpoint: `ws://127.0.0.1:${address.port}`,
      token: "test-registration-token",
      id: "test-claude-seat",
      name: "Test Claude seat",
      provider: "claude",
      models: ["stavka/commander", "stavka/sergeant", "stavka/heavy"],
      monthlyBudgetUsd: 20,
      priority: 50,
      modelByTier: {
        "stavka/commander": "claude-fable-5",
        "stavka/sergeant": "claude-sonnet-5",
        "stavka/heavy": "claude-opus-5",
      },
      adapter,
      tracker,
    }));

    try {
      const registerMessage = await withTimeout(registered.promise, "seat registration");
      expect(authorization).toBe("Bearer test-registration-token");
      expect(registerMessage).toMatchObject({
        type: "register",
        seat: {
          id: "test-claude-seat",
          mode: "contributor",
          provider: "claude",
          monthlyBudgetUsd: 20,
        },
      });
      await withTimeout(heartbeat.promise, "seat heartbeat");

      connectedSocket?.send(JSON.stringify({
        protocol_version: 1,
        type: "invoke",
        job_id: "job_success",
        seat_id: "test-claude-seat",
        deadline_at: new Date(Date.now() + 5_000).toISOString(),
        invocation: {
          tier: "stavka/commander",
          model: "stavka/commander",
          dialect: "anthropic-messages",
          prompt: "hold position",
          response_format: "stavka-decision-v1",
        },
      }));
      expect(await withTimeout(result.promise, "successful contributor result")).toMatchObject({
        type: "result",
        job_id: "job_success",
        seat_id: "test-claude-seat",
        ok: true,
        decision: { summary: "hold", commands: [] },
        resolved_model: "claude-fable-5",
        usage: {
          input_tokens: 11,
          output_tokens: 7,
          cached_input_tokens: 3,
          estimated_cost_usd: expect.any(Number),
        },
      });

      connectedSocket?.send(JSON.stringify({
        protocol_version: 1,
        type: "invoke",
        job_id: "job_invalid",
        seat_id: "test-claude-seat",
        deadline_at: new Date(Date.now() + 5_000).toISOString(),
        invocation: {
          tier: "stavka/commander",
          model: "stavka/commander",
          dialect: "anthropic-messages",
          prompt: "invalid response",
          response_format: "stavka-decision-v1",
        },
      }));
      expect(await withTimeout(invalidResult.promise, "invalid contributor result")).toMatchObject({
        type: "result",
        job_id: "job_invalid",
        ok: false,
        code: "INVALID_SEAT_RESPONSE",
        resolved_model: "claude-fable-5",
        usage: {
          input_tokens: 5,
          output_tokens: 4,
          estimated_cost_usd: expect.any(Number),
        },
      });
      expect(trackerRepository.value?.entries).toContainEqual(expect.objectContaining({
        outcome: "failure",
        failureCode: "INVALID_SEAT_RESPONSE",
        tokens: 9,
      }));

      const beforeCancellation = tracker.snapshot();
      connectedSocket?.send(JSON.stringify({
        protocol_version: 1,
        type: "invoke",
        job_id: "job_cancel",
        seat_id: "test-claude-seat",
        deadline_at: new Date(Date.now() + 30_000).toISOString(),
        invocation: {
          tier: "stavka/commander",
          model: "stavka/commander",
          dialect: "anthropic-messages",
          prompt: "cancel this job",
          response_format: "stavka-decision-v1",
        },
      }));
      await withTimeout(invocationStarted.promise, "second invocation start");
      await Effect.runPromise(Fiber.interrupt(client));
      await withTimeout(invocationCancelled.promise, "in-flight invocation cancellation");
      await withTimeout(socketClosed.promise, "WebSocket closure");
      expect(tracker.snapshot()).toEqual(beforeCancellation);
      expect(trackerRepository.value?.reservations).toEqual([]);
    } finally {
      await Effect.runPromise(Fiber.interrupt(client));
      await new Promise<void>((resolve) => webSocketServer.close(() => resolve()));
      await new Promise<void>((resolve, reject) => {
        httpServer.close((error) => error ? reject(error) : resolve());
      });
    }
  }, 15_000);

  it("reconnects and re-registers after a remote close", async () => {
    const httpServer = createServer();
    const webSocketServer = new WebSocketServer({ server: httpServer });
    const reconnected = deferred<void>();
    let connections = 0;

    webSocketServer.on("connection", (socket, request) => {
      expect(request.headers.authorization).toBe("Bearer test-registration-token");
      connections += 1;
      socket.on("message", (raw) => {
        const message = decodeLlmContributorClientMessage(JSON.parse(raw.toString()));
        if (message.type !== "register") return;
        socket.send(JSON.stringify({
          protocol_version: 1,
          type: "registered",
          seat_id: message.seat.id,
          heartbeat_ttl_seconds: 2,
        }));
        if (connections === 1) socket.close(1012, "restart test");
        else reconnected.resolve();
      });
    });
    await new Promise<void>((resolve, reject) => {
      httpServer.once("error", reject);
      httpServer.listen(0, "127.0.0.1", resolve);
    });
    const address = httpServer.address() as AddressInfo;
    const client = Effect.runFork(runContributorSeat({
      endpoint: `ws://127.0.0.1:${address.port}`,
      token: "test-registration-token",
      id: "test-claude-seat",
      name: "Test Claude seat",
      provider: "claude",
      models: ["stavka/commander"],
      monthlyBudgetUsd: 20,
      priority: 50,
      modelByTier: {
        "stavka/commander": "claude-fable-5",
        "stavka/sergeant": "claude-sonnet-5",
        "stavka/heavy": "claude-opus-5",
      },
      adapter: {
        id: "claude",
        invoke: () => Effect.die(new Error("reconnect test must not invoke a provider")),
      },
    }));
    try {
      await withTimeout(reconnected.promise, "contributor reconnect");
      expect(connections).toBe(2);
    } finally {
      await Effect.runPromise(Fiber.interrupt(client));
      for (const socket of webSocketServer.clients) socket.terminate();
      await new Promise<void>((resolve) => webSocketServer.close(() => resolve()));
      await new Promise<void>((resolve, reject) => {
        httpServer.close((error) => error ? reject(error) : resolve());
      });
    }
  }, 15_000);
});
