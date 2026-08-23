#!/usr/bin/env node
import { Effect } from "effect";

import { runCli } from "./cli";

Effect.runPromise(runCli(process.argv.slice(2))).catch((cause: unknown) => {
  const message = cause instanceof Error ? cause.message : String(cause);
  process.stderr.write(`stavka: ${message}\n`);
  process.exitCode = 1;
});
