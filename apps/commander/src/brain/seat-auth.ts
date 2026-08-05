import { authorizeMachine } from "@stavka/access-auth";
import { Effect } from "effect";

import { readConfigEffect, type Env } from "../config";

export interface SeatCredentialPrincipal {
  /** `*` is the operator bootstrap token; any other value is a revocable seat id. */
  readonly seatId: "*" | string;
}

/** Check every configured credential so matching-seat position is not observable. */
export const authorizeSeatRequest = (
  request: Request,
  env: Env,
): Effect.Effect<SeatCredentialPrincipal | undefined> =>
  readConfigEffect(env).pipe(
    Effect.flatMap((config) => {
      const credentials = [
        ...(env.SEAT_REGISTRATION_TOKEN ? [{ seatId: "*", key: env.SEAT_REGISTRATION_TOKEN }] : []),
        ...Object.entries(config.seatKeys).map(([seatId, key]) => ({ seatId, key })),
      ];
      return Effect.forEach(credentials, ({ key, seatId }) =>
        authorizeMachine(request, key).pipe(
          Effect.map((authorized) => ({ authorized, seatId })),
          Effect.catch(() => Effect.succeed({ authorized: false, seatId })),
        ),
      ).pipe(
        Effect.map((results) => {
          const match = results.find((result) => result.authorized);
          return match === undefined ? undefined : { seatId: match.seatId };
        }),
      );
    }),
    Effect.catch(() => Effect.succeed(undefined)),
  );
