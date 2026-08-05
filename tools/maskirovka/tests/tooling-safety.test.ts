import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const repositoryRoot = resolve(import.meta.dirname, "../../..");

describe("Maskirovka workflow safety", () => {
  it("disables task caching for runtime and deployment side effects", async () => {
    const packageJson = JSON.parse(
      await readFile(resolve(repositoryRoot, "package.json"), "utf8"),
    ) as { readonly scripts: Readonly<Record<string, string>> };

    for (const script of [
      "ai:up",
      "ai:doctor",
      "ai:smoke",
      "ai:models",
      "ai:serve",
      "ai:deploy-seat",
    ]) {
      expect(packageJson.scripts[script]).toContain("vp run --no-cache");
    }
  });

  it.each(["ci.yml", "deploy.yml"])("runs fresh smoke in %s", async (workflow) => {
    const content = await readFile(resolve(repositoryRoot, ".github/workflows", workflow), "utf8");
    expect(content).toContain("run: pnpm ai:smoke");
    if (workflow === "deploy.yml") {
      expect(content).toContain("vp run --no-cache --concurrency-limit 2 deploy");
    }
  });
});
