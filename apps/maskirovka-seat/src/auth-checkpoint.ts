import { Effect, Schema } from "effect";
import { ProviderCredentialSchema, type ProviderCredential } from "@stavka/provider-auth";

import { decodeBase64Url, encodeBase64Url } from "./base64";
import type { SeatProvider } from "./config";

export const AUTH_CHECKPOINT_HEADER = "x-maskirovka-auth-checkpoint";
export const AUTH_STATE_FINGERPRINT_HEADER = "x-maskirovka-auth-state-fingerprint";
const MAX_CHECKPOINT_HEADER_BYTES = 16_384;
const SHA256_HEX = /^[a-f0-9]{64}$/;

const AuthCheckpointSchema = Schema.Struct({
  version: Schema.Literal(2),
  provider: Schema.Literals(["claude", "codex"]),
  credential: ProviderCredentialSchema,
  base_fingerprint: Schema.String,
  observed_at: Schema.Number,
});

export interface AuthCheckpoint {
  readonly version: 2;
  readonly provider: SeatProvider;
  readonly credential: ProviderCredential;
  readonly base_fingerprint: string;
  readonly observed_at: number;
}

const decodeCheckpoint = Schema.decodeUnknownSync(AuthCheckpointSchema);

export const encodeAuthCheckpoint = (checkpoint: AuthCheckpoint): string =>
  encodeBase64Url(JSON.stringify(checkpoint));

export const authTokenFingerprint = (token: string): Effect.Effect<string> =>
  Effect.promise(async () => {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
    return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join(
      "",
    );
  });

export const decodeAuthCheckpoint = (header: string): AuthCheckpoint => {
  if (header.length > MAX_CHECKPOINT_HEADER_BYTES)
    throw new Error("Auth checkpoint header is too large");
  const decoded = decodeCheckpoint(JSON.parse(decodeBase64Url(header)) as unknown);
  if (!SHA256_HEX.test(decoded.base_fingerprint)) {
    throw new Error("Auth checkpoint base fingerprint is invalid");
  }
  if (!Number.isFinite(decoded.observed_at) || decoded.observed_at <= 0) {
    throw new Error("Auth checkpoint timestamp is invalid");
  }
  return decoded;
};
