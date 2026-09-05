import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const repositoryRoot = resolve(import.meta.dirname, "../../..");

describe("Maskirovka workflow safety", () => {
  it("disables task caching for runtime and deployment side effects", async () => {
    const packageJson = JSON.parse(
      await readFile(resolve(repositoryRoot, "package.json"), "utf8"),
    ) as { readonly scripts: Readonly<Record<string, string>> };

    for (const script of ["ai:smoke"]) {
      expect(packageJson.scripts[script]).toContain("vp run --no-cache");
    }
  });

  it("keeps both Container builds pinned and frozen", async () => {
    const containerFiles = [
      ["services/inference/Dockerfile", "services/inference/container-pnpm-lock.yaml"],
      ["apps/maskirovka-seat/Dockerfile", "apps/maskirovka-seat/container-pnpm-lock.yaml"],
    ] as const;
    const expectedNodeImage =
      "node:22-bookworm-slim@sha256:d649c27dae7ba0137b3cef5dd75baa422c08dc3d9e3fc0c23dfb172dc3cc6436";

    for (const [dockerfilePath, lockfilePath] of containerFiles) {
      const dockerfile = await readFile(resolve(repositoryRoot, dockerfilePath), "utf8");
      const lockfile = await readFile(resolve(repositoryRoot, lockfilePath), "utf8");
      expect(dockerfile).toContain(
        `FROM --platform=\${MASKIROVKA_PLATFORM} ${expectedNodeImage} AS build`,
      );
      expect(dockerfile).toContain(
        `FROM --platform=\${MASKIROVKA_PLATFORM} ${expectedNodeImage} AS runtime`,
      );
      expect(dockerfile).toContain("pnpm install --frozen-lockfile");
      expect(dockerfile).not.toContain("--no-frozen-lockfile");
      expect(dockerfile).toContain("container-pnpm-lock.yaml");
      expect(lockfile).toMatch(/^lockfileVersion:\s*["']9\.0["']/mu);
      expect(lockfile).toContain("importers:");
    }

    const gatewayDockerfile = await readFile(
      resolve(repositoryRoot, "services/inference/Dockerfile"),
      "utf8",
    );
    expect(gatewayDockerfile).toContain("@anthropic-ai/claude-code@2.1.226");
    expect(gatewayDockerfile).not.toContain("@openai/codex@");
    expect(gatewayDockerfile).toContain("packages/model-provider-codex/src");
  });
});
