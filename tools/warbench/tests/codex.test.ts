import { chmod, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Effect } from "effect";
import { afterEach, describe, expect, it } from "vitest";

import { readCodexCredentials, writeCodexCredentials } from "../src/codex";

const roots: string[] = [];

const newDataDir = async (): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), "warbench-codex-"));
  roots.push(root);
  return join(root, "private-data");
};

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const credentials = {
  kind: "codex-chatgpt-oauth",
  accessToken: "local-access-token",
  refreshToken: "local-refresh-token",
  expiresAt: 123_456,
  accountId: "account-local",
} as const;

const permissionBits = async (path: string): Promise<number> => (await stat(path)).mode & 0o777;

describe("operator-local Codex credentials", () => {
  it("creates the data directory and credential file with owner-only permissions", async () => {
    const dataDir = await newDataDir();

    await Effect.runPromise(writeCodexCredentials(dataDir, credentials));

    expect(await permissionBits(dataDir)).toBe(0o700);
    expect(await permissionBits(join(dataDir, "profiles.json"))).toBe(0o600);
    await expect(Effect.runPromise(readCodexCredentials(dataDir))).resolves.toEqual(credentials);
  });

  it("repairs permissive permissions before refreshing credential contents", async () => {
    const dataDir = await newDataDir();
    const path = join(dataDir, "profiles.json");
    await Effect.runPromise(writeCodexCredentials(dataDir, credentials));
    await chmod(dataDir, 0o755);
    await chmod(path, 0o644);

    await Effect.runPromise(
      writeCodexCredentials(dataDir, {
        ...credentials,
        accessToken: "refreshed-local-access-token",
      }),
    );

    expect(await permissionBits(dataDir)).toBe(0o700);
    expect(await permissionBits(path)).toBe(0o600);
  });
});
