import { readFileSync, readdirSync } from "node:fs";
import { basename, join } from "node:path";

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

  it("keeps shared component variants on tailwind-variants", () => {
    const manifest = readFileSync(join(repositoryRoot, "packages/ui/package.json"), "utf8");
    const variants = readFileSync(join(repositoryRoot, "packages/ui/src/variants.ts"), "utf8");

    expect(manifest).toContain('"tailwind-variants"');
    expect(variants).toMatch(/from\s+["']tailwind-variants["']/u);
    expect(variants).toMatch(/\btv\s*\(/u);
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
  });

  it("keeps Tailwind diagnostics aligned across scripts, CI, and Cursor", () => {
    const manifest = readFileSync(join(repositoryRoot, "package.json"), "utf8");
    const taskPlan = readFileSync(join(repositoryRoot, "tools/tasks/src/task-plan.ts"), "utf8");
    const oxlint = readFileSync(join(repositoryRoot, ".oxlintrc.json"), "utf8");
    const frontendOxlintConfigs = [
      ".oxlintrc.poligon.json",
      ".oxlintrc.maskirovka-seat.json",
      ".oxlintrc.maskirovka.json",
    ].map((path) => readFileSync(join(repositoryRoot, path), "utf8"));
    const settings = readFileSync(join(repositoryRoot, ".vscode/settings.json"), "utf8");
    const extensions = readFileSync(join(repositoryRoot, ".vscode/extensions.json"), "utf8");
    const ci = readFileSync(join(repositoryRoot, ".github/workflows/ci.yml"), "utf8");
    const poligonStyles = readFileSync(join(repositoryRoot, "apps/poligon/src/styles.css"), "utf8");

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
    expect(settings).toContain('"tailwindCSS.classFunctions": ["cn", "tv"]');
    expect(settings).toContain(
      '"apps/maskirovka-seat/src/dashboard/styles.css": "apps/maskirovka-seat/src/dashboard/**"',
    );
    expect(extensions).toContain('"bradlc.vscode-tailwindcss"');
    expect(extensions).toContain('"oxc.oxc-vscode"');
    expect(ci).toContain("pnpm lint:tailwind");
    expect(poligonStyles).toContain('@source "../../../packages/ui/src"');
    expect(poligonStyles).toContain("@layer components");
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
