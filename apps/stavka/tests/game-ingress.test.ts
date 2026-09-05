import { describe, expect, it, vi } from "vitest";
import type { Env } from "../src/config";

vi.mock("agents", () => ({
  Agent: class {},
  callable: () => (target: unknown) => target,
  getCurrentAgent: () => ({}),
  routeAgentRequest: vi.fn(),
}));
vi.mock("cloudflare:workers", () => ({ DurableObject: class {} }));
vi.mock("@tanstack/react-start/server-entry", () => ({ default: { fetch: vi.fn() } }));

const { handleRequest } = await import("../src/server");

const env = (fetch: Fetcher["fetch"], overrides: Partial<Env> = {}): Env => ({
  SIM_WORLD: {} as Env["SIM_WORLD"],
  WAR_BENCH_STUDY_STORE: {} as Env["WAR_BENCH_STUDY_STORE"],
  ENVIRONMENT: "local",
  DEV_ACCESS_EMAIL: "qa@localhost",
  COMMANDER_API_KEY: "machine-test-key",
  COMMANDER_SERVICE: { fetch, connect: vi.fn() },
  ...overrides,
});

describe("game server ingress", () => {
  it.each(["connect", "tick", "map", "disconnect"])(
    "preserves %s bytes, epoch, bearer and private service errors",
    async (route) => {
      const fetch = vi.fn<Fetcher["fetch"]>(
        async () =>
          new Response('{"error":{"code":"STALE_EPOCH"}}', {
            status: 409,
            headers: { "content-type": "application/json", "x-request-id": "private-receipt" },
          }),
      );
      // Validation belongs to Commander. The ingress must not decode/re-encode,
      // consume the stream, or suppress its protocol error response.
      const body = '{ "protocol_version": 1, "tick_id": 42 }';
      const response = await handleRequest(
        new Request(`http://127.0.0.1/api/${route}`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: "Bearer machine-test-key",
            "x-stavka-mission-epoch": "7",
            "cf-access-client-secret": "edge-only-secret",
          },
          body,
        }),
        env(fetch),
      );
      expect(response.status).toBe(409);
      expect(response.headers.get("x-request-id")).toBe("private-receipt");
      const forwarded = fetch.mock.calls[0]?.[0] as Request;
      expect(await forwarded.text()).toBe(body);
      expect(forwarded.headers.get("authorization")).toBe("Bearer machine-test-key");
      expect(forwarded.headers.get("x-stavka-mission-epoch")).toBe("7");
      expect(forwarded.headers.has("cf-access-client-secret")).toBe(false);
    },
  );

  it.each([undefined, "Bearer wrong"])(
    "rejects missing or invalid machine authorization: %s",
    async (authorization) => {
      const fetch = vi.fn<Fetcher["fetch"]>();
      const response = await handleRequest(
        new Request("http://127.0.0.1/api/tick", {
          method: "POST",
          headers: authorization ? { authorization } : {},
          body: "{}",
        }),
        env(fetch),
      );
      expect(response.status).toBe(401);
      expect(fetch).not.toHaveBeenCalled();
    },
  );

  it("requires Access even with the correct machine key", async () => {
    const fetch = vi.fn<Fetcher["fetch"]>();
    const response = await handleRequest(
      new Request("https://stavka.sands.red/api/connect", {
        method: "POST",
        headers: { authorization: "Bearer machine-test-key" },
        body: "{}",
      }),
      env(fetch, { ENVIRONMENT: "production" }),
    );
    expect(response.status).toBe(401);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("returns 503 when the private binding fails", async () => {
    const fetch = vi.fn<Fetcher["fetch"]>().mockRejectedValue(new Error("binding unavailable"));
    const response = await handleRequest(
      new Request("http://127.0.0.1/api/tick", {
        method: "POST",
        headers: { authorization: "Bearer machine-test-key" },
        body: "{}",
      }),
      env(fetch),
    );
    expect(response.status).toBe(503);
    expect(response.headers.get("cache-control")).toBe("no-store");
  });
});
