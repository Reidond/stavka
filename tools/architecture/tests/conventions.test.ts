import { existsSync, readFileSync, readdirSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

const repositoryRoot = process.cwd();
const sourceRoots = ["apps", "packages", "tools"] as const;

const walk = (directory: string): string[] =>
  readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    if (["dist", "node_modules", ".output"].includes(entry.name)) return [];
    const path = join(directory, entry.name);
    return entry.isDirectory() ? walk(path) : [path];
  });

const sourceFiles = sourceRoots.flatMap((root) => walk(join(repositoryRoot, root)));
const implementationFiles = sourceFiles.filter(
  (path) =>
    /\.(?:ts|tsx)$/u.test(path) &&
    !path.endsWith(".d.ts") &&
    !path.endsWith("routeTree.gen.ts") &&
    !path.includes("/tests/"),
);

describe("project architecture conventions", () => {
  it("pins every Effect dependency to the selected v4 release", () => {
    const manifests = sourceFiles.filter((path) => basename(path).endsWith("package.json"));
    const mismatches = manifests.flatMap((path) => {
      const manifest = JSON.parse(readFileSync(path, "utf8")) as Record<
        string,
        Record<string, string> | undefined
      >;
      return ["dependencies", "devDependencies"].flatMap((section) =>
        Object.entries(manifest[section] ?? {})
          .filter(
            ([name, version]) =>
              (name === "effect" || name.startsWith("@effect/")) && version !== "4.0.0-beta.102",
          )
          .map(([name, version]) => `${path}: ${name}@${version}`),
      );
    });

    expect(mismatches).toEqual([]);
  });

  it("uses Effect HTTP routing instead of Hono or pathname dispatch", () => {
    const forbiddenDependencies = sourceFiles
      .filter((path) => basename(path).endsWith("package.json"))
      .filter((path) => /["'](?:hono|@hono\/[^"']+)["']/u.test(readFileSync(path, "utf8")));
    const forbiddenImports = implementationFiles.filter((path) =>
      /from\s+["'](?:hono|@hono\/[^"']+)["']/u.test(readFileSync(path, "utf8")),
    );
    const manualDispatch = implementationFiles.filter((path) =>
      /\.pathname\b/u.test(readFileSync(path, "utf8")),
    );

    expect({ forbiddenDependencies, forbiddenImports, manualDispatch }).toEqual({
      forbiddenDependencies: [],
      forbiddenImports: [],
      manualDispatch: [],
    });

    const httpApplications = [
      "apps/commander/src",
      "apps/maskirovka-seat/src",
      "apps/poligon/src",
      "apps/maskirovka-gateway/src",
      "tools/maskirovka/src",
    ];
    const missingEffectContracts = httpApplications.filter((directory) => {
      const source = walk(join(repositoryRoot, directory))
        .filter((path) => /\.(?:ts|tsx)$/u.test(path) && !path.endsWith(".d.ts"))
        .map((path) => readFileSync(path, "utf8"))
        .join("\n");
      return !source.includes("HttpApi.make(") || !source.includes("HttpApiBuilder");
    });

    expect(missingEffectContracts).toEqual([]);
  });

  it("keeps SQL statements inside repository modules", () => {
    const sql =
      /\b(?:CREATE\s+TABLE|ALTER\s+TABLE|DROP\s+TABLE|SELECT[\s\S]{0,500}\sFROM|INSERT\s+INTO|UPDATE[\s\S]{0,200}\sSET|DELETE\s+FROM)\b/u;
    const offenders = implementationFiles.filter((path) => {
      if (!sql.test(readFileSync(path, "utf8"))) return false;
      return !basename(path).includes("repository");
    });

    expect(offenders).toEqual([]);
  });

  it("uses direct Kumo dependencies and rejects the retired private UI package", () => {
    const consumers = [
      "apps/poligon/package.json",
      "tools/maskirovka/package.json",
      "apps/maskirovka-seat/package.json",
      "apps/maskirovka-gateway/package.json",
    ];
    const retiredPackageNames = [
      ["@stavka", "ui"].join("/"),
      ["tailwind", "variants"].join("-"),
      ["@base-ui-components", "react"].join("/"),
    ];
    const legacyReferences = sourceFiles
      .filter((path) => /(?:package\.json|\.(?:ts|tsx|css|md))$/u.test(path))
      .filter((path) =>
        retiredPackageNames.some((name) => readFileSync(path, "utf8").includes(name)),
      );

    expect(legacyReferences).toEqual([]);
    for (const relative of consumers) {
      const manifest = JSON.parse(readFileSync(join(repositoryRoot, relative), "utf8")) as {
        dependencies?: Record<string, string>;
      };
      expect(manifest.dependencies?.["@cloudflare/kumo"], relative).toBe("2.9.2");
      expect(manifest.dependencies?.["@phosphor-icons/react"], relative).toBe("2.1.10");
      const source = walk(join(repositoryRoot, relative.split("/").slice(0, -1).join("/")))
        .filter((path) => /\.(?:ts|tsx)$/u.test(path))
        .map((path) => readFileSync(path, "utf8"))
        .join("\n");
      expect(source).toMatch(/@cloudflare\/kumo\/(?:components|primitives)\//u);
    }
  });

  it("keeps package scripts as short task aliases", () => {
    const manifest = JSON.parse(readFileSync(join(repositoryRoot, "package.json"), "utf8")) as {
      readonly scripts: Readonly<Record<string, string>>;
    };
    const offenders = Object.entries(manifest.scripts).filter(
      ([, command]) => command.length > 80 || /(?:&&|\|\||;)/u.test(command),
    );

    expect(offenders).toEqual([]);
    expect(manifest.scripts.eval).toBe("pnpm --filter @stavka/tasks eval");
    expect(manifest.scripts["lint:tailwind"]).toBe("pnpm --filter @stavka/tasks lint:tailwind");
    expect(manifest.scripts["deploy:production"]).toBe(
      "pnpm --filter @stavka/tasks deploy:production",
    );
    expect(manifest.scripts.deploy).toBeUndefined();

    const gatewayManifest = JSON.parse(
      readFileSync(join(repositoryRoot, "apps/maskirovka-gateway/package.json"), "utf8"),
    ) as { readonly scripts: Readonly<Record<string, string>> };
    expect(gatewayManifest.scripts.build).toBe(
      "pnpm --filter @stavka/tasks build:maskirovka-gateway",
    );
  });

  it("keeps Tailwind diagnostics aligned across scripts, CI, and Cursor", () => {
    const manifest = readFileSync(join(repositoryRoot, "package.json"), "utf8");
    const taskPlan = readFileSync(join(repositoryRoot, "tools/tasks/src/task-plan.ts"), "utf8");
    const oxlint = readFileSync(join(repositoryRoot, ".oxlintrc.json"), "utf8");
    const frontendOxlintConfigs = [
      ".oxlintrc.poligon.json",
      ".oxlintrc.maskirovka-seat.json",
      ".oxlintrc.maskirovka.json",
      ".oxlintrc.maskirovka-gateway.json",
    ].map((path) => readFileSync(join(repositoryRoot, path), "utf8"));
    const settings = readFileSync(join(repositoryRoot, ".vscode/settings.json"), "utf8");
    const extensions = readFileSync(join(repositoryRoot, ".vscode/extensions.json"), "utf8");
    const ci = readFileSync(join(repositoryRoot, ".github/workflows/ci.yml"), "utf8");
    const stylePaths = [
      "apps/poligon/src/styles.css",
      "tools/maskirovka/src/dashboard/styles.css",
      "apps/maskirovka-seat/src/dashboard/styles.css",
      "apps/maskirovka-gateway/src/dashboard/styles.css",
    ];
    const styles = stylePaths.map((path) => readFileSync(join(repositoryRoot, path), "utf8"));

    expect(manifest).toContain('"lint:tailwind"');
    expect(oxlint).toContain('"eslint-plugin-better-tailwindcss"');
    expect(oxlint).toContain('"better-tailwindcss/no-conflicting-classes"');
    expect(oxlint).toContain('"^poligon-(?:shell|layout)$"');
    expect(oxlint).toContain('"^maskirovka-(?:shell|grid)$"');
    expect(frontendOxlintConfigs.every((config) => config.includes('"entryPoint"'))).toBe(true);
    expect(
      frontendOxlintConfigs.every((config) =>
        config.includes('"better-tailwindcss/no-unknown-classes": "error"'),
      ),
    ).toBe(true);
    expect(taskPlan).toContain(".oxlintrc.poligon.json");
    expect(taskPlan).toContain(".oxlintrc.maskirovka-seat.json");
    expect(taskPlan).toContain(".oxlintrc.maskirovka.json");
    expect(taskPlan).toContain(".oxlintrc.maskirovka-gateway.json");
    expect(settings).toContain('"tailwindCSS.classFunctions": []');
    expect(settings).toContain(
      '"apps/maskirovka-seat/src/dashboard/styles.css": "apps/maskirovka-seat/src/dashboard/**"',
    );
    expect(settings).toContain(
      '"apps/maskirovka-gateway/src/dashboard/styles.css": "apps/maskirovka-gateway/src/dashboard/**"',
    );
    expect(extensions).toContain('"bradlc.vscode-tailwindcss"');
    expect(extensions).toContain('"oxc.oxc-vscode"');
    expect(ci).toContain("pnpm lint:tailwind");
    for (const [index, stylesheet] of styles.entries()) {
      const source = stylesheet.match(/@source "([^"]+\/@cloudflare\/kumo\/dist)\/\*\*\//u);
      expect(source, stylePaths[index]).not.toBeNull();
      expect(
        existsSync(resolve(dirname(join(repositoryRoot, stylePaths[index]!)), source![1]!)),
        stylePaths[index],
      ).toBe(true);
      expect(stylesheet).toMatch(
        /@source "[^"]+";\s*@import "@cloudflare\/kumo\/styles\/tailwind";\s*@import "tailwindcss";/u,
      );
    }
  });

  it("ships the project-local Effect v4 engineering skill", () => {
    const skill = readFileSync(join(repositoryRoot, ".agents/skills/effect-v4/SKILL.md"), "utf8");
    const http = readFileSync(
      join(repositoryRoot, ".agents/skills/effect-v4/references/httpapi.md"),
      "utf8",
    );

    expect(skill).toContain("name: effect-v4");
    expect(skill).toContain("Raw SQL and schema migration text live only");
    expect(http).toContain("HttpApiBuilder");
    expect(http).toContain("never\n  branch on `new URL(request.url).pathname`");
  });
});
