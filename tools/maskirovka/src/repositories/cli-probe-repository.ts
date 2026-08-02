import { spawn } from "node:child_process";
import { Context, Effect, Layer } from "effect";

import { GatewayError } from "../domain/types";

export interface ProbeResult {
  readonly ok: boolean;
  readonly output: string;
  readonly exitCode: number | null;
}

export interface CliProbeRepositoryService {
  readonly run: (
    program: string,
    arguments_: readonly string[],
    timeoutMs?: number,
  ) => Effect.Effect<ProbeResult, GatewayError>;
}

export class CliProbeRepository extends Context.Service<
  CliProbeRepository,
  CliProbeRepositoryService
>()("@stavka/maskirovka/CliProbeRepository") {}

export class ProcessCliProbeRepository implements CliProbeRepositoryService {
  run(
    program: string,
    arguments_: readonly string[],
    timeoutMs = 10_000,
  ): Effect.Effect<ProbeResult, GatewayError> {
    return Effect.callback((resume, signal) => {
      const child = spawn(program, [...arguments_], {
        stdio: ["ignore", "pipe", "pipe"],
        env: process.env,
      });
      let output = "";
      let settled = false;
      const append = (chunk: Buffer): void => {
        output = `${output}${chunk.toString("utf8")}`.slice(-8_000);
      };
      child.stdout.on("data", append);
      child.stderr.on("data", append);
      const timer = setTimeout(() => child.kill("SIGTERM"), timeoutMs);
      const finish = (result: ProbeResult): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resume(Effect.succeed(result));
      };
      child.once("error", (error) => {
        finish({ ok: false, output: error.message, exitCode: null });
      });
      child.once("close", (exitCode) => {
        finish({ ok: exitCode === 0, output: output.trim(), exitCode });
      });
      signal.addEventListener("abort", () => child.kill("SIGTERM"), { once: true });
      return Effect.sync(() => {
        clearTimeout(timer);
        if (!settled) child.kill("SIGTERM");
      });
    });
  }
}

export const CliProbeRepositoryLive: Layer.Layer<CliProbeRepository> =
  Layer.succeed(CliProbeRepository, new ProcessCliProbeRepository());
