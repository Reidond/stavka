import { describe, expect, it, vi } from "vitest";
import { Effect, Semaphore } from "effect";

vi.mock("cloudflare:workers", () => ({
  DurableObject: class {},
}));
vi.mock("@cloudflare/containers", () => ({
  Container: class {},
}));

import { MaskirovkaGateway, limitStreamBytes } from "../src/gateway-container";
import { isHtmlNavigation } from "../src/router";
import { ExecutionAuthorizationError } from "../src/execution-grant-repository";

const streamOf = (chunks: readonly string[]): ReadableStream<Uint8Array> =>
  new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(new TextEncoder().encode(chunk));
      }
      controller.close();
    },
  });

const collect = async (stream: ReadableStream<Uint8Array>): Promise<string> => {
  const decoder = new TextDecoder();
  let text = "";
  for await (const chunk of stream) text += decoder.decode(chunk);
  return text;
};

it("forwards without caller routing metadata and records only container response metadata", async () => {
  const append = vi.fn((_metadata: unknown) => Effect.void);
  const containerFetch = vi.fn(
    async (_request: Request) =>
      new Response("ok", {
        headers: {
          "x-maskirovka-model": "resolved-model",
          "x-maskirovka-provider": "codex",
          "x-maskirovka-input-tokens": "12",
          "x-maskirovka-auth-checkpoint": "private-checkpoint",
        },
      }),
  );
  // Substitute infrastructure at the Container boundary; execute the real forwarding method.
  const gateway: MaskirovkaGateway = Object.assign(Object.create(MaskirovkaGateway.prototype), {
    env: {},
    readConfig: () => Effect.succeed({ killed: false }),
    activeProviderAccounts: () => Effect.succeed([{}]),
    ensureContainerReady: () => Effect.void,
    startLock: Semaphore.makeUnsafe(1),
    containerFetch,
    requests: { append },
    window: { read: Effect.succeed(undefined), save: () => Effect.void },
  });
  const response = await gateway.fetchForAccount(
    { organizationId: "org", userId: "user" },
    new Request("https://gateway.test/v1/responses", {
      headers: {
        authorization: "Bearer caller-value",
        "cf-access-jwt-assertion": "caller-assertion",
        "x-maskirovka-model": "forged-model",
        "x-maskirovka-input-tokens": "99999",
        "x-maskirovka-seat": "forged-seat",
        "content-type": "application/json",
      },
    }),
  );
  expect(await response.text()).toBe("ok");
  expect(response.headers.has("x-maskirovka-auth-checkpoint")).toBe(false);
  const forwarded = containerFetch.mock.calls[0]![0];
  for (const name of [
    "authorization",
    "cf-access-jwt-assertion",
    "x-maskirovka-model",
    "x-maskirovka-input-tokens",
    "x-maskirovka-seat",
  ])
    expect(forwarded.headers.has(name), name).toBe(false);
  expect(forwarded.headers.get("x-maskirovka-request-id")).toMatch(/^[0-9a-f-]{36}$/u);
  expect(append).toHaveBeenCalledWith(
    expect.objectContaining({ model: "resolved-model", provider: "codex", inputTokens: 12 }),
  );
  expect(append.mock.calls[0]?.[0]).not.toHaveProperty("seat");
});

it("never decrypts an account without a grant and rechecks revocation after container startup", async () => {
  const decrypt = vi.fn(() => Effect.succeed([{}]));
  const fetch = vi.fn(async () => new Response("ok"));
  const scope = { organizationId: "org", userId: "owner" };
  const session = { session_id: "native", mission_epoch: 1, faction: "OPFOR" };
  let authorized = false;
  let revoked = false;
  const deny = () =>
    Effect.fail(
      new ExecutionAuthorizationError({
        code: "EXECUTION_NOT_AUTHORIZED",
        message: "Not authorized",
      }),
    );
  const gateway: MaskirovkaGateway = Object.assign(Object.create(MaskirovkaGateway.prototype), {
    env: {},
    readConfig: () => Effect.succeed({ killed: false }),
    activeProviderAccounts: decrypt,
    executionGrants: {
      consume: () => (authorized ? Effect.succeed({ scope, grantId: "grant" }) : deny()),
      verifyReserved: () => (revoked ? deny() : Effect.void),
    },
    ensureContainerReady: () =>
      Effect.sync(() => {
        revoked = true;
      }),
    startLock: Semaphore.makeUnsafe(1),
    containerFetch: fetch,
    requests: { append: () => Effect.void },
    window: { read: Effect.succeed(undefined), save: () => Effect.void },
  });
  expect(
    (await gateway.fetchForSession(session, new Request("https://inference.internal/v1/responses")))
      .status,
  ).toBe(403);
  expect(decrypt).not.toHaveBeenCalled();
  authorized = true;
  expect(
    (await gateway.fetchForSession(session, new Request("https://inference.internal/v1/responses")))
      .status,
  ).toBe(403);
  expect(decrypt).toHaveBeenCalledWith(scope);
  expect(fetch).not.toHaveBeenCalled();
});

describe("streamed byte limits", () => {
  it("passes responses below the byte limit through intact", async () => {
    const limited = limitStreamBytes(streamOf(["hello ", "world"]), 64);
    expect(await collect(limited as ReadableStream<Uint8Array>)).toBe("hello world");
  });

  it("errors the stream once the actual byte count exceeds the limit", async () => {
    // Content-Length is not consulted: the real streamed bytes decide.
    const limited = limitStreamBytes(streamOf(["a".repeat(40), "b".repeat(40)]), 64);
    await expect(collect(limited as ReadableStream<Uint8Array>)).rejects.toThrow(/byte limit/u);
  });
});

describe("html navigation detection for SPA fallback", () => {
  it("treats sec-fetch-mode navigate as navigation", () => {
    const request = new Request("https://inference.test/whatever", {
      headers: { "sec-fetch-mode": "navigate" },
    });
    expect(isHtmlNavigation(request, "/whatever")).toBe(true);
  });

  it("never treats asset-like paths or non-HTML accepts as navigation", () => {
    expect(
      isHtmlNavigation(
        new Request("https://inference.test/assets/app.js", {
          headers: { accept: "*/*" },
        }),
        "assets/app.js",
      ),
    ).toBe(false);
    expect(
      isHtmlNavigation(
        new Request("https://inference.test/assets/app.js.map", {
          headers: { accept: "text/html" },
        }),
        "assets/app.js.map",
      ),
    ).toBe(false);
  });

  it("falls back to accept headers when sec-fetch-mode is absent", () => {
    expect(
      isHtmlNavigation(
        new Request("https://inference.test/sessions", { headers: { accept: "text/html" } }),
        "sessions",
      ),
    ).toBe(true);
  });
});
