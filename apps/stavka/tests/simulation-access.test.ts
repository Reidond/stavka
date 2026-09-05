import { Effect } from "effect";
import { describe, expect, it, vi } from "vitest";
import { simulationControlAllowed } from "../src/simulation-access";
import type { Env } from "../src/config";
import type { AccessIdentity } from "@stavka/access-auth";

const identity: AccessIdentity = {
  subject: "verified-human",
  role: "spectator",
  serviceToken: false,
  claims: {},
};
const request = new Request("https://app.test/agents/sim-world/example", {
  headers: {
    "cf-access-jwt-assertion": "verified-assertion",
    authorization: "Bearer machine-token",
  },
});
const session = (role: string) => ({
  status: "active",
  user: { id: "u1", displayName: "Operator", createdAt: 1, updatedAt: 1 },
  organization: { id: "o1", slug: "workspace", name: "Workspace", createdAt: 1, updatedAt: 1 },
  membership: { organizationId: "o1", userId: "u1", role, joinedAt: 1 },
});
const envWith = (fetch: typeof globalThis.fetch) =>
  ({ ENVIRONMENT: "production", INFERENCE_SERVICE: { fetch } }) as unknown as Env;

describe("simulation membership authorization", () => {
  it.each(["owner", "admin"])(
    "allows a verified %s using the private account service",
    async (role) => {
      const fetch = vi.fn(async (raw: RequestInfo | URL) => {
        const forwarded = raw as Request;
        expect(forwarded.url).toBe("https://app.test/auth/session");
        expect(forwarded.method).toBe("GET");
        expect(forwarded.headers.get("cf-access-jwt-assertion")).toBe("verified-assertion");
        expect(forwarded.headers.has("authorization")).toBe(false);
        return Response.json(session(role));
      });
      expect(
        await Effect.runPromise(simulationControlAllowed(identity, request, envWith(fetch))),
      ).toBe(true);
    },
  );
  it.each([
    session("member"),
    {},
    { status: "setup_required", identity: { accessRole: "spectator" }, canSignUp: false },
  ])("fails closed for unprivileged or invalid sessions", async (body) => {
    expect(
      await Effect.runPromise(
        simulationControlAllowed(
          identity,
          request,
          envWith(async () => Response.json(body)),
        ),
      ),
    ).toBe(false);
  });
  it("never promotes a machine credential through workspace membership", async () => {
    const fetch = vi.fn(async () => Response.json(session("owner")));
    expect(
      await Effect.runPromise(
        simulationControlAllowed({ ...identity, serviceToken: true }, request, envWith(fetch)),
      ),
    ).toBe(false);
    expect(fetch).not.toHaveBeenCalled();
  });
  it("fails closed when the account service rejects or is unavailable", async () => {
    for (const fetch of [
      async () => new Response(null, { status: 403 }),
      async () => {
        throw new Error("offline");
      },
    ]) {
      expect(
        await Effect.runPromise(simulationControlAllowed(identity, request, envWith(fetch))),
      ).toBe(false);
    }
  });
});
