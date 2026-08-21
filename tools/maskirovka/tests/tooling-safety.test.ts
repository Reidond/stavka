import { readdirSync } from "node:fs";
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

  it("keeps verification and deployment in separate gated workflows", async () => {
    const workflowDirectory = resolve(repositoryRoot, ".github/workflows");
    expect(
      readdirSync(workflowDirectory)
        .filter((name) => name.endsWith(".yml"))
        .sort(),
    ).toEqual(["ci.yml", "deploy.yml"]);

    const workflow = await readFile(resolve(workflowDirectory, "ci.yml"), "utf8");
    expect(workflow).toContain("pull_request:");
    expect(workflow).toContain("branches: [main]");
    expect(workflow).toContain("workflow_dispatch:");
    expect(workflow).toContain("3d3c42e5aac5ba805825da76410c181273ba90b1");
    expect(workflow).toContain("313600b80b104eadebb9111787d37a2e83e014ca");
    expect(workflow).toContain("persist-credentials: false");
    // Verification provisions pnpm explicitly from the pinned root version.
    expect(workflow).toContain("pnpm/action-setup@0977fd99725f1db4007ccb2928dbb4e90d06cc86");
    expect(workflow).toContain("version: 11.18.0");
    expect(workflow).toContain("run-install: false");
    expect(workflow).toContain("group: ci-${{ github.ref }}");
    expect(workflow).toContain("cancel-in-progress: true");
    // Verification runs every deterministic gate.
    for (const gate of [
      "pnpm check",
      "pnpm lint:tailwind",
      "pnpm test",
      "pnpm typecheck",
      "pnpm build",
      "pnpm eval -- --replay",
      "pnpm ai:smoke",
    ]) {
      expect(workflow).toContain(gate);
    }
    // Verification never deploys or touches Cloudflare credentials.
    expect(workflow).not.toContain("deploy:production");
    expect(workflow).not.toContain("CLOUDFLARE_API_TOKEN");

    const deploy = await readFile(resolve(workflowDirectory, "deploy.yml"), "utf8");
    expect(deploy).toContain("workflow_dispatch:");
    expect(deploy).not.toContain("push:");
    expect(deploy).toContain("github.ref == 'refs/heads/main'");
    expect(deploy).toContain("environment: production");
    expect(deploy).toContain("group: cloudflare-production");
    expect(deploy).toContain("cancel-in-progress: false");
    expect(deploy).toContain("CLOUDFLARE_API_TOKEN");
    expect(deploy).toContain("CLOUDFLARE_ACCOUNT_ID");
    expect(deploy).toContain("pnpm run deploy:production");
  });

  it("keeps both Container builds pinned and frozen", async () => {
    const containerFiles = [
      ["apps/maskirovka-gateway/Dockerfile", "apps/maskirovka-gateway/container-pnpm-lock.yaml"],
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
      resolve(repositoryRoot, "apps/maskirovka-gateway/Dockerfile"),
      "utf8",
    );
    expect(gatewayDockerfile).toContain("@anthropic-ai/claude-code@2.1.226");
    expect(gatewayDockerfile).toContain("@openai/codex@0.146.0");
  });

  it("bundles first-party gateway code and smoke-tests the pruned runtime tree", async () => {
    const gatewayDirectory = resolve(repositoryRoot, "apps/maskirovka-gateway");
    const [dockerfile, packageSource, workspace, lockfile, smoke] = await Promise.all([
      readFile(resolve(gatewayDirectory, "Dockerfile"), "utf8"),
      readFile(resolve(gatewayDirectory, "container-package.json"), "utf8"),
      readFile(resolve(gatewayDirectory, "container-pnpm-workspace.yaml"), "utf8"),
      readFile(resolve(gatewayDirectory, "container-pnpm-lock.yaml"), "utf8"),
      readFile(resolve(gatewayDirectory, "container-smoke.mjs"), "utf8"),
    ]);
    const packageJson = JSON.parse(packageSource) as {
      readonly dependencies: Readonly<Record<string, string>>;
    };

    expect(dockerfile).toContain("--packages=external");
    expect(dockerfile).toContain("--bundle");
    expect(dockerfile).toContain("--format=esm");
    expect(dockerfile).toContain("--platform=node");
    expect(dockerfile).toContain("--target=node22");
    expect(dockerfile).toContain("COPY packages/access-auth/src ./packages/access-auth/src");
    expect(dockerfile).toContain("COPY packages/protocol/src ./packages/protocol/src");
    expect(dockerfile).toContain("--alias:@stavka/access-auth=./packages/access-auth/src/index.ts");
    expect(dockerfile).toContain("--alias:@stavka/protocol=./packages/protocol/src/index.ts");
    expect(dockerfile).toContain("--metafile=container-meta.json");
    expect(dockerfile).toContain(
      "RUN --network=none node ./container-smoke.mjs ./dist/container.js ./container-meta.json",
    );
    const pruneIndex = dockerfile.indexOf("pnpm prune --prod");
    const smokeIndex = dockerfile.indexOf("RUN --network=none node ./container-smoke.mjs");
    expect(pruneIndex).toBeGreaterThan(-1);
    expect(smokeIndex).toBeGreaterThan(pruneIndex);
    const runtimeIndex = dockerfile.indexOf(" AS runtime");
    expect(runtimeIndex).toBeGreaterThan(-1);
    const runtimeStage = dockerfile.slice(runtimeIndex);
    expect(runtimeStage).not.toContain("packages/access-auth");
    expect(runtimeStage).not.toContain("packages/protocol");
    expect(runtimeStage).not.toContain("tools/maskirovka");
    expect(runtimeStage).not.toMatch(/\b(?:COPY|ADD)[^\n]*(?:\.ts|\/src(?:\/|\s))/u);

    expect(
      Object.keys(packageJson.dependencies).filter((name) => name.startsWith("@stavka/")),
    ).toEqual([]);
    expect(packageJson.dependencies).toMatchObject({
      "@effect/platform-node": "4.0.0-beta.102",
      "@anthropic-ai/claude-agent-sdk": "0.3.220",
      "@openai/codex-sdk": "0.146.0",
      effect: "4.0.0-beta.102",
      jose: "6.2.7",
      ws: "8.21.1",
    });
    expect(packageJson.dependencies.jose).toBe("6.2.7");
    expect(workspace.match(/^\s+-\s+.+$/gmu)).toEqual(['  - "."']);
    expect(lockfile).not.toMatch(/(?:link:packages\/|file:tools\/maskirovka)/u);
    expect(lockfile).toMatch(/jose:\s*\n\s+specifier:\s+6\.2\.7\s*\n\s+version:\s+6\.2\.7/u);
    expect(lockfile).toMatch(/^\s+jose@6\.2\.7:\s*$/mu);

    expect(smoke).toContain('import { spawn } from "node:child_process"');
    expect(smoke).toContain("metadata.outputs");
    expect(smoke).toContain("assertRuntimeExternal");
    expect(smoke).toContain("runtimeNodeModules");
    expect(smoke).toContain("import.meta.resolve");
    expect(smoke).toContain('imported.path.startsWith("@stavka/")');
    expect(smoke).toContain("/healthz");
    expect(smoke).toContain('MASKIROVKA_MODE: "replay"');
    expect(smoke).toContain("PATH: `${smokeRoot}/empty-bin`");
    expect(smoke).toContain("startupTimeoutMs = 15_000");
  });
});
