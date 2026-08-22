import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";

const bundlePath = resolve(process.argv[2] ?? "dist/container.js");
const metafilePath = resolve(process.argv[3] ?? "container-meta.json");
const host = "127.0.0.1";
const port = 49_141;
const startupTimeoutMs = 15_000;
const shutdownTimeoutMs = 5_000;

const appendBounded = (current, chunk) => `${current}${chunk.toString("utf8")}`.slice(-16_000);

const moduleSpecifiers = (source) => {
  const specifiers = new Set();
  const patterns = [
    /\bfrom\s*["'](@stavka\/[^"']+)["']/gu,
    /\bimport\s*\(\s*["'](@stavka\/[^"']+)["']\s*\)/gu,
    /\bimport\s*["'](@stavka\/[^"']+)["']/gu,
  ];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) specifiers.add(match[1]);
  }
  return [...specifiers].sort();
};

const packageName = (specifier) =>
  specifier.startsWith("@") ? specifier.split("/").slice(0, 2).join("/") : specifier.split("/")[0];

const isBareSpecifier = (specifier) =>
  !specifier.startsWith("node:") && !specifier.startsWith(".") && !specifier.startsWith("/");

const assertRuntimeExternal = (specifier, runtimeNodeModules, requireFromBundle) => {
  const root = resolve(runtimeNodeModules, packageName(specifier));
  if (!existsSync(root)) {
    throw new Error(`runtime dependency ${specifier} is missing from ${runtimeNodeModules}`);
  }

  let resolved;
  try {
    resolved = requireFromBundle.resolve(specifier);
  } catch {
    try {
      resolved = import.meta.resolve(specifier);
    } catch (error) {
      throw new Error(
        `runtime dependency ${specifier} cannot be resolved from ${runtimeNodeModules}: ${String(error)}`,
      );
    }
  }

  const resolvedPath = resolved.startsWith("file:") ? new URL(resolved).pathname : resolved;
  if (!existsSync(resolvedPath)) {
    throw new Error(`runtime dependency ${specifier} resolved to a missing path: ${resolved}`);
  }
};

const assertPortableBundle = async () => {
  const [source, metafileSource] = await Promise.all([
    readFile(bundlePath, "utf8"),
    readFile(metafilePath, "utf8"),
  ]);
  const metadata = JSON.parse(metafileSource);
  const output = Object.entries(metadata.outputs).find(
    ([path]) => resolve(path) === bundlePath,
  )?.[1];
  if (!output) {
    throw new Error(`esbuild metadata does not describe ${bundlePath}`);
  }

  const unresolved = new Set(moduleSpecifiers(source));
  const runtimeNodeModules = resolve(dirname(bundlePath), "..", "node_modules");
  const requireFromBundle = createRequire(bundlePath);
  for (const imported of output.imports ?? []) {
    if (imported.external && imported.path.startsWith("@stavka/")) {
      unresolved.add(imported.path);
    }
    if (imported.external && isBareSpecifier(imported.path)) {
      assertRuntimeExternal(imported.path, runtimeNodeModules, requireFromBundle);
    }
  }
  if (unresolved.size > 0) {
    throw new Error(`bundle retains first-party module imports: ${[...unresolved].join(", ")}`);
  }
};

const waitForExit = (child) => {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve({ code: child.exitCode, signal: child.signalCode });
  }
  return new Promise((resolveExit) => {
    child.once("exit", (code, signal) => resolveExit({ code, signal }));
  });
};

const waitForHealth = async (child, exited, output) => {
  const deadline = Date.now() + startupTimeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      const result = await exited;
      throw new Error(
        `container entrypoint exited before health check (${JSON.stringify(result)})\n${output()}`,
      );
    }
    try {
      const response = await fetch(`http://${host}:${port}/healthz`, {
        signal: AbortSignal.timeout(1_000),
      });
      if (response.ok) {
        await response.arrayBuffer();
        return;
      }
      lastError = new Error(`health check returned HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
  }
  throw new Error(
    `container entrypoint did not become healthy within ${startupTimeoutMs}ms: ${
      lastError instanceof Error ? lastError.message : String(lastError)
    }\n${output()}`,
  );
};

const stopChild = async (child, exited) => {
  if (child.exitCode !== null || child.signalCode !== null) return await exited;
  child.kill("SIGTERM");
  const result = await Promise.race([
    exited,
    new Promise((resolveTimeout) => setTimeout(() => resolveTimeout(undefined), shutdownTimeoutMs)),
  ]);
  if (!result) {
    child.kill("SIGKILL");
    await exited;
    throw new Error(`container entrypoint did not stop within ${shutdownTimeoutMs}ms`);
  }
  return result;
};

await assertPortableBundle();

const smokeRoot = await mkdtemp(`${tmpdir()}/maskirovka-container-smoke-`);
let output = "";
const child = spawn(process.execPath, [bundlePath], {
  cwd: dirname(dirname(bundlePath)),
  env: {
    CI: "true",
    DEV_ACCESS_EMAIL: "container-smoke@localhost",
    ENVIRONMENT: "local",
    HOME: smokeRoot,
    MASKIROVKA_CACHE_DIR: `${smokeRoot}/cache`,
    MASKIROVKA_COMMANDER_SEAT: "mock",
    MASKIROVKA_HEAVY_SEAT: "mock",
    MASKIROVKA_HOST: host,
    MASKIROVKA_MODE: "replay",
    MASKIROVKA_PORT: String(port),
    MASKIROVKA_SERGEANT_SEAT: "mock",
    MASKIROVKA_STATE_DIR: `${smokeRoot}/state`,
    NODE_ENV: "production",
    PATH: `${smokeRoot}/empty-bin`,
    TMPDIR: smokeRoot,
  },
  stdio: ["ignore", "pipe", "pipe"],
});
child.stdout.on("data", (chunk) => {
  output = appendBounded(output, chunk);
});
child.stderr.on("data", (chunk) => {
  output = appendBounded(output, chunk);
});
const exited = waitForExit(child);

try {
  await waitForHealth(child, exited, () => output);
  const result = await stopChild(child, exited);
  if (result.code !== 0 && result.code !== 130 && result.signal !== "SIGTERM") {
    throw new Error(
      `container entrypoint failed during shutdown (${JSON.stringify(result)})\n${output}`,
    );
  }
  console.log(`Maskirovka container smoke passed at http://${host}:${port}/healthz`);
} finally {
  if (child.exitCode === null && child.signalCode === null) {
    child.kill("SIGKILL");
    await exited;
  }
  await rm(smokeRoot, { force: true, recursive: true });
}
