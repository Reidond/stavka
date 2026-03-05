import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

export const __dirname = dirname(fileURLToPath(import.meta.url));

export interface Settings {
  serverBin: string;
  profileDir: string;
  addonsDir: string;
}

export function loadSettings(): Settings {
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

export function loadProfileDir(): string {
  const settings = loadSettings();
  return resolve(__dirname, settings.profileDir);
}
