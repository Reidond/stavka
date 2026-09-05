import { AccountSessionSchema, type AccessIdentity } from "@stavka/access-auth";
import { Data, Effect, Schema } from "effect";
import type { Env } from "./config";
import { hasControlPermission } from "./sim-world-contract";

class SimulationAccessUnavailable extends Data.TaggedError("SimulationAccessUnavailable")<{}> {}

/** Resolve controls from the same verified membership that gates the application. */
export const simulationControlAllowed = (
  identity: AccessIdentity,
  request: Request,
  env: Env,
): Effect.Effect<boolean> => {
  if (identity.serviceToken) return Effect.succeed(false);
  if (env.ENVIRONMENT === "local") return Effect.succeed(hasControlPermission(identity));
  const service = env.INFERENCE_SERVICE;
  if (!service) return Effect.succeed(false);
  const url = new URL("/auth/session", request.url);
  const headers = new Headers();
  const assertion = request.headers.get("cf-access-jwt-assertion");
  if (!assertion) return Effect.succeed(false);
  headers.set("cf-access-jwt-assertion", assertion);
  return Effect.tryPromise({
    try: async (signal) => {
      const response = await service.fetch(new Request(url, { headers, signal }));
      if (!response.ok) throw new SimulationAccessUnavailable();
      return response.json();
    },
    catch: () => new SimulationAccessUnavailable(),
  }).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(AccountSessionSchema)),
    Effect.map(
      (session) =>
        session.status === "active" &&
        (session.membership.role === "owner" || session.membership.role === "admin"),
    ),
    Effect.timeoutOrElse({ duration: "3 seconds", orElse: () => Effect.succeed(false) }),
    Effect.catch(() => Effect.succeed(false)),
  );
};
