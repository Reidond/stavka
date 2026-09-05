import { readFileSync, readdirSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const sourceRoot = fileURLToPath(new URL("../src", import.meta.url));

const sourceFiles = (directory: string): string[] =>
  readdirSync(directory)
    .flatMap((entry) => {
      const path = resolve(directory, entry).replaceAll("\\", "/");
      return statSync(path).isDirectory() ? sourceFiles(path) : [path];
    })
    .filter((path) => path.endsWith(".ts") || path.endsWith(".tsx"));

describe("Commander architecture boundaries", () => {
  it("keeps raw SQL inside repository modules", () => {
    const violations = sourceFiles(sourceRoot)
      .filter((path) => !path.endsWith("repository.ts"))
      .filter((path) => /\.sql(?:<[^>]+>)?`/.test(readFileSync(path, "utf8")));
    expect(violations).toEqual([]);
  });

  it("uses contract-first Effect HttpApi instead of pathname dispatch", () => {
    const router = readFileSync(resolve(sourceRoot, "api/router.ts"), "utf8");
    const contract = readFileSync(resolve(sourceRoot, "api/contract.ts"), "utf8");
    expect(contract).toContain("HttpApi.make");
    expect(contract).toContain("HttpApiEndpoint");
    expect(router).toContain("HttpApiBuilder.group");
    expect(router).toContain("HttpRouter.toWebHandler");
    expect(router).not.toContain('from "hono"');
    expect(router).not.toMatch(/pathname\s*===|switch\s*\(.*pathname/);
  });

  it("keeps Effect execution at application and framework boundaries", () => {
    const violations = sourceFiles(sourceRoot)
      .filter(
        (path) =>
          !path.endsWith("index.ts") &&
          !path.includes("/durable/") &&
          !path.endsWith("api/router.ts"),
      )
      .filter((path) => readFileSync(path, "utf8").includes("Effect.runPromise"));
    expect(violations).toEqual([]);
  });
});
