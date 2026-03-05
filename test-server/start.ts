import { spawn } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { parseArgs } from "node:util";
import { loadSettings, __dirname } from "./settings.ts";

const { values } = parseArgs({
  options: {
    save: { type: "string", short: "s" },
    fresh: { type: "boolean", short: "f" },
    config: { type: "string", short: "c", default: "config.json" },
    fps: { type: "string", default: "30" },
  },
});

const settings = loadSettings();
const configPath = resolve(__dirname, values.config!);
const profileDir = resolve(__dirname, settings.profileDir);
const addonsDir = resolve(__dirname, settings.addonsDir);

// Collect local mod names from addonsDir
const modNames: string[] = [];
for (const entry of readdirSync(addonsDir, { withFileTypes: true })) {
  if (!entry.isDirectory()) continue;
  modNames.push(entry.name);
}

const config = JSON.parse(readFileSync(configPath, "utf-8"));
const args: string[] = [];

if (modNames.length > 0) {
  // Local mods require -server mode (-config validates mods against Workshop)
  args.push(
    "-server", config.game.scenarioId,
    "-addonsDir", addonsDir,
    "-addons", modNames.join(","),
  );
} else {
  args.push("-config", configPath);
}

args.push(
  "-profile", profileDir,
  "-maxFPS", values.fps!,
);

if (values.save) {
  args.push("-loadSessionSave", values.save);
  console.log(`Save: ${values.save}`);
} else if (!values.fresh) {
  args.push("-loadSessionSave");
  console.log("Save: latest");
}

if (values.fresh) {
  console.log("Save: none (fresh start)");
}

console.log(`Server:  ${settings.serverBin}`);
console.log(`Profile: ${profileDir}`);
console.log(`Addons:  ${addonsDir} (${modNames.join(", ") || "none"})`);
console.log(`Config:  ${configPath}`);
console.log("---");

const child = spawn(settings.serverBin, args, {
  stdio: "inherit",
  cwd: dirname(settings.serverBin),
});

child.on("error", (err) => {
  console.error(`Failed to start server: ${err.message}`);
  process.exit(1);
});

child.on("exit", (code) => {
  console.log(`Server exited with code ${code}`);
  process.exit(code ?? 0);
});
