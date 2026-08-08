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

const kumoUtilities = [
  ["kumo base token", "--color-kumo-base"],
  ["kumo canvas token", "--color-kumo-canvas"],
  ["kumo default text", "--text-color-kumo-default"],
  ["kumo table utility", ".bg-kumo-base"],
  ["kumo semantic status utility", ".text-kumo-success"],
  ["kumo component-internal utility", ".bg-linear-to-b"],
];

const missing = kumoUtilities
  .filter(([, generatedCss]) => !css.includes(generatedCss))
  .map(([utility]) => utility);

if (missing.length > 0) {
  throw new Error(`Generated Poligon CSS is missing Kumo tokens/utilities: ${missing.join(", ")}`);
}
