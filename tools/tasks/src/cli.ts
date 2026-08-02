#!/usr/bin/env node
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { NodeRuntime, NodeServices } from "@effect/platform-node";
import { Console, Data, Effect, Schema } from "effect";
import { ChildProcess } from "effect/unstable/process";

import { evaluationTask, tailwindLintTask, type TaskCommand } from "./task-plan";

const TaskName = Schema.Literals(["eval", "lint-tailwind"]);

class TaskCommandFailed extends Data.TaggedError("TaskCommandFailed")<{
  readonly label: string;
  readonly exitCode: number;
}> {}

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = resolve(packageRoot, "../..");

const runCommand = (command: TaskCommand) =>
  Effect.gen(function* () {
    yield* Console.log(`\n> ${command.label}`);
    const handle = yield* ChildProcess.make(command.executable, command.arguments, {
      cwd: repositoryRoot,
      detached: false,
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
    });
    const exitCode = yield* handle.exitCode;
    if (exitCode !== 0) {
      return yield* Effect.fail(
        new TaskCommandFailed({
          label: command.label,
          exitCode: Number(exitCode),
        }),
      );
    }
  }).pipe(
    Effect.scoped,
    Effect.mapError((error) =>
      error instanceof TaskCommandFailed
        ? error
        : new TaskCommandFailed({ label: command.label, exitCode: 1 }),
    ),
  );

const program = Effect.gen(function* () {
  const task = yield* Schema.decodeUnknownEffect(TaskName)(process.argv[2]);
  const forwardedArguments = process.argv.slice(3).filter((argument) => argument !== "--");
  const commands = task === "eval" ? evaluationTask(forwardedArguments) : tailwindLintTask;
  for (const command of commands) yield* runCommand(command);
}).pipe(Effect.provide(NodeServices.layer));

NodeRuntime.runMain(program);
