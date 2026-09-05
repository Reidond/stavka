import { createServer, type Server } from "node:http";

import { Effect } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";

import { runAiDecision } from "../src/brain/llm-client";
import type { CommanderConfig } from "../src/config";

const config: CommanderConfig = {
  commanderModel: "stavka/commander",
  sergeantModel: "stavka/sergeant",
  heavyModel: "stavka/heavy",
  decisionIntervalSeconds: 45,
  doctrine: "balanced",
  maxActiveUnits: 50,
  difficulty: 0.5,
  playerScaling: true,
  tickIdleMs: 2_000,
  tickActiveMs: 750,
  tickBurstMs: 300,
  aiProvider: "anthropic",
  aiBaseUrl: "http://127.0.0.1:4141",
  aiKey: "seat-secret",
  seatExhaustionPolicy: "fallback",
  seatStretchMultiplier: 4,
  seatHeartbeatTtlSeconds: 45,
  seatJobTimeoutSeconds: 30,
  seatKeys: {},
};

describe("Commander Anthropic gateway client", () => {
  let server: Server | undefined;

  afterEach(async () => {
    vi.unstubAllGlobals();
    if (server !== undefined) {
      await new Promise<void>((resolve, reject) =>
        server!.close((error) => (error ? reject(error) : resolve())),
      );
      server = undefined;
    }
  });

  it("sends the tier alias, bearer auth, and structured-output schema to Maskirovka", async () => {
    let received:
      | {
          readonly body: Record<string, unknown>;
          readonly headers: Record<string, string | string[] | undefined>;
          readonly url: string;
        }
      | undefined;
    server = createServer((request, response) => {
      const chunks: Uint8Array[] = [];
      request.on("data", (chunk: Uint8Array) => chunks.push(chunk));
      request.on("end", () => {
        received = {
          body: JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>,
          headers: request.headers,
          url: request.url ?? "",
        };
        response.writeHead(200, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            id: "msg_test",
            type: "message",
            role: "assistant",
            model: "claude-fable-5",
            content: [
              {
                type: "text",
                text: JSON.stringify({ summary: "Hold position", commands: [] }),
              },
            ],
            stop_reason: "end_turn",
            stop_sequence: null,
            usage: {
              cache_creation: null,
              cache_creation_input_tokens: null,
              cache_read_input_tokens: null,
              inference_geo: null,
              input_tokens: 12,
              output_tokens: 5,
              service_tier: "standard",
            },
          }),
        );
      });
    });
    await new Promise<void>((resolve, reject) => {
      server!.once("error", reject);
      server!.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("Expected TCP address");

    const result = await Effect.runPromise(
      runAiDecision(
        {
          ...config,
          aiBaseUrl: `http://127.0.0.1:${address.port}`,
        },
        {
          model: "stavka/commander",
          prompt: "Hold position",
        },
      ),
    );

    expect(result.decision).toEqual({ summary: "Hold position", commands: [] });
    expect(result.tokenUsage).toEqual({ input: 12, output: 5 });
    expect(received?.url).toBe("/v1/messages?beta=true");
    expect(received?.headers.authorization).toBe("Bearer seat-secret");
    expect(received?.headers["x-api-key"]).toBeUndefined();
    expect(received?.body.model).toBe("stavka/commander");
    expect(received?.body.output_config).toMatchObject({
      format: {
        type: "json_schema",
        schema: { type: "object" },
      },
    });
  });

  it("uses the private service binding even when platform fetch is unavailable", async () => {
    const publicFetch = vi.fn(async () => {
      throw new Error("Unexpected public fetch");
    });
    vi.stubGlobal("fetch", publicFetch);
    const bindingFetch = vi.fn(async (_request: Request) =>
      Response.json({
        id: "msg_binding",
        type: "message",
        role: "assistant",
        model: "claude-fable-5",
        content: [
          { type: "text", text: JSON.stringify({ summary: "Private binding", commands: [] }) },
        ],
        stop_reason: "end_turn",
        stop_sequence: null,
        usage: {
          cache_creation: null,
          cache_creation_input_tokens: null,
          cache_read_input_tokens: null,
          inference_geo: null,
          input_tokens: 12,
          output_tokens: 5,
          service_tier: "standard",
        },
      }),
    );
    const result = await Effect.runPromise(
      runAiDecision(
        {
          ...config,
          inferenceService: { fetch: bindingFetch } as unknown as Fetcher,
          executionSession: { session_id: "owner-session", mission_epoch: 4, faction: "OPFOR" },
        },
        { model: "stavka/commander", prompt: "Hold position" },
      ),
    );
    expect(result.decision.summary).toBe("Private binding");
    expect(bindingFetch).toHaveBeenCalledOnce();
    expect(
      JSON.parse(bindingFetch.mock.calls[0]![0].headers.get("x-stavka-execution-session")!),
    ).toEqual({ session_id: "owner-session", mission_epoch: 4, faction: "OPFOR" });
    expect(publicFetch).not.toHaveBeenCalled();
  });
});
