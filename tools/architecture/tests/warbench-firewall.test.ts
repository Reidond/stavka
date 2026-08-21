import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

const repositoryRoot = process.cwd();

const walk = (directory: string): string[] =>
  readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    if (["dist", "node_modules", ".output"].includes(entry.name)) return [];
    const path = join(directory, entry.name);
    return entry.isDirectory() ? walk(path) : [path];
  });

const coreRoot = resolve(repositoryRoot, "packages/warbench-core");
const coreFiles = walk(coreRoot).filter(
  (path) => /\.(?:ts|tsx|json)$/u.test(path) && !path.endsWith(".d.ts"),
);

// Warbench exists to test the product hypothesis independently of the Stavka
// implementation it evaluates. These boundaries are enforced by CI, not by
// maintaining a second repository.
const forbiddenPackageImports = [
  "@stavka/protocol",
  "@stavka/doctrine",
  "@stavka/sim-core",
  "@stavka/sim-link",
  "@stavka/commander",
  "@stavka/model-provider",
  "@stavka/model-provider-pi",
  "@cloudflare/",
  "@earendil-works/",
  "jose",
];

describe("warbench-core dependency firewall", () => {
  it("declares only the effect runtime as a dependency", () => {
    const manifest = JSON.parse(readFileSync(resolve(coreRoot, "package.json"), "utf8")) as Record<
      string,
      Record<string, string> | undefined
    >;
    const declared = Object.keys({
      ...manifest.dependencies,
      ...manifest.devDependencies,
    });
    expect(declared).toEqual(["effect"]);
  });

  it("imports no Stavka simulation, protocol, provider, or Cloudflare module", () => {
    const violations = coreFiles.flatMap((path) => {
      const source = readFileSync(path, "utf8");
      return forbiddenPackageImports
        .filter((name) => source.includes(name))
        .map((name) => `${path}: references ${name}`);
    });
    expect(violations).toEqual([]);
  });

  it("runs on plain Node without Worker or Durable Object globals", () => {
    const manifest = JSON.parse(readFileSync(resolve(coreRoot, "tsconfig.json"), "utf8")) as {
      compilerOptions?: { types?: string[] };
    };
    expect(manifest.compilerOptions?.types ?? []).not.toContain("@cloudflare/workers-types");
  });
});
