import { Data, Effect } from "effect";
import { chmod, mkdir, open, readFile } from "node:fs/promises";
import { join } from "node:path";

import {
  ProviderFailure,
  controllerFromCompleter,
  makeScenario,
  type CandidateProvider,
} from "@stavka/warbench-core";
import {
  codexJsonCompleter,
  pollDeviceAuthorization,
  refreshCodexCredentials,
  startDeviceAuthorization,
  type CodexCredentials,
} from "@stavka/model-provider-pi";

/**
 * Operator-local Codex provider adapter. Credentials live in a file under the
 * operator's own data directory (never in browser storage, never committed)
 * and are refreshed in place when expired.
 */

export class CodexCredentialsMissing extends Data.TaggedError("CodexCredentialsMissing")<{
  readonly message: string;
}> {}

const credentialsPath = (dataDir: string): string => join(dataDir, "codex-credentials.json");

export const readCodexCredentials = (
  dataDir: string,
): Effect.Effect<CodexCredentials, CodexCredentialsMissing> =>
  Effect.tryPromise({
    try: async () => {
      const raw = await readFile(credentialsPath(dataDir), "utf8");
      const parsed = JSON.parse(raw) as CodexCredentials;
      if (!parsed.access || !parsed.accountId) {
        throw new Error("credentials missing access token or account id");
      }
      return parsed;
    },
    catch: (cause) =>
      new CodexCredentialsMissing({
        message:
          cause instanceof Error
            ? `No usable Codex credentials at ${credentialsPath(dataDir)}: ${cause.message}`
            : "No usable Codex credentials",
      }),
  });

export const writeCodexCredentials = (
  dataDir: string,
  credentials: CodexCredentials,
): Effect.Effect<void> =>
  Effect.promise(async () => {
    await mkdir(dataDir, { recursive: true, mode: 0o700 });
    await chmod(dataDir, 0o700);

    const handle = await open(credentialsPath(dataDir), "w", 0o600);
    try {
      // `mode` only applies when a file is created. Tighten an existing file
      // before replacing its contents so refreshed OAuth tokens are never
      // written through group/world-readable permissions.
      await handle.chmod(0o600);
      await handle.writeFile(`${JSON.stringify(credentials, null, 2)}\n`, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
  });

const toProviderFailure = (error: { readonly message: string }): ProviderFailure =>
  new ProviderFailure({ message: error.message });

const asProviderFailure = (error: CodexCredentialsMissing): ProviderFailure =>
  new ProviderFailure({ message: error.message });

const ensureFresh = (dataDir: string): Effect.Effect<CodexCredentials, ProviderFailure> =>
  readCodexCredentials(dataDir).pipe(
    Effect.mapError(asProviderFailure),
    Effect.flatMap((credentials) => {
      if (credentials.expires > Date.now() + 60_000) return Effect.succeed(credentials);
      return refreshCodexCredentials(credentials.refresh, credentials.accountId).pipe(
        Effect.mapError(
          (error) =>
            new ProviderFailure({
              message: `Codex token refresh failed (${error.operation}): ${error.message}`,
            }),
        ),
        Effect.flatMap((refreshed) =>
          Effect.as(writeCodexCredentials(dataDir, refreshed), refreshed),
        ),
      );
    }),
  );

/**
 * A {@link CandidateProvider} whose probe executes one real model decision on
 * the seed-1 balanced scenario through the full validation pipeline.
 * Candidate studies cannot start unless that probe observes a response.
 */
export const liveCodexProvider = (
  dataDir: string,
  side: "blue" | "red" = "blue",
): CandidateProvider => ({
  probe: () =>
    ensureFresh(dataDir).pipe(
      Effect.flatMap((credentials) =>
        controllerFromCompleter("codex-probe", codexJsonCompleter(credentials), side)
          .decide(makeScenario(1))
          .pipe(
            Effect.map((decision) => ({ model: decision.model })),
            Effect.mapError(
              (error): ProviderFailure =>
                new ProviderFailure({
                  message: `${error.reason}: ${error.message}${
                    error.diagnostic?.status === undefined
                      ? ""
                      : ` (HTTP ${error.diagnostic.status})`
                  }`,
                  ...(error.diagnostic ? { diagnostic: error.diagnostic } : {}),
                }),
            ),
          ),
      ),
    ),
  controllerFor: (requestedModel, controllerSide) =>
    ensureFresh(dataDir).pipe(
      Effect.flatMap((credentials) =>
        Effect.succeed(
          controllerFromCompleter(
            "codex-candidate",
            codexJsonCompleter(credentials, { requestedModel }),
            controllerSide,
          ),
        ),
      ),
    ),
});

/** Run the device authorization flow and store the resulting credentials locally. */
export const runDeviceConnect = (
  dataDir: string,
): Effect.Effect<
  { readonly userCode: string; readonly verificationUri: string },
  ProviderFailure
> =>
  Effect.gen(function* () {
    const start = yield* startDeviceAuthorization.pipe(Effect.mapError(toProviderFailure));
    yield* Effect.logInfo(
      `Open ${start.verificationUri} and confirm code ${start.userCode}. Polling every ${start.intervalSeconds}s...`,
    );

    const intervalMs = Math.max(1, start.intervalSeconds) * 1000;
    const pollLoop = (): Effect.Effect<CodexCredentials, ProviderFailure> =>
      pollDeviceAuthorization(start.deviceAuthId, start.userCode).pipe(
        Effect.mapError(toProviderFailure),
        Effect.flatMap((outcome) =>
          outcome.pending
            ? Effect.sleep(`${intervalMs} millis`).pipe(Effect.andThen(pollLoop()))
            : Effect.succeed(outcome.credentials),
        ),
      );

    const credentials = yield* pollLoop();
    yield* writeCodexCredentials(dataDir, credentials);
    return { userCode: start.userCode, verificationUri: start.verificationUri };
  });

export interface ProbeOutcome {
  readonly ok: boolean;
  readonly model?: string;
  readonly message?: string;
  /** Sanitized upstream diagnostics per the unification handoff §12. */
  readonly diagnostic?: {
    readonly status?: number;
    readonly contentType?: string;
    readonly cfRay?: string;
    readonly cfMitigated?: string;
    readonly requestId?: string;
    readonly category?: string;
  };
}

/**
 * One live Codex request through the full validation pipeline. Never logs
 * authorization headers, account ids, tokens, or challenge bodies — only the
 * sanitized diagnostic fields needed to classify worker-direct vs runner
 * transport failures.
 */
export const probeCodex = (dataDir: string): Effect.Effect<ProbeOutcome> =>
  Effect.match(liveCodexProvider(dataDir).probe(), {
    onFailure: (failure): ProbeOutcome => ({
      ok: false,
      message: failure.message,
      ...(failure.diagnostic ? { diagnostic: failure.diagnostic } : {}),
    }),
    onSuccess: (probed): ProbeOutcome => ({ ok: true, model: probed.model }),
  });
