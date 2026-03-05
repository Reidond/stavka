import { execSync, spawnSync } from "node:child_process";
import {
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  copyFileSync,
  chmodSync,
} from "node:fs";
import { resolve, join } from "node:path";
import { createInterface } from "node:readline";
import { pipeline } from "node:stream/promises";
import { __dirname } from "./settings.ts";

const isWindows = process.platform === "win32";

const SERVER_APP_ID = "1874900";
const STEAMCMD_URL = isWindows
  ? "https://steamcdn-a.akamaihd.net/client/installer/steamcmd.zip"
  : "https://steamcdn-a.akamaihd.net/client/installer/steamcmd_linux.tar.gz";
const STEAMCMD_DIR = resolve(__dirname, "steamcmd");
const STEAMCMD_BIN = join(STEAMCMD_DIR, isWindows ? "steamcmd.exe" : "steamcmd.sh");
const INSTALL_DIR = resolve(__dirname, "arma-server");
const SETTINGS_PATH = resolve(__dirname, "settings.json");
const SETTINGS_EXAMPLE = resolve(__dirname, "settings.example.json");

function prompt(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((res) => {
    rl.question(question, (answer) => {
      rl.close();
      res(answer.trim());
    });
  });
}

function findSteamCmd(): string | null {
  // Check local install first
  if (existsSync(STEAMCMD_BIN)) return STEAMCMD_BIN;

  // Check system PATH
  const whichCmd = isWindows ? "where" : "which";
  const candidates = isWindows
    ? ["steamcmd", "C:\\steamcmd\\steamcmd.exe"]
    : ["steamcmd", "/usr/bin/steamcmd", "/usr/games/steamcmd"];

  for (const cmd of candidates) {
    try {
      execSync(`${whichCmd} ${cmd}`, { stdio: "ignore" });
      return cmd;
    } catch {}
  }
  return null;
}

async function downloadSteamCmd(): Promise<string> {
  console.log("Downloading SteamCMD...");
  mkdirSync(STEAMCMD_DIR, { recursive: true });

  const archiveName = isWindows ? "steamcmd.zip" : "steamcmd_linux.tar.gz";
  const archivePath = join(STEAMCMD_DIR, archiveName);

  const response = await fetch(STEAMCMD_URL);
  if (!response.ok || !response.body) {
    throw new Error(`Failed to download SteamCMD: ${response.statusText}`);
  }

  const fileStream = createWriteStream(archivePath);
  // @ts-ignore - ReadableStream to NodeJS.ReadableStream
  await pipeline(response.body, fileStream);

  console.log("Extracting SteamCMD...");
  if (isWindows) {
    execSync(`tar -xf ${archiveName}`, { cwd: STEAMCMD_DIR });
  } else {
    execSync(`tar -xzf ${archiveName}`, { cwd: STEAMCMD_DIR });
    chmodSync(STEAMCMD_BIN, 0o755);
  }

  console.log(`SteamCMD installed: ${STEAMCMD_DIR}`);
  return STEAMCMD_BIN;
}

function findServerBinary(dir: string): string | null {
  const candidates = [
    join(dir, "ArmaReforgerServer"),
    join(dir, "ArmaReforgerServer.exe"),
  ];
  for (const path of candidates) {
    if (existsSync(path)) return path;
  }
  return null;
}

async function main() {
  console.log("=== Arma Reforger Dedicated Server Setup ===\n");

  // Step 1: Find or download SteamCMD
  let steamCmd = findSteamCmd();
  if (!steamCmd) {
    console.log("SteamCMD not found on system.\n");
    const answer = await prompt(
      "Download SteamCMD locally to this project? [Y/n]: "
    );
    if (answer.toLowerCase() === "n") {
      process.exit(0);
    }
    steamCmd = await downloadSteamCmd();
  }

  console.log(`SteamCMD: ${steamCmd}`);

  // Step 2: Choose install directory
  const dirAnswer = await prompt(`\nInstall directory [${INSTALL_DIR}]: `);
  const installDir = dirAnswer || INSTALL_DIR;
  mkdirSync(installDir, { recursive: true });

  console.log(
    `\nDownloading Arma Reforger Server (AppID ${SERVER_APP_ID})...`
  );
  console.log(`Install dir: ${installDir}\n`);

  // Step 3: Download via SteamCMD
  const result = spawnSync(
    steamCmd,
    [
      "+force_install_dir",
      installDir,
      "+login",
      "anonymous",
      "+app_update",
      SERVER_APP_ID,
      "validate",
      "+quit",
    ],
    { stdio: "inherit", timeout: 600_000 }
  );

  if (result.status !== 0) {
    console.error("\nSteamCMD failed. Check output above.");
    process.exit(1);
  }

  // Step 4: Find server binary
  const serverBin = findServerBinary(installDir);
  if (!serverBin) {
    console.error(`\nServer binary not found in ${installDir}`);
    console.log("Check if the download completed successfully.");
    process.exit(1);
  }

  console.log(`\nServer binary: ${serverBin}`);

  // Step 5: Create settings.json
  if (!existsSync(SETTINGS_PATH)) {
    if (existsSync(SETTINGS_EXAMPLE)) {
      copyFileSync(SETTINGS_EXAMPLE, SETTINGS_PATH);
    } else {
      writeFileSync(SETTINGS_PATH, "{}");
    }
  }

  const settings = JSON.parse(readFileSync(SETTINGS_PATH, "utf-8"));
  settings.serverBin = serverBin;
  if (!settings.profileDir) settings.profileDir = "./arma-server/profile";
  if (!settings.addonsDir) settings.addonsDir = "../mods";
  writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2) + "\n");

  console.log(`Settings written: ${SETTINGS_PATH}`);
  console.log("\n=== Setup complete ===");
  console.log("\nNext steps:");
  console.log("  node start.ts --fresh     Start with a fresh Conflict map");
  console.log("  node start.ts --save X    Start with a saved state");
  console.log("  node saves.ts list        List available saves");
}

main();
