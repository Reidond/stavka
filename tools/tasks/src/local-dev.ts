import { resolve } from "node:path";
import { NodeRuntime, NodeServices } from "@effect/platform-node";
import { Config, Console, Data, Effect, FileSystem } from "effect";
import { ChildProcess } from "effect/unstable/process";

class LocalDevelopmentFailed extends Data.TaggedError("LocalDevelopmentFailed")<{
  readonly command: string;
  readonly exitCode: number;
}> {}

const root = resolve(import.meta.dirname, "../../..");

const run = (args: readonly string[]) =>
  Effect.gen(function* () {
    const child = yield* ChildProcess.make("pnpm", args, {
      cwd: root,
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
      killSignal: "SIGTERM",
      forceKillAfter: "5 seconds",
    });
    const code = Number(yield* child.exitCode);
    if (code !== 0) {
      return yield* Effect.fail(
        new LocalDevelopmentFailed({ command: args.join(" "), exitCode: code }),
      );
    }
  }).pipe(Effect.scoped);

const program = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const email = yield* Config.string("DEV_ACCESS_EMAIL").pipe(
    Config.withDefault("developer@localhost"),
  );
  const inferenceVariables = resolve(root, "services/inference/.dev.vars");
  if (!(yield* fs.exists(inferenceVariables))) {
    const key = yield* Effect.sync(() =>
      Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64"),
    );
    yield* fs.writeFileString(
      inferenceVariables,
      [
        'ENVIRONMENT="local"',
        `DEV_ACCESS_EMAIL=${JSON.stringify(email)}`,
        `STAVKA_PROVIDER_VAULT_KEY=${JSON.stringify(key)}`,
        'MASKIROVKA_MODE="live"',
        'MASKIROVKA_CODEX_WINDOW_CALL_LIMIT="20"',
        'MASKIROVKA_CLAUDE_MONTHLY_CREDIT_USD="1"',
        "",
      ].join("\n"),
      { mode: 0o600, flag: "wx" },
    );
  }
  yield* run(["ai:doctor"]);
  yield* Console.log(
    "Local account development: http://127.0.0.1:5173. Create your local profile, then use stavka auth push to connect a named account. Model calls use subscription credit only when requested. Run pnpm ai:up separately for the native gateway.",
  );
  yield* run([
    "--filter",
    "@stavka/stavka",
    "exec",
    "vp",
    "dev",
    "--mode",
    "local-account",
    "--host",
    "127.0.0.1",
    "--port",
    "5173",
    "--strictPort",
  ]);
}).pipe(Effect.provide(NodeServices.layer));

NodeRuntime.runMain(program);
