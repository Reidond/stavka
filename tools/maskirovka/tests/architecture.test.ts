import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const source = (relative: string): string =>
  readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8");

describe("Maskirovka architecture boundaries", () => {
  it("defines routes contract-first with Effect HttpApi", () => {
    const router = source("../src/router.ts");
    expect(router).toContain("HttpApi.make");
    expect(router).toContain("HttpApiGroup.make");
    expect(router).toContain("HttpApiEndpoint.");
    expect(router).toContain("HttpApiBuilder.group");
    expect(router).not.toMatch(/from ["']hono/u);
    expect(router).not.toContain(".pathname");
    expect(router).not.toMatch(/switch\s*\([^)]*(?:url|path)/u);
  });

  it("keeps filesystem and process primitives in repositories or entrypoint adapters", () => {
    for (const filename of [
      "../src/services/gateway-service.ts",
      "../src/services/seat-registry.ts",
      "../src/services/doctor-service.ts",
      "../src/router.ts",
    ]) {
      expect(source(filename)).not.toMatch(/node:(?:fs|child_process)/u);
    }
  });

  it("runs Effect only at application and test boundaries", () => {
    for (const filename of [
      "../src/services/gateway-service.ts",
      "../src/services/seat-registry.ts",
      "../src/services/doctor-service.ts",
      "../src/router.ts",
      "../src/runtime.ts",
    ]) {
      expect(source(filename)).not.toContain("Effect.runPromise");
    }
  });
});
