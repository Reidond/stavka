import { Effect } from "effect";
import { LocalProfileStore } from "@stavka/provider-auth/node";
import { describe, expect, it, vi } from "vitest";

import { runCli } from "../src/cli";

describe("stavka provider CLI", () => {
  it("rejects retired local profiles before sending an HTTP request", async () => {
    const profile = vi.spyOn(LocalProfileStore.prototype, "cloudflareProfile").mockReturnValue(
      Effect.succeed({
        name: "development",
        label: "Old local profile",
        url: "http://127.0.0.1:5173",
        auth: { kind: "local" },
        createdAt: "2026-09-05T00:00:00Z",
        updatedAt: "2026-09-05T00:00:00Z",
      }),
    );
    const request = vi.spyOn(globalThis, "fetch");
    try {
      await expect(
        Effect.runPromise(runCli(["auth", "list", "--cloudflare", "development"])),
      ).rejects.toThrow("Local profiles are no longer supported");
      expect(request).not.toHaveBeenCalled();
    } finally {
      profile.mockRestore();
      request.mockRestore();
    }
  });

  it("rejects the removed local profile creation command", async () => {
    await expect(
      Effect.runPromise(
        runCli(["cloudflare", "local", "development", "--url", "http://127.0.0.1:5173"]),
      ),
    ).rejects.toThrow("Unknown command");
  });

  it("documents secret-safe named account and Cloudflare profile commands", async () => {
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    try {
      await Effect.runPromise(runCli(["--", "help"]));
      const output = write.mock.calls.map(([value]) => String(value)).join("");
      expect(output).toContain("stavka codex login <name>");
      expect(output).toContain("stavka cloudflare login <name>");
      expect(output).not.toContain("stavka cloudflare local");
      expect(output).toContain("stavka auth activate --account <provider/name>");
      expect(output).toContain("--client-secret-stdin");
      expect(output).toContain("never pass them as arguments");
    } finally {
      write.mockRestore();
    }
  });
});
