import type { CodexCredentials } from "./codex-auth";

export interface CredentialVault {
  clearOAuthState(): Promise<void>;
  getCredentials(): Promise<CodexCredentials | undefined>;
  isLegacyOwnerMigrationComplete(): Promise<boolean>;
  markLegacyOwnerMigrationComplete(): Promise<void>;
  putCredentials(credentials: CodexCredentials): Promise<void>;
}

export interface ClearableResultsStore {
  clear(): Promise<void>;
}

export interface LegacyMigrationResult {
  readonly completed: true;
  readonly credentialsMigrated: boolean;
  readonly performed: boolean;
}

export const migrateLegacyOwnerState = async ({
  legacyResults,
  legacyVault,
  scopedVault,
}: {
  readonly legacyResults: ClearableResultsStore;
  readonly legacyVault: CredentialVault;
  readonly scopedVault: CredentialVault;
}): Promise<LegacyMigrationResult> => {
  if (await scopedVault.isLegacyOwnerMigrationComplete()) {
    return { completed: true, credentialsMigrated: false, performed: false };
  }

  let credentialsMigrated = false;
  let scopedCredentials = await scopedVault.getCredentials();
  if (!scopedCredentials) {
    const legacyCredentials = await legacyVault.getCredentials();
    if (legacyCredentials) {
      await scopedVault.putCredentials(legacyCredentials);
      scopedCredentials = await scopedVault.getCredentials();
      if (!scopedCredentials) {
        throw new Error("Legacy credential migration could not be verified");
      }
      credentialsMigrated = true;
    }
  }

  await legacyVault.clearOAuthState();
  await legacyResults.clear();
  await scopedVault.markLegacyOwnerMigrationComplete();

  return { completed: true, credentialsMigrated, performed: true };
};
