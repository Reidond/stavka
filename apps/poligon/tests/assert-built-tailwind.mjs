import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const appRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const assetsDirectory = join(appRoot, "dist", "client", "assets");
const cssFiles = (await readdir(assetsDirectory)).filter((name) => name.endsWith(".css"));

if (cssFiles.length === 0) {
  throw new Error(`No generated client CSS found in ${assetsDirectory}`);
}

const css = (
  await Promise.all(cssFiles.map((name) => readFile(join(assetsDirectory, name), "utf8")))
).join("\n");

const sharedUtilities = [
  ["inline-flex", ".inline-flex{display:inline-flex}"],
  ["max-w-xl", ".max-w-xl{max-width:var(--container-xl)}"],
  ["data-active:bg-ink", ".data-active\\:bg-ink[data-active]{background-color:var(--color-ink)}"],
];

const missing = sharedUtilities
  .filter(([, generatedCss]) => !css.includes(generatedCss))
  .map(([utility]) => utility);

if (missing.length > 0) {
  throw new Error(
    `Generated Poligon CSS is missing shared @stavka/ui utilities: ${missing.join(", ")}`,
  );
}
