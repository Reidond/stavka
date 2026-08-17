import { describe, expect, it, vi } from "vitest";
import type { CodexCredentials } from "./codex-auth";
import { migrateLegacyOwnerState, type CredentialVault } from "./owner-state";

const legacyCredentials: CodexCredentials = {
  access: "legacy-access",
  refresh: "legacy-refresh",
  expires: 1_800_000_000_000,
  accountId: "chatgpt-account",
};

const vault = (
  credentials: CodexCredentials | undefined,
  migrationComplete = false,
): CredentialVault & { credentials?: CodexCredentials; migrationComplete: boolean } => {
  const state = {
    credentials,
    migrationComplete,
    clearOAuthState: vi.fn(async () => {
      state.credentials = undefined;
    }),
    getCredentials: vi.fn(async () => state.credentials),
    isLegacyOwnerMigrationComplete: vi.fn(async () => state.migrationComplete),
    markLegacyOwnerMigrationComplete: vi.fn(async () => {
      state.migrationComplete = true;
    }),
    putCredentials: vi.fn(async (next: CodexCredentials) => {
      state.credentials = next;
    }),
  };
  return state;
};

describe("legacy owner-state migration", () => {
  it("copies credentials before clearing the legacy vault and evidence", async () => {
    const scopedVault = vault(undefined);
    const legacyVault = vault(legacyCredentials);
    const legacyResults = { clear: vi.fn(async () => undefined) };

    await expect(
      migrateLegacyOwnerState({ legacyResults, legacyVault, scopedVault }),
    ).resolves.toEqual({
      completed: true,
      credentialsMigrated: true,
      performed: true,
    });

    expect(scopedVault.credentials).toEqual(legacyCredentials);
    expect(legacyVault.credentials).toBeUndefined();
    expect(legacyResults.clear).toHaveBeenCalledOnce();
    expect(scopedVault.migrationComplete).toBe(true);
  });

  it("keeps existing scoped credentials and remains idempotent", async () => {
    const scopedCredentials = { ...legacyCredentials, refresh: "new-refresh" };
    const scopedVault = vault(scopedCredentials);
    const legacyVault = vault(legacyCredentials);
    const legacyResults = { clear: vi.fn(async () => undefined) };

    await migrateLegacyOwnerState({ legacyResults, legacyVault, scopedVault });
    await expect(
      migrateLegacyOwnerState({ legacyResults, legacyVault, scopedVault }),
    ).resolves.toEqual({
      completed: true,
      credentialsMigrated: false,
      performed: false,
    });

    expect(scopedVault.credentials).toEqual(scopedCredentials);
    expect(scopedVault.putCredentials).not.toHaveBeenCalled();
    expect(legacyResults.clear).toHaveBeenCalledOnce();
  });

  it("does not clear legacy state when the destination copy cannot be verified", async () => {
    const scopedVault = vault(undefined);
    scopedVault.putCredentials = vi.fn(async () => undefined);
    const legacyVault = vault(legacyCredentials);
    const legacyResults = { clear: vi.fn(async () => undefined) };

    await expect(
      migrateLegacyOwnerState({ legacyResults, legacyVault, scopedVault }),
    ).rejects.toThrow("could not be verified");

    expect(legacyVault.credentials).toEqual(legacyCredentials);
    expect(legacyVault.clearOAuthState).not.toHaveBeenCalled();
    expect(legacyResults.clear).not.toHaveBeenCalled();
    expect(scopedVault.migrationComplete).toBe(false);
  });
});
