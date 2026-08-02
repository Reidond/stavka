import { Data, Effect } from "effect";

const encoder = new TextEncoder();
const comparisonMessage = encoder.encode("stavka-machine-auth-v1");

export class MachineAuthError extends Data.TaggedError("MachineAuthError")<{
  readonly reason: "crypto";
  readonly message: string;
  readonly cause: unknown;
}> {}

export const readBearerToken = (request: Request): string | undefined => {
  const header = request.headers.get("authorization");
  if (!header?.startsWith("Bearer ")) return undefined;
  const token = header.slice(7);
  return token.length > 0 ? token : undefined;
};

/** Compare secrets through HMAC verification so length and byte mismatches share one path. */
export const constantTimeEqual = (
  provided: string,
  expected: string,
): Effect.Effect<boolean, MachineAuthError> => {
  if (provided.length === 0 || expected.length === 0) return Effect.succeed(false);
  const algorithm = { name: "HMAC", hash: "SHA-256" } as const;
  return Effect.tryPromise({
    try: async () => {
      const [expectedKey, providedKey] = await Promise.all([
        crypto.subtle.importKey("raw", encoder.encode(expected), algorithm, false, ["sign"]),
        crypto.subtle.importKey("raw", encoder.encode(provided), algorithm, false, ["verify"]),
      ]);
      const signature = await crypto.subtle.sign(algorithm, expectedKey, comparisonMessage);
      return crypto.subtle.verify(algorithm, providedKey, signature, comparisonMessage);
    },
    catch: (cause) =>
      new MachineAuthError({
        reason: "crypto",
        message: "Unable to verify the machine bearer token",
        cause,
      }),
  });
};

export const authorizeMachine = (
  request: Request,
  expected: string,
): Effect.Effect<boolean, MachineAuthError> => {
  const provided = readBearerToken(request);
  return provided === undefined ? Effect.succeed(false) : constantTimeEqual(provided, expected);
};
