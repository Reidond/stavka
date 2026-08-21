import { beforeEach, describe, expect, it, vi } from "vitest";

import type { CredentialVaultEnv } from "../src/durable-objects/credential-vault";

const storage = new Map<string, unknown>();

vi.mock("cloudflare:workers", () => ({
  DurableObject: class {
    readonly ctx: {
      readonly storage: {
        get: <T>(key: string) => Promise<T | undefined>;
        put: (key: string, value: unknown) => Promise<void>;
        delete: (key: string) => Promise<boolean>;
      };
    };
    readonly env: CredentialVaultEnv;

    constructor(_context: unknown, env: CredentialVaultEnv) {
      this.env = env;
      this.ctx = {
        storage: {
          get: async <T>(key: string) => storage.get(key) as T | undefined,
          put: async (key: string, value: unknown) => {
            storage.set(key, value);
          },
          delete: async (key: string) => storage.delete(key),
        },
      };
    }
  },
}));

// 32 raw bytes, base64-encoded.
const validKey = btoa(String.fromCharCode(...Array.from({ length: 32 }, (_, i) => i + 1)));

const fakeState = {
  storage: {
    get: async <T>(key: string) => storage.get(key) as T | undefined,
    put: async (key: string, value: unknown) => {
      storage.set(key, value);
    },
    delete: async (key: string) => storage.delete(key),
  },
} as never as DurableObjectState;

const newVault = async () => {
  const { CredentialVault } = await import("../src/durable-objects/credential-vault");
  const vault = new CredentialVault(fakeState, {
    STAVKA_PROVIDER_CREDENTIALS_KEY: validKey,
  });
  return vault as InstanceType<typeof CredentialVault>;
};

const ownerSub = "ae27d994-4919-5cb1-8d45-c3b776a64c48";
const otherSub = "7335d417-61da-459d-899c-0a01c76a2f94";

describe("provider credential vault", () => {
  beforeEach(() => {
    storage.clear();
  });

  it("roundtrips provider credentials without plaintext at rest", async () => {
    const vault = await newVault();
    await vault.putCredentials(ownerSub, "codex", { access: "token-a", accountId: "acct" });

    expect(await vault.getCredentials(ownerSub, "codex")).toMatchObject({
      provider: "codex",
      payload: { access: "token-a", accountId: "acct" },
    });
    const stored = storage.get(`credentials:${ownerSub}:codex`) as { ciphertext: string };
    expect(stored.ciphertext).not.toContain("token-a");
    expect(JSON.stringify([...storage.values()])).not.toContain("token-a");
  });

  it("isolates each Access subject's credentials", async () => {
    const vault = await newVault();
    await vault.putCredentials(ownerSub, "codex", { access: "owner-token" });
    await vault.putCredentials(otherSub, "codex", { access: "other-token" });

    expect((await vault.getCredentials(ownerSub, "codex"))?.payload).toEqual({
      access: "owner-token",
    });
    expect((await vault.getCredentials(otherSub, "codex"))?.payload).toEqual({
      access: "other-token",
    });
  });

  it("removes credentials on disconnect and reports them missing afterwards", async () => {
    const vault = await newVault();
    await vault.putCredentials(ownerSub, "codex", { access: "token" });
    await vault.clearCredentials(ownerSub, "codex");
    expect(await vault.getCredentials(ownerSub, "codex")).toBeUndefined();
  });

  it("tracks pending device authorization and clears it when credentials land", async () => {
    const vault = await newVault();
    await vault.setPending(ownerSub, "codex", {
      deviceAuthId: "device",
      userCode: "CODE-CODE",
      intervalSeconds: 5,
      verificationUri: "https://auth.openai.com/codex/device",
      createdAt: 1,
    });
    expect(await vault.getPending(ownerSub, "codex")).toMatchObject({ deviceAuthId: "device" });

    await vault.putCredentials(ownerSub, "codex", { access: "token" });
    expect(await vault.getPending(ownerSub, "codex")).toBeUndefined();
  });

  it("rejects unvalidated subjects and providers", async () => {
    const vault = await newVault();
    await expect(vault.putCredentials("", "codex", {})).rejects.toThrow(/subject/u);
    await expect(vault.putCredentials(`${ownerSub}/evil`, "codex", {})).rejects.toThrow(/subject/u);
    await expect(vault.putCredentials(ownerSub, "BAD_PROVIDER", {})).rejects.toThrow(/provider/u);
  });

  it("refuses weak or malformed encryption keys before touching state", async () => {
    const { CredentialVault, VaultKeyError } =
      await import("../src/durable-objects/credential-vault");
    const vault = new CredentialVault(
      fakeState,
      { STAVKA_PROVIDER_CREDENTIALS_KEY: btoa("too-short") },
    );
    await expect(vault.putCredentials(ownerSub, "codex", {})).rejects.toBeInstanceOf(VaultKeyError);
    expect(storage.size).toBe(0);
  });
});
