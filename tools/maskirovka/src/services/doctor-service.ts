import { join } from "node:path";
import { Context, Effect, Layer } from "effect";

import type { MaskirovkaConfig } from "../config";
import type { DoctorCheck, DoctorReport, GatewayError, SeatKind } from "../domain/types";
import type { CliProbeRepositoryService } from "../repositories/cli-probe-repository";
import type { DevVarsRepositoryService } from "../repositories/dev-vars-repository";

export interface DoctorOptions {
  readonly live: boolean;
  readonly write: boolean;
}

type SubscriptionSeat = Extract<SeatKind, "claude" | "codex">;

export class DoctorService {
  constructor(
    private readonly config: MaskirovkaConfig,
    private readonly probes: CliProbeRepositoryService,
    private readonly devVars: DevVarsRepositoryService,
    private readonly repositoryRoot: string,
    private readonly pingSeat: (seat: SubscriptionSeat) => Effect.Effect<void, GatewayError>,
    private readonly environment: NodeJS.ProcessEnv = process.env,
  ) {}

  run(options: DoctorOptions): Effect.Effect<DoctorReport, GatewayError> {
    return Effect.gen({ self: this }, function* () {
      const checks: DoctorCheck[] = [];

      const codexInstalled = yield* this.probes.run("codex", ["--version"]);
      const claudeInstalled = yield* this.probes.run("claude", ["--version"]);
      checks.push(
        this.toolCheck("codex-installed", "Codex CLI", codexInstalled.ok, codexInstalled.output),
      );
      checks.push(
        this.toolCheck(
          "claude-installed",
          "Claude CLI",
          claudeInstalled.ok,
          claudeInstalled.output,
        ),
      );

      const codexLogin = codexInstalled.ok
        ? yield* this.probes.run("codex", ["login", "status"])
        : { ok: false, output: "Codex CLI is not installed", exitCode: null };
      const claudeLogin = claudeInstalled.ok
        ? yield* this.probes.run("claude", ["auth", "status"])
        : { ok: false, output: "Claude CLI is not installed", exitCode: null };
      checks.push(this.loginCheck("codex-login", "Codex", codexLogin.ok, codexLogin.output));
      checks.push(this.loginCheck("claude-login", "Claude", claudeLogin.ok, claudeLogin.output));

      const overrides = ["OPENAI_API_KEY", "CODEX_API_KEY", "ANTHROPIC_API_KEY"].filter((key) =>
        Boolean(this.environment[key]),
      );
      checks.push(
        overrides.length === 0
          ? {
              id: "api-key-override",
              status: "pass",
              message: "No provider API key can silently override subscription OAuth",
            }
          : {
              id: "api-key-override",
              status: "warn",
              message: `${overrides.join(" and ")} ${overrides.length === 1 ? "is" : "are"} set; subscription seats strip these variables, while the api seat remains explicitly metered`,
            },
      );

      for (const [seat, loggedIn] of [
        ["codex", codexLogin.ok],
        ["claude", claudeLogin.ok],
      ] as const) {
        if (!options.live) {
          checks.push({
            id: `${seat}-ping`,
            status: "skip",
            message: `${seat} one-turn ping skipped; rerun doctor --live to spend subscription credit deliberately`,
          });
        } else if (!loggedIn) {
          checks.push({
            id: `${seat}-ping`,
            status: "skip",
            message: `${seat} ping skipped because login is unavailable`,
          });
        } else {
          const ping = yield* this.pingSeat(seat).pipe(
            Effect.match({
              onFailure: (error) => ({ ok: false as const, error }),
              onSuccess: () => ({ ok: true as const }),
            }),
          );
          checks.push(
            ping.ok
              ? {
                  id: `${seat}-ping`,
                  status: "pass",
                  message: `${seat} SDK one-turn ping succeeded`,
                }
              : {
                  id: `${seat}-ping`,
                  status: "fail",
                  message: `${seat} ping failed: ${ping.error.message}`,
                },
          );
        }
      }

      const wroteDevVars: string[] = [];
      if (options.write) {
        const rootFilename = join(this.repositoryRoot, ".dev.vars");
        const commanderFilename = join(this.repositoryRoot, "services/commander/.dev.vars");
        const poligonFilename = join(this.repositoryRoot, "apps/stavka/.dev.vars");
        const [commanderExisting, poligonExisting] = yield* Effect.all([
          this.devVars.read(commanderFilename),
          this.devVars.read(poligonFilename),
        ] as const);
        const usableKey = (value: string | undefined): string | undefined =>
          value && value !== "sk-stavka-replace-me" ? value : undefined;
        const commanderKey = usableKey(commanderExisting.values.API_KEY);
        const poligonKey = usableKey(poligonExisting.values.COMMANDER_API_KEY);
        const machineKey =
          usableKey(this.environment.API_KEY) ??
          commanderKey ??
          poligonKey ??
          `sk-stavka-local-${crypto.randomUUID().replaceAll("-", "")}`;
        const devEmail =
          this.environment.DEV_ACCESS_EMAIL ??
          commanderExisting.values.DEV_ACCESS_EMAIL ??
          poligonExisting.values.DEV_ACCESS_EMAIL ??
          "developer@localhost";
        const gatewayValues = {
          STAVKA_AI_PROVIDER: "openai",
          STAVKA_AI_BASE_URL: `http://${this.config.host}:${this.config.port}`,
          STAVKA_AI_KEY: this.config.apiKey ?? "maskirovka-local",
          COMMANDER_MODEL: "stavka/commander",
          SERGEANT_MODEL: "stavka/sergeant",
          HEAVY_MODEL: "stavka/heavy",
        };
        const files = [
          {
            filename: rootFilename,
            values: {
              ...gatewayValues,
              ENVIRONMENT: "local",
              DEV_ACCESS_EMAIL: devEmail,
            },
          },
          {
            filename: commanderFilename,
            values: {
              ...gatewayValues,
              API_KEY: machineKey,
              ENVIRONMENT: "local",
              DEV_ACCESS_EMAIL: devEmail,
            },
          },
          {
            filename: poligonFilename,
            values: {
              COMMANDER_URL: "http://127.0.0.1:8787",
              COMMANDER_API_KEY: machineKey,
              ENVIRONMENT: "local",
              DEV_ACCESS_EMAIL: devEmail,
            },
          },
        ];
        for (const { filename, values } of files) {
          yield* this.devVars.write(filename, values);
          wroteDevVars.push(filename);
        }
        const explicitKeyConflict =
          commanderExisting.explicitKeys.has("API_KEY") &&
          poligonExisting.explicitKeys.has("COMMANDER_API_KEY") &&
          commanderKey !== undefined &&
          poligonKey !== undefined &&
          commanderKey !== poligonKey;
        checks.push({
          id: "dev-vars",
          status: explicitKeyConflict ? "fail" : "pass",
          message: explicitKeyConflict
            ? "Preserved conflicting explicit Commander and Poligon machine keys; align them manually"
            : "Generated root, Commander, and Poligon .dev.vars with one local machine key and no provider secrets",
        });
      } else {
        checks.push({
          id: "dev-vars",
          status: "skip",
          message: ".dev.vars generation disabled",
        });
      }

      return {
        ok: checks.every((check) => check.status !== "fail"),
        checks,
        wroteDevVars,
      };
    });
  }

  private toolCheck(id: string, name: string, ok: boolean, output: string): DoctorCheck {
    return ok
      ? {
          id,
          status: "pass",
          message: `${name} installed${output ? `: ${output.split("\n")[0]}` : ""}`,
        }
      : {
          id,
          status: "warn",
          message: `${name} unavailable; mock and replay modes still work`,
        };
  }

  private loginCheck(id: string, name: string, ok: boolean, output: string): DoctorCheck {
    return ok
      ? { id, status: "pass", message: `${name} subscription login is available` }
      : {
          id,
          status: "warn",
          message: `${name} subscription login unavailable${output ? `: ${output.split("\n")[0]}` : ""}`,
        };
  }
}

export class Doctor extends Context.Service<Doctor, DoctorService>()("@stavka/maskirovka/Doctor") {}

export const DoctorLive = (service: DoctorService): Layer.Layer<Doctor> =>
  Layer.succeed(Doctor, service);
