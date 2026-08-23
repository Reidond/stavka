import { CodexProvider } from "@stavka/model-provider-codex";
import { LocalProfileStore } from "@stavka/provider-auth/node";
import {
  pollCodexDeviceAuthorization,
  refreshCodexCredential,
  startCodexDeviceAuthorization,
  type CodexOAuthCredential,
} from "@stavka/provider-auth";
import {
  ControllerError,
  ProviderFailure,
  controllerFromCompleter,
  makeScenario,
  type CandidateProvider,
  type JsonCompleter,
} from "@stavka/warbench-core";
import { Data, Duration, Effect } from "effect";

const WARBench_ACCOUNT = "warbench";

export class CodexCredentialsMissing extends Data.TaggedError("CodexCredentialsMissing")<{
  readonly message: string;
}> {}

const profiles = (dataDir: string): LocalProfileStore => new LocalProfileStore(dataDir);

export const readCodexCredentials = (
  dataDir: string,
): Effect.Effect<CodexOAuthCredential, CodexCredentialsMissing> =>
  profiles(dataDir)
    .providerAccount("codex", WARBench_ACCOUNT)
    .pipe(
      Effect.flatMap((account) =>
        account.credential.kind === "codex-chatgpt-oauth"
          ? Effect.succeed(account.credential)
          : Effect.fail(
              new CodexCredentialsMissing({ message: "Warbench account is not ChatGPT OAuth" }),
            ),
      ),
      Effect.mapError((error) =>
        error instanceof CodexCredentialsMissing
          ? error
          : new CodexCredentialsMissing({ message: error.message }),
      ),
    );

export const writeCodexCredentials = (
  dataDir: string,
  credential: CodexOAuthCredential,
): Effect.Effect<void, { readonly message: string }> => {
  const now = new Date().toISOString();
  return profiles(dataDir).putProviderAccount({
    provider: "codex",
    name: WARBench_ACCOUNT,
    label: "Warbench",
    authKind: "chatgpt-oauth",
    credential,
    remoteAccountId: credential.accountId,
    ...(credential.workspaceId ? { remoteWorkspaceId: credential.workspaceId } : {}),
    createdAt: now,
    updatedAt: now,
  });
};

const ensureFresh = (dataDir: string): Effect.Effect<CodexOAuthCredential, ProviderFailure> =>
  readCodexCredentials(dataDir).pipe(
    Effect.mapError((error) => new ProviderFailure({ message: error.message })),
    Effect.flatMap((credential) => {
      if (credential.expiresAt > Date.now() + 60_000) return Effect.succeed(credential);
      return refreshCodexCredential(credential).pipe(
        Effect.mapError(
          (error) =>
            new ProviderFailure({
              message: `Codex token refresh failed (${error.operation}): ${error.message}`,
            }),
        ),
        Effect.flatMap((refreshed) =>
          writeCodexCredentials(dataDir, refreshed).pipe(
            Effect.mapError((error) => new ProviderFailure({ message: error.message })),
            Effect.as(refreshed),
          ),
        ),
      );
    }),
  );

export const codexJsonCompleter =
  (credential: CodexOAuthCredential, requestedModel = "gpt-5.6-sol"): JsonCompleter =>
  (request) =>
    new CodexProvider({ credential, transport: "worker-direct" })
      .complete({
        model: requestedModel,
        system: request.systemPrompt,
        input: request.userContent,
        reasoningEffort: "low",
        maxRetries: 0,
        firstEventTimeoutMs: 30_000,
        idleTimeoutMs: 30_000,
        totalTimeoutMs: 120_000,
      })
      .pipe(
        Effect.map((completion) => ({
          text: completion.text,
          model: completion.metadata.resolvedModel,
          latencyMs: completion.metadata.latencyMs,
        })),
        Effect.mapError(
          (error) =>
            new ControllerError({
              reason: error.kind === "invalid_request" ? "model" : "request",
              message: error.message,
              ...(error.status !== undefined || error.diagnostic
                ? {
                    diagnostic: {
                      ...(error.status === undefined ? {} : { status: error.status }),
                      ...(error.diagnostic?.requestId
                        ? { requestId: error.diagnostic.requestId }
                        : {}),
                      ...(error.diagnostic?.cfRay ? { cfRay: error.diagnostic.cfRay } : {}),
                      ...(error.diagnostic?.cfMitigated
                        ? { cfMitigated: error.diagnostic.cfMitigated }
                        : {}),
                    },
                  }
                : {}),
            }),
        ),
      );

export const liveCodexProvider = (
  dataDir: string,
  side: "blue" | "red" = "blue",
): CandidateProvider => ({
  probe: (requestedModel) =>
    ensureFresh(dataDir).pipe(
      Effect.flatMap((credential) =>
        controllerFromCompleter("codex-probe", codexJsonCompleter(credential, requestedModel), side)
          .decide(makeScenario(1))
          .pipe(
            Effect.map((decision) => ({ model: decision.model })),
            Effect.mapError(
              (error) =>
                new ProviderFailure({
                  message: `${error.reason}: ${error.message}`,
                  ...(error.diagnostic ? { diagnostic: error.diagnostic } : {}),
                }),
            ),
          ),
      ),
    ),
  controllerFor: (requestedModel, controllerSide) =>
    ensureFresh(dataDir).pipe(
      Effect.map((credential) =>
        controllerFromCompleter(
          "codex-candidate",
          codexJsonCompleter(credential, requestedModel),
          controllerSide,
        ),
      ),
    ),
});

export const runDeviceConnect = (
  dataDir: string,
): Effect.Effect<
  { readonly userCode: string; readonly verificationUri: string },
  ProviderFailure
> =>
  Effect.gen(function* () {
    const start = yield* startCodexDeviceAuthorization().pipe(
      Effect.mapError((error) => new ProviderFailure({ message: error.message })),
    );
    yield* Effect.logInfo(
      `Open ${start.verificationUrl} and confirm code ${start.userCode}. Polling every ${start.intervalSeconds}s...`,
    );
    while (true) {
      yield* Effect.sleep(Duration.seconds(start.intervalSeconds));
      const result = yield* pollCodexDeviceAuthorization(start).pipe(
        Effect.mapError((error) => new ProviderFailure({ message: error.message })),
      );
      if (result.pending) continue;
      yield* writeCodexCredentials(dataDir, result.credential).pipe(
        Effect.mapError((error) => new ProviderFailure({ message: error.message })),
      );
      return { userCode: start.userCode, verificationUri: start.verificationUrl };
    }
  });

export interface ProbeOutcome {
  readonly ok: boolean;
  readonly model?: string;
  readonly message?: string;
  readonly diagnostic?: {
    readonly status?: number;
    readonly contentType?: string;
    readonly cfRay?: string;
    readonly cfMitigated?: string;
    readonly requestId?: string;
    readonly category?: string;
  };
}

export const availableCodexModels = (): ReadonlyArray<string> => [
  "gpt-5.6-luna",
  "gpt-5.6-terra",
  "gpt-5.6-sol",
];

/**
 * One live Codex request through the full validation pipeline. Never logs
 * authorization headers, account ids, tokens, or challenge bodies — only the
 * sanitized diagnostic fields needed to classify worker-direct vs runner
 * transport failures.
 */
export const probeCodex = (dataDir: string, requestedModel: string): Effect.Effect<ProbeOutcome> =>
  Effect.match(liveCodexProvider(dataDir).probe(requestedModel), {
    onFailure: (failure): ProbeOutcome => ({
      ok: false,
      message: failure.message,
      ...(failure.diagnostic ? { diagnostic: failure.diagnostic } : {}),
    }),
    onSuccess: (probed): ProbeOutcome => ({ ok: true, model: probed.model }),
  });
