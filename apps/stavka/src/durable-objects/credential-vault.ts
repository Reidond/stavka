import { DurableObject } from "cloudflare:workers";

/**
 * Shared encrypted provider credential vault.
 *
 * Replaces the standalone Warbench vault. State is keyed by the validated
 * Cloudflare Access `sub`, so one Durable Object instance can serve every
 * user while each user's credentials stay isolated. The encryption key is
 * provisioned as STAVKA_PROVIDER_CREDENTIALS_KEY and must be generated
 * afresh; no Warbench-era key is reused.
 */

export interface CredentialVaultEnv {
  readonly STAVKA_PROVIDER_CREDENTIALS_KEY: string;
}

export interface StoredProviderCredentials<P = unknown> {
  readonly provider: string;
  /** Provider-specific credential payload (for example Pi Codex OAuth tokens). */
  readonly payload: P;
  readonly updatedAt: string;
}

export interface PendingDeviceAuth {
  readonly deviceAuthId: string;
  readonly userCode: string;
  readonly intervalSeconds: number;
  readonly verificationUri: string;
  readonly createdAt: number;
}

interface EncryptedValue {
  readonly iv: string;
  readonly ciphertext: string;
}

export class VaultKeyError extends Error {
  constructor() {
    super("STAVKA_PROVIDER_CREDENTIALS_KEY must be a base64-encoded 32-byte AES-256 key", {
      cause: "misconfigured",
    });
    this.name = "VaultKeyError";
  }
}

const bytesToBase64 = (bytes: Uint8Array): string => {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
};

const base64ToBytes = (value: string): Uint8Array => {
  const binary = atob(value);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
};

const toArrayBuffer = (bytes: Uint8Array): ArrayBuffer => {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
};

const importAesKey = async (encoded: string): Promise<CryptoKey> => {
  let raw: Uint8Array;
  try {
    raw = base64ToBytes(encoded);
  } catch {
    throw new VaultKeyError();
  }
  if (raw.byteLength !== 32) throw new VaultKeyError();
  return crypto.subtle.importKey("raw", toArrayBuffer(raw), "AES-GCM", false, [
    "encrypt",
    "decrypt",
  ]);
};

const encryptJson = async (keyMaterial: string, value: unknown): Promise<EncryptedValue> => {
  const key = await importAesKey(keyMaterial);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const plaintext = new TextEncoder().encode(JSON.stringify(value));
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: toArrayBuffer(iv) },
    key,
    toArrayBuffer(plaintext),
  );
  return {
    iv: bytesToBase64(iv),
    ciphertext: bytesToBase64(new Uint8Array(ciphertext)),
  };
};

const decryptJson = async <T>(keyMaterial: string, encoded: EncryptedValue): Promise<T> => {
  const key = await importAesKey(keyMaterial);
  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: toArrayBuffer(base64ToBytes(encoded.iv)) },
    key,
    toArrayBuffer(base64ToBytes(encoded.ciphertext)),
  );
  return JSON.parse(new TextDecoder().decode(plaintext)) as T;
};

const assertSubject = (subject: string): void => {
  if (!/^[0-9a-zA-Z:@._-]{1,128}$/u.test(subject)) {
    throw new Error("credential vault subject must be a validated identity");
  }
};

export class CredentialVault extends DurableObject<CredentialVaultEnv> {
  private readonly credentialsKey = (): string => this.env.STAVKA_PROVIDER_CREDENTIALS_KEY;

  async putCredentials<P>(subject: string, provider: string, payload: P): Promise<void> {
    assertSubject(subject);
    if (!/^[a-z0-9-]{1,32}$/u.test(provider)) {
      throw new Error("credential vault provider id is invalid");
    }
    const encrypted = await encryptJson(this.credentialsKey(), {
      provider,
      payload,
      updatedAt: new Date().toISOString(),
    } satisfies StoredProviderCredentials<P>);
    await this.ctx.storage.put(`credentials:${subject}:${provider}`, encrypted);
    await this.clearPending(subject, provider);
  }

  async getCredentials<P>(
    subject: string,
    provider: string,
  ): Promise<StoredProviderCredentials<P> | undefined> {
    assertSubject(subject);
    const encoded = await this.ctx.storage.get<EncryptedValue>(
      `credentials:${subject}:${provider}`,
    );
    if (!encoded) return undefined;
    return decryptJson<StoredProviderCredentials<P>>(this.credentialsKey(), encoded);
  }

  /** Disconnect removes the stored credential entirely. */
  async clearCredentials(subject: string, provider: string): Promise<void> {
    assertSubject(subject);
    await this.ctx.storage.delete(`credentials:${subject}:${provider}`);
  }

  async setPending<P>(
    subject: string,
    provider: string,
    value: PendingDeviceAuth & P,
  ): Promise<void> {
    assertSubject(subject);
    await this.ctx.storage.put(`pending:${subject}:${provider}`, value);
  }

  async getPending<P = unknown>(
    subject: string,
    provider: string,
  ): Promise<(PendingDeviceAuth & P) | undefined> {
    assertSubject(subject);
    return this.ctx.storage.get<PendingDeviceAuth & P>(`pending:${subject}:${provider}`);
  }

  async clearPending(subject: string, provider: string): Promise<void> {
    assertSubject(subject);
    await this.ctx.storage.delete(`pending:${subject}:${provider}`);
  }
}
