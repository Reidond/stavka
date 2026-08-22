import { readFileSync, readdirSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const appRoot = fileURLToPath(new URL("..", import.meta.url));
const sourceRoot = resolve(appRoot, "src");

const sourceFiles = (directory: string): string[] =>
  readdirSync(directory)
    .flatMap((entry) => {
      const path = resolve(directory, entry);
      return statSync(path).isDirectory() ? sourceFiles(path) : [path];
    })
    .filter((path) => path.endsWith(".ts") || path.endsWith(".tsx"));

describe("hosted gateway architecture boundaries", () => {
  it("keeps raw SQL inside repository modules", () => {
    const violations = sourceFiles(sourceRoot)
      .filter((path) => !path.endsWith("repository.ts"))
      .filter((path) =>
        /(?:CREATE|SELECT|INSERT|UPDATE|DELETE)\s+(?:TABLE|FROM|INTO|SET)/iu.test(
          readFileSync(path, "utf8"),
        ),
      );
    expect(violations).toEqual([]);
  });

  it("uses Effect HttpApi contracts without Hono or pathname dispatch", () => {
    const contract = readFileSync(resolve(sourceRoot, "http-contract.ts"), "utf8");
    const worker = readFileSync(resolve(sourceRoot, "router.ts"), "utf8");
    const container = readFileSync(resolve(sourceRoot, "gateway-container.ts"), "utf8");
    const sources = `${contract}\n${worker}\n${container}`;

    expect(contract).toContain("HttpApiGroup.make");
    expect(contract).toContain('HttpApiEndpoint.put("putAuth"');
    expect(contract).toContain('HttpApiEndpoint.delete("deleteAuth"');
    expect(worker).toContain("HttpApiBuilder.group");
    expect(worker).toContain("HttpRouter.toWebHandler");
    expect(sources).not.toMatch(/pathname\s*===|switch\s*\([^)]*pathname|from\s+["']hono["']/u);
  });

  it("exposes repository operations as Effects without Promise returns", () => {
    for (const filename of [
      "auth-state-repository.ts",
      "gateway-config-repository.ts",
      "request-metadata-repository.ts",
      "window-tracker-repository.ts",
    ]) {
      const repository = readFileSync(resolve(sourceRoot, filename), "utf8");
      expect(repository).toContain("Effect.Effect");
      expect(repository).not.toContain("Promise<");
    }
  });

  it("never returns raw auth tokens from admin metadata helpers", () => {
    const container = readFileSync(resolve(sourceRoot, "gateway-container.ts"), "utf8");
    const dashboard = readFileSync(resolve(sourceRoot, "dashboard/src.tsx"), "utf8");
    const metadataStart = container.indexOf("const metadataFromAuth");
    const metadataEnd = container.indexOf("const emptyMetadata");
    const metadataHelpers = container.slice(metadataStart, metadataEnd);

    expect(metadataHelpers).toContain("configured: true");
    expect(metadataHelpers).not.toMatch(/\btoken\b/u);
    expect(dashboard).toContain("never shown");
    expect(dashboard).not.toMatch(/status\.token|auth\.token|response\.token/u);
  });

  it("declares scale-to-zero, container reconnect, and dual-provider auth injection", () => {
    const source = readFileSync(resolve(sourceRoot, "gateway-container.ts"), "utf8");
    expect(source).toContain("sleepAfter");
    expect(source).toContain("startAndWaitForPorts");
    expect(source).toContain("MASKIROVKA_AUTH_STATE_B64");
    expect(source).toContain("putAuth");
    expect(source).toContain("deleteAuth");
  });

  it("runs the image as a non-root user and never bakes provider credentials", () => {
    const dockerfile = readFileSync(resolve(appRoot, "Dockerfile"), "utf8");
    expect(dockerfile).toContain("USER maskirovka");
    expect(dockerfile).toContain("@anthropic-ai/claude-code");
    expect(dockerfile).toContain("@openai/codex");
    expect(dockerfile).not.toMatch(/(?:sk-|oauth)[A-Za-z0-9_-]{12,}/u);
  });

  it("keeps package scripts free of shell control operators", () => {
    const packageJson = JSON.parse(readFileSync(resolve(appRoot, "package.json"), "utf8")) as {
      scripts: Record<string, string>;
    };
    for (const [name, script] of Object.entries(packageJson.scripts)) {
      expect(script, name).not.toMatch(/&&|\|\|/u);
    }
  });
});
