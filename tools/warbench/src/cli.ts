#!/usr/bin/env node
import { NodeRuntime } from "@effect/platform-node";
import { Console, Effect } from "effect";
import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { argv, env } from "node:process";
import { mkdir, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

import {
  assembleEvidence,
  createStudyInputToManifest,
  decisionSystemPrompt,
  getStudyProgress,
  runCalibration,
  runCandidateArm,
  runRuleArm,
  verifyCompletedEvidence,
  type StudyEvidenceObject,
} from "@stavka/warbench-core";
import { renderStudyEvidencePdf } from "@stavka/warbench-report";

import { availableCodexModels, liveCodexProvider, probeCodex, runDeviceConnect } from "./codex";
import { FileStudyStore } from "./store";

const PROVIDER_VERSION = "stavka-codex/1.0.0";
const PROTOCOL_VERSION = "2";
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

const defaultDataDir = (): string =>
  resolve(env.XDG_STATE_HOME ?? join(homedir(), ".local", "state"), "stavka", "warbench-v2");

const usage = `warbench - independent rule-vs-model benchmark CLI

Usage:
  warbench models
      List exact model ids supported by the first-party Codex integration.

  warbench connect [--data-dir DIR]
      Run device authorization and store credentials in an owner-only local file.

  warbench probe --model ID [--data-dir DIR]
      Execute one live request through parsing and semantic validation.

  warbench calibrate
      Run deterministic rule-vs-random calibration over 100 non-holdout seeds per family.

  warbench create <studyId> --mode smoke|full --model ID [--data-dir DIR]
      Freeze model, prompt, code, protocol, families, seeds, and cadence.

  warbench status <studyId> [--data-dir DIR]
      Print counts and missing slots only; never partial tactical scores.

  warbench run-rule <studyId> [--data-dir DIR]
  warbench run-candidate <studyId> [--data-dir DIR]
      Execute only missing immutable slots. Completed arms record zero new slots.

  warbench complete <studyId> [--data-dir DIR]
      Require the exact complete grid and freeze its canonical digest.

  warbench invalidate <studyId> [--data-dir DIR]
      Mark an abandoned defective study terminal without deleting evidence.

  warbench evidence <studyId> [--json PATH] [--pdf PATH] [--csv PATH]
      [--markdown PATH] [--interim] [--data-dir DIR]
      Export all formats from one canonical evidence object. Non-completed studies
      require the explicit --interim marker.

  warbench verify-evidence <studyId> [--data-dir DIR]
      Recompute and compare the completed study's frozen digest.

Default data directory: ${defaultDataDir()}
`;

const digestSha256 = async (value: string): Promise<string> => {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
};

const gitSha = (): Effect.Effect<string> =>
  Effect.tryPromise({
    try: async () => (await promisify(execFile)("git", ["rev-parse", "HEAD"])).stdout.trim(),
    catch: () => new Error("git unavailable"),
  }).pipe(Effect.orElseSucceed(() => "unknown"));

const gitStatusShort = (): Effect.Effect<string, Error> =>
  Effect.tryPromise({
    try: async () =>
      (await promisify(execFile)("git", ["status", "--porcelain", "--untracked-files=normal"]))
        .stdout,
    catch: (cause) => (cause instanceof Error ? cause : new Error(String(cause))),
  });

interface Flags {
  readonly positional: ReadonlyArray<string>;
  readonly dataDir: string;
  readonly mode?: "smoke" | "full";
  readonly model?: string;
  readonly jsonOut?: string;
  readonly pdfOut?: string;
  readonly csvOut?: string;
  readonly markdownOut?: string;
  readonly interim: boolean;
}

const parseFlags = (input: ReadonlyArray<string>): Flags => {
  const positional: string[] = [];
  let dataDir = defaultDataDir();
  let mode: "smoke" | "full" | undefined;
  let model: string | undefined;
  let jsonOut: string | undefined;
  let pdfOut: string | undefined;
  let csvOut: string | undefined;
  let markdownOut: string | undefined;
  let interim = false;
  const requireValue = (flag: string, value: string | undefined): string => {
    if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value`);
    return value;
  };

  for (let index = 0; index < input.length; index += 1) {
    const value = input[index];
    if (value === undefined) continue;
    const next = input[index + 1];
    switch (value) {
      case "--data-dir":
        dataDir = requireValue(value, next);
        index += 1;
        break;
      case "--mode": {
        const selected = requireValue(value, next);
        if (selected !== "smoke" && selected !== "full") {
          throw new Error("--mode must be smoke or full");
        }
        mode = selected;
        index += 1;
        break;
      }
      case "--model":
        model = requireValue(value, next);
        index += 1;
        break;
      case "--json":
        jsonOut = requireValue(value, next);
        index += 1;
        break;
      case "--pdf":
        pdfOut = requireValue(value, next);
        index += 1;
        break;
      case "--csv":
        csvOut = requireValue(value, next);
        index += 1;
        break;
      case "--markdown":
        markdownOut = requireValue(value, next);
        index += 1;
        break;
      case "--interim":
        interim = true;
        break;
      default:
        if (value.startsWith("--")) throw new Error(`Unknown option ${value}`);
        positional.push(value);
    }
  }
  return {
    positional,
    dataDir,
    ...(mode ? { mode } : {}),
    ...(model ? { model } : {}),
    ...(jsonOut ? { jsonOut } : {}),
    ...(pdfOut ? { pdfOut } : {}),
    ...(csvOut ? { csvOut } : {}),
    ...(markdownOut ? { markdownOut } : {}),
    interim,
  };
};

const asError = <E extends { readonly message: string }>(error: E): Error =>
  error instanceof Error ? error : new Error(error.message);

const writeOutput = (path: string, value: string | Uint8Array): Effect.Effect<void, Error> =>
  Effect.tryPromise({
    try: async () => {
      const outputPath = resolve(repositoryRoot, path);
      await mkdir(dirname(outputPath), { recursive: true });
      await writeFile(outputPath, value);
    },
    catch: (cause) => (cause instanceof Error ? cause : new Error(String(cause))),
  });

const csvCell = (value: unknown): string => {
  const text = Array.isArray(value) ? value.join("|") : String(value ?? "");
  return `"${text.replace(/"/g, '""')}"`;
};

const evidenceCsv = (evidence: StudyEvidenceObject): string => {
  const columns = [
    "studyId",
    "controller",
    "family",
    "seed",
    "schemaVersion",
    "model",
    "score",
    "opponentScore",
    "won",
    "invalidDecisions",
    "requestFailures",
    "decisionCount",
    "decisionLatenciesMs",
    "failureMessages",
    "recordedAt",
  ] as const;
  const rows = evidence.results.map((result) =>
    [
      result.studyId,
      result.controller,
      result.family,
      result.seed,
      result.schemaVersion,
      result.model,
      result.score,
      result.opponentScore,
      result.won,
      result.invalidDecisions,
      result.requestFailures,
      result.decisionCount,
      result.decisionLatenciesMs,
      result.failureMessages,
      result.recordedAt,
    ]
      .map(csvCell)
      .join(","),
  );
  return `${columns.join(",")}\n${rows.join("\n")}\n`;
};

const evidenceMarkdown = (evidence: StudyEvidenceObject): string => `# ${evidence.manifest.id}

- Verdict: ${evidence.hypothesis.status}
- Model: \`${evidence.manifest.modelId}\`
- Git SHA: \`${evidence.manifest.gitSha}\`
- Digest: \`${evidence.digest}\`
- Baseline runs: ${evidence.baseline.runs}
- Candidate runs: ${evidence.candidate?.runs ?? 0}
- Actual model responses: ${evidence.candidate?.modelResponseCount ?? 0}
- Request failures: ${evidence.candidate ? Object.values(evidence.candidate.families).reduce((sum, family) => sum + family.requestFailures, 0) : 0}
- Mean paired score delta: ${evidence.paired.meanScoreDelta.toFixed(2)}
- Deterministic paired 95% CI: ${evidence.paired.confidence95.lower.toFixed(2)} to ${evidence.paired.confidence95.upper.toFixed(2)}

This mechanical conclusion applies only to the frozen simulator, scenario set, model, and prompt. It does not test Arma Reforger integration or real-world tactical competence.
`;

const printEvidence = (evidence: StudyEvidenceObject): Effect.Effect<void> =>
  Console.log(
    JSON.stringify(
      {
        studyId: evidence.manifest.id,
        state: evidence.manifest.status,
        verdict: evidence.hypothesis.status,
        baselineRuns: evidence.baseline.runs,
        candidateRuns: evidence.candidate?.runs ?? 0,
        actualModelResponses: evidence.candidate?.modelResponseCount ?? 0,
        paired: evidence.paired,
        digest: evidence.digest,
      },
      null,
      2,
    ),
  );

const program = (): Effect.Effect<void, unknown> =>
  Effect.gen(function* () {
    const flags = parseFlags(argv.slice(2));
    const [command = "help", studyId] = flags.positional;
    const dataDir = resolve(flags.dataDir);
    const store = new FileStudyStore(dataDir);

    if (command === "help") {
      yield* Console.log(usage);
      return;
    }
    if (command === "models") {
      yield* Console.log(JSON.stringify({ models: availableCodexModels() }, null, 2));
      return;
    }
    if (command === "calibrate") {
      const calibration = yield* runCalibration();
      yield* Console.log(JSON.stringify(calibration, null, 2));
      if (!calibration.ok) return yield* Effect.fail(new Error("Warbench calibration failed"));
      return;
    }
    if (command === "connect") {
      const result = yield* runDeviceConnect(dataDir).pipe(Effect.mapError(asError));
      yield* Console.log(`Codex connected for verification code ${result.userCode}.`);
      return;
    }
    if (command === "probe") {
      if (!flags.model) return yield* Effect.fail(new Error("probe requires --model ID"));
      const outcome = yield* probeCodex(dataDir, flags.model);
      yield* Console.log(JSON.stringify(outcome, null, 2));
      if (!outcome.ok || outcome.model !== flags.model) {
        return yield* Effect.fail(new Error("Codex exact-model probe failed"));
      }
      return;
    }
    if (!studyId) return yield* Effect.fail(new Error(`Missing study id for ${command}`));

    switch (command) {
      case "create": {
        if (!flags.mode) return yield* Effect.fail(new Error("create requires --mode smoke|full"));
        if (!flags.model)
          return yield* Effect.fail(new Error("create requires explicit --model ID"));
        const manifest = createStudyInputToManifest({
          id: studyId,
          mode: flags.mode,
          protocolVersion: PROTOCOL_VERSION,
          gitSha: yield* gitSha(),
          providerVersion: PROVIDER_VERSION,
          modelId: flags.model,
          promptHash: yield* Effect.promise(() => digestSha256(decisionSystemPrompt("blue"))),
        });
        yield* store.createStudy(manifest).pipe(Effect.mapError(asError));
        yield* Console.log(
          `Created ${flags.mode} study ${studyId}: ${manifest.families.length} families x ${manifest.seeds.length} seeds x 2 arms.`,
        );
        return;
      }
      case "status": {
        const status = yield* getStudyProgress(store, studyId).pipe(Effect.mapError(asError));
        yield* Console.log(JSON.stringify(status, null, 2));
        return;
      }
      case "run-rule": {
        const results = yield* runRuleArm(store, studyId).pipe(Effect.mapError(asError));
        yield* Console.log(`Recorded ${results.length} new rule slots for ${studyId}.`);
        return;
      }
      case "run-candidate": {
        const manifest = yield* store.getStudy(studyId).pipe(Effect.mapError(asError));
        if (manifest.mode === "full") {
          const currentSha = yield* gitSha();
          if (currentSha !== manifest.gitSha) {
            return yield* Effect.fail(
              new Error(
                `full study is frozen at ${manifest.gitSha}; current checkout is ${currentSha}`,
              ),
            );
          }
          if ((yield* gitStatusShort()).trim()) {
            return yield* Effect.fail(
              new Error("full candidate execution requires a clean frozen working tree"),
            );
          }
        }
        const results = yield* runCandidateArm(store, studyId, liveCodexProvider(dataDir)).pipe(
          Effect.mapError(asError),
        );
        yield* Console.log(`Recorded ${results.length} new candidate slots for ${studyId}.`);
        return;
      }
      case "complete": {
        const digest = yield* store.completeStudy(studyId).pipe(Effect.mapError(asError));
        yield* Console.log(`Study ${studyId} completed. Digest ${digest}`);
        return;
      }
      case "invalidate": {
        yield* store.invalidateStudy(studyId).pipe(Effect.mapError(asError));
        yield* Console.log(`Study ${studyId} invalidated; existing evidence was retained.`);
        return;
      }
      case "verify-evidence": {
        const evidence = yield* verifyCompletedEvidence(store, studyId).pipe(
          Effect.mapError(asError),
        );
        yield* Console.log(JSON.stringify({ ok: true, studyId, digest: evidence.digest }, null, 2));
        return;
      }
      case "evidence": {
        const evidence = yield* assembleEvidence(store, studyId).pipe(Effect.mapError(asError));
        if (evidence.manifest.status !== "completed" && !flags.interim) {
          return yield* Effect.fail(
            new Error(
              "Final evidence export requires a completed study; pass --interim explicitly",
            ),
          );
        }
        yield* printEvidence(evidence);
        if (flags.jsonOut) {
          yield* writeOutput(flags.jsonOut, `${JSON.stringify(evidence, null, 2)}\n`);
        }
        if (flags.pdfOut) yield* writeOutput(flags.pdfOut, renderStudyEvidencePdf(evidence));
        if (flags.csvOut) yield* writeOutput(flags.csvOut, evidenceCsv(evidence));
        if (flags.markdownOut) yield* writeOutput(flags.markdownOut, evidenceMarkdown(evidence));
        return;
      }
      default:
        return yield* Effect.fail(new Error(`Unknown command ${command}\n\n${usage}`));
    }
  });

NodeRuntime.runMain(program());
