import { Effect } from "effect";

type TimingSafeSubtleCrypto = SubtleCrypto & {
  timingSafeEqual(left: ArrayBufferView, right: ArrayBufferView): boolean;
};

const hasTimingSafeEqual = (subtle: SubtleCrypto): subtle is TimingSafeSubtleCrypto =>
  "timingSafeEqual" in subtle && typeof subtle.timingSafeEqual === "function";

const fixedTimeEqual = (left: Uint8Array, right: Uint8Array): boolean => {
  let difference = 0;
  for (let index = 0; index < left.byteLength; index += 1) {
    difference |= (left[index] ?? 0) ^ (right[index] ?? 0);
  }
  return difference === 0;
};

/** Compare fixed-size digests so malformed credentials do not reveal key length. */
export const authorizeMachineCredential = (
  supplied: string,
  secret: string,
): Effect.Effect<boolean> =>
  Effect.promise(async () => {
    const encoder = new TextEncoder();
    const [suppliedDigest, expectedDigest] = await Promise.all([
      crypto.subtle.digest("SHA-256", encoder.encode(supplied)),
      crypto.subtle.digest("SHA-256", encoder.encode(secret)),
    ]);
    const left = new Uint8Array(suppliedDigest);
    const right = new Uint8Array(expectedDigest);
    return hasTimingSafeEqual(crypto.subtle)
      ? crypto.subtle.timingSafeEqual(left, right)
      : fixedTimeEqual(left, right);
  });
