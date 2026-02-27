import {
  readFileSync,
  readdirSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  statSync,
} from "node:fs";
import { resolve, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

function loadProfileDir(): string {
  const path = resolve(__dirname, "settings.json");
  if (!existsSync(path)) {
    console.error(
      "Missing server/settings.json\n" +
        "Copy settings.example.json and fill in your local paths."
    );
    process.exit(1);
  }
  const settings = JSON.parse(readFileSync(path, "utf-8"));
  return resolve(__dirname, settings.profileDir);
}

function getSavesDir(): string {
  return resolve(loadProfileDir(), ".save", "sessions");
}

// --- Commands ---

function list() {
  const dir = getSavesDir();
  if (!existsSync(dir)) {
    console.log(`No saves directory yet: ${dir}`);
    return;
  }

  const files = readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => {
      const stat = statSync(resolve(dir, f));
      return { name: f, modified: stat.mtime, size: stat.size };
    })
    .sort((a, b) => b.modified.getTime() - a.modified.getTime());

  if (files.length === 0) {
    console.log("No saves found.");
    return;
  }

  console.log(`Saves in: ${dir}\n`);
  for (const f of files) {
    const kb = (f.size / 1024).toFixed(1);
    const date = f.modified.toLocaleString();
    console.log(`  ${f.name.padEnd(40)} ${kb.padStart(8)} KB   ${date}`);
  }
  console.log(`\n${files.length} save(s) total`);
}

function importSave(sourcePath: string, name?: string) {
  const source = resolve(sourcePath);
  if (!existsSync(source)) {
    console.error(`File not found: ${source}`);
    process.exit(1);
  }

  const dir = getSavesDir();
  mkdirSync(dir, { recursive: true });

  const destName = name ? (name.endsWith(".json") ? name : `${name}.json`) : basename(source);
  const dest = resolve(dir, destName);
  copyFileSync(source, dest);
  console.log(`Imported: ${source}`);
  console.log(`     To: ${dest}`);
  console.log(`\nStart server with: node start.ts --save ${destName.replace(".json", "")}`);
}

function info(name: string) {
  const dir = getSavesDir();
  const file = resolve(dir, name.endsWith(".json") ? name : `${name}.json`);
  if (!existsSync(file)) {
    console.error(`Save not found: ${file}`);
    process.exit(1);
  }

  const raw = readFileSync(file, "utf-8");
  const data = JSON.parse(raw);
  const stat = statSync(file);

  console.log(`Save:     ${basename(file)}`);
  console.log(`Size:     ${(stat.size / 1024).toFixed(1)} KB`);
  console.log(`Modified: ${stat.mtime.toLocaleString()}`);
  console.log(`Keys:     ${Object.keys(data).join(", ")}`);
  console.log(`\nPreview:\n${JSON.stringify(data, null, 2).slice(0, 800)}`);
}

// --- CLI ---

const [command, ...args] = process.argv.slice(2);

switch (command) {
  case "list":
  case "ls":
    list();
    break;

  case "import":
    if (!args[0]) {
      console.error("Usage: node saves.ts import <path> [name]");
      process.exit(1);
    }
    importSave(args[0], args[1]);
    break;

  case "info":
    if (!args[0]) {
      console.error("Usage: node saves.ts info <name>");
      process.exit(1);
    }
    info(args[0]);
    break;

  default:
    console.log(`Stavka save manager

Usage: node saves.ts <command>

Commands:
  list                   List all saves
  import <path> [name]   Import a save file (optional rename)
  info <name>            Show save file details`);
    break;
}
