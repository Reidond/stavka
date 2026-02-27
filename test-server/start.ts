import { spawn } from "node:child_process";
import { readFileSync, writeFileSync, existsSync, readdirSync, symlinkSync, lstatSync } from "node:fs";
import { resolve, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const __dirname = dirname(fileURLToPath(import.meta.url));

interface Settings {
  serverBin: string;
  profileDir: string;
  addonsDir: string;
}

function loadSettings(): Settings {
  const path = resolve(__dirname, "settings.json");
  if (!existsSync(path)) {
    console.error(
      "Missing server/settings.json\n" +
        "Copy settings.example.json and fill in your local paths."
    );
    process.exit(1);
  }
  return JSON.parse(readFileSync(path, "utf-8"));
}

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

const args: string[] = [
  "-config",
  configPath,
  "-profile",
  profileDir,
  "-addonsDir",
  addonsDir,
  "-maxFPS",
  values.fps!,
];

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

// Symlink local mods into server's addons dir so they auto-load
const serverAddonsDir = resolve(dirname(settings.serverBin), "addons");
for (const entry of readdirSync(addonsDir, { withFileTypes: true })) {
  if (!entry.isDirectory()) continue;
  const target = resolve(addonsDir, entry.name);
  const link = resolve(serverAddonsDir, entry.name);
  try {
    lstatSync(link);
  } catch {
    symlinkSync(target, link);
    console.log(`Linked: ${entry.name} -> ${link}`);
  }
}

console.log(`Server:  ${settings.serverBin}`);
console.log(`Profile: ${profileDir}`);
console.log(`Addons:  ${addonsDir}`);
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

process.on("SIGINT", () => child.kill("SIGINT"));
process.on("SIGTERM", () => child.kill("SIGTERM"));
