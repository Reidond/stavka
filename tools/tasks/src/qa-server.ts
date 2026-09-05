import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { NodeRuntime, NodeServices } from "@effect/platform-node";
import { Config, Console, Effect, FileSystem, Schema } from "effect";
import { ChildProcess } from "effect/unstable/process";
import { parse } from "jsonc-parser";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const WorkerConfig = Schema.Struct({
  name: Schema.String,
  main: Schema.String,
  compatibility_date: Schema.String,
  compatibility_flags: Schema.Array(Schema.String),
  durable_objects: Schema.Unknown,
  migrations: Schema.Unknown,
  assets: Schema.optional(
    Schema.Struct({ directory: Schema.String, binding: Schema.optional(Schema.String) }),
  ),
  services: Schema.optional(
    Schema.Array(Schema.Struct({ binding: Schema.String, service: Schema.String })),
  ),
  kv_namespaces: Schema.optional(
    Schema.Array(Schema.Struct({ binding: Schema.String, id: Schema.String })),
  ),
  r2_buckets: Schema.optional(
    Schema.Array(Schema.Struct({ binding: Schema.String, bucket_name: Schema.String })),
  ),
  no_bundle: Schema.optional(Schema.Boolean),
  rules: Schema.optional(Schema.Unknown),
  containers: Schema.optional(
    Schema.Array(
      Schema.Struct({
        class_name: Schema.String,
        image: Schema.String,
        image_build_context: Schema.String,
        instance_type: Schema.String,
        max_instances: Schema.Number,
      }),
    ),
  ),
});

const program = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const directory = yield* fs.makeTempDirectoryScoped({ prefix: "stavka-qa-" });
  const port = yield* Config.number("STAVKA_QA_PORT").pipe(Config.withDefault(18787));
  const configs: string[] = [];
  for (const relative of [
    "apps/stavka/dist/server/wrangler.json",
    "services/commander/wrangler.jsonc",
    "services/inference/wrangler.jsonc",
  ]) {
    const filename = resolve(root, relative);
    const content = yield* fs.readFileString(filename);
    const config = yield* Schema.decodeUnknownEffect(WorkerConfig)(parse(content));
    const destination = resolve(directory, `${config.name}.json`);
    yield* fs.writeFileString(
      destination,
      JSON.stringify({
        ...config,
        main: resolve(dirname(filename), config.main),
        base_dir: dirname(resolve(dirname(filename), config.main)),
        ...(config.containers
          ? {
              containers: config.containers.map((container) => ({
                ...container,
                image: resolve(dirname(filename), container.image),
                image_build_context: resolve(dirname(filename), container.image_build_context),
              })),
            }
          : {}),
        ...(config.assets
          ? {
              assets: {
                ...config.assets,
                directory: resolve(dirname(filename), config.assets.directory),
                ...(config.assets.binding ? { run_worker_first: true } : {}),
              },
            }
          : {}),
        // The local suite exercises real Workers/SQLite/R2 and service bindings.
        // Provider execution stays deterministic; no provider credential is loaded.
        vars: {
          ENVIRONMENT: "local",
          DEV_ACCESS_EMAIL: "qa@localhost",
          API_KEY: "sk-stavka-qa-local-only",
          COMMANDER_API_KEY: "sk-stavka-qa-local-only",
          COMMANDER_URL: `http://127.0.0.1:${port}`,
          STAVKA_AI_PROVIDER: "mock",
          COMMANDER_MODEL: "stavka/commander",
          SERGEANT_MODEL: "stavka/sergeant",
          HEAVY_MODEL: "stavka/heavy",
          GATEWAY_ID: "qa-gateway",
          MODEL_ALIASES: JSON.stringify({
            "stavka/commander": { seat: "mock", model: "mock-commander" },
            "stavka/sergeant": { seat: "mock", model: "mock-sergeant" },
            "stavka/heavy": { seat: "mock", model: "mock-heavy" },
          }),
          MASKIROVKA_MODE: "replay",
        },
        workers_dev: false,
        preview_urls: false,
        dev: { ip: "127.0.0.1" },
      }),
    );
    configs.push(destination);
  }
  yield* Console.log(`Stavka QA: http://127.0.0.1:${port}; isolated storage ${directory}`);
  const child = yield* ChildProcess.make(
    "pnpm",
    [
      "--filter",
      "@stavka/stavka",
      "exec",
      "wrangler",
      "dev",
      ...configs.flatMap((path) => ["-c", path]),
      "--port",
      String(port),
      "--persist-to",
      resolve(directory, "state"),
      "--show-interactive-dev-session",
      "false",
    ],
    {
      cwd: root,
      detached: false,
      killSignal: "SIGTERM",
      forceKillAfter: "3 seconds",
      stdin: "ignore",
      stdout: "inherit",
      stderr: "inherit",
    },
  );
  const code = yield* child.exitCode;
  if (code !== 0) return yield* Effect.fail(new Error(`QA server exited with ${code}`));
}).pipe(Effect.scoped, Effect.provide(NodeServices.layer));

NodeRuntime.runMain(program);
