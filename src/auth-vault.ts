import { DurableObject } from "cloudflare:workers";
import type { CodexCredentials } from "./codex-auth";

export interface Env {
  readonly AUTH_VAULT: DurableObjectNamespace<AuthVault>;
  readonly WAR_BENCH_ENCRYPTION_KEY: string;
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

const importKey = (encoded: string) =>
  crypto.subtle.importKey("raw", toArrayBuffer(base64ToBytes(encoded)), "AES-GCM", false, [
    "encrypt",
    "decrypt",
  ]);

export class AuthVault extends DurableObject<Env> {
  async setPending(value: PendingDeviceAuth): Promise<void> {
    await this.ctx.storage.put("codex:pending", value);
  }

  async getPending(): Promise<PendingDeviceAuth | undefined> {
    return this.ctx.storage.get<PendingDeviceAuth>("codex:pending");
  }

  async clearPending(): Promise<void> {
    await this.ctx.storage.delete("codex:pending");
  }

  async putCredentials(credentials: CodexCredentials): Promise<void> {
    const key = await importKey(this.env.WAR_BENCH_ENCRYPTION_KEY);
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const plaintext = new TextEncoder().encode(JSON.stringify(credentials));
    const ciphertext = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv: toArrayBuffer(iv) },
      key,
      toArrayBuffer(plaintext),
    );
    const encoded: EncryptedValue = {
      iv: bytesToBase64(iv),
      ciphertext: bytesToBase64(new Uint8Array(ciphertext)),
    };
    await this.ctx.storage.put("codex:credentials", encoded);
    await this.clearPending();
  }

  async getCredentials(): Promise<CodexCredentials | undefined> {
    const encoded = await this.ctx.storage.get<EncryptedValue>("codex:credentials");
    if (!encoded) return undefined;
    const key = await importKey(this.env.WAR_BENCH_ENCRYPTION_KEY);
    const plaintext = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: toArrayBuffer(base64ToBytes(encoded.iv)) },
      key,
      toArrayBuffer(base64ToBytes(encoded.ciphertext)),
    );
    return JSON.parse(new TextDecoder().decode(plaintext)) as CodexCredentials;
  }

  async clearCredentials(): Promise<void> {
    await this.ctx.storage.delete("codex:credentials");
  }
}
