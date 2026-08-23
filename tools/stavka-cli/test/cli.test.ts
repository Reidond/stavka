import { Effect } from "effect";
import { describe, expect, it, vi } from "vitest";

import { runCli } from "../src/cli";

describe("stavka provider CLI", () => {
  it("documents secret-safe named account and Cloudflare profile commands", async () => {
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    try {
      await Effect.runPromise(runCli(["--", "help"]));
      const output = write.mock.calls.map(([value]) => String(value)).join("");
      expect(output).toContain("stavka codex login <name>");
      expect(output).toContain("stavka cloudflare login <name>");
      expect(output).toContain("stavka cloudflare local <name>");
      expect(output).toContain("stavka auth activate --account <provider/name>");
      expect(output).toContain("--client-secret-stdin");
      expect(output).toContain("never pass them as arguments");
    } finally {
      write.mockRestore();
    }
  });
});
