#!/usr/bin/env node
import { NodeRuntime } from "@effect/platform-node";
import { Console, Effect, Option } from "effect";
import { argv } from "node:process";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import {
  assembleEvidence,
  createStudyInputToManifest,
  decisionSystemPrompt,
  evaluateHypothesis,
  runCandidateArm,
  runRuleArm,
  type StudyEvidenceObject,
} from "@stavka/warbench-core";
import { renderHypothesisPdf } from "@stavka/warbench-report";

import { liveCodexProvider, probeCodex, runDeviceConnect } from "./codex";
import { FileStudyStore } from "./store";

const PI_VERSION = "0.84.2";
const PROTOCOL_VERSION = "1";

const usage = `warbench — independent rule-vs-model benchmark CLI

Usage:
  warbench connect [--data-dir DIR]
      Run the Codex device authorization flow and store credentials locally.

  warbench probe [--data-dir DIR]
      Execute one live Codex request and print sanitized diagnostics
      (status, content-type, cf-ray, cf-mitigated, x-request-id, category).
      Never prints tokens, account ids, or challenge bodies.

  warbench create <studyId> --mode smoke|full [--model ID] [--data-dir DIR]
      Freeze a study manifest. Full mode requires 3 families x 10 seeds x 2 arms.

  warbench run-rule <studyId> [--data-dir DIR]
      Execute the deterministic rule arm (also completes rule-only smoke studies).

  warbench run-candidate <studyId> [--data-dir DIR]
      Probe Codex with one real request, then execute the candidate arm.
      Refuses to start unless the probe observes a genuine model response.

  warbench complete <studyId> [--data-dir DIR]
      Complete the study and freeze its evidence digest. Terminal.

  warbench evidence <studyId> [--json PATH] [--pdf PATH] [--data-dir DIR]
      Print the evaluation summary; optionally export JSON and a PDF report,
      both derived from the same evidence object.
`;

const digestSha256 = async (value: string): Promise<string> => {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
};

const gitSha = (): Effect.Effect<string> =>
  Effect.tryPromise({
    try: async () => {
      const result = await promisify(execFile)("git", ["rev-parse", "HEAD"]);
      return result.stdout.trim();
    },
    // Outside a repository the SHA is simply unknown; studies record it verbatim.
    catch: () => new Error("git unavailable"),
  }).pipe(Effect.orElseSucceed(() => "unknown"));

interface Flags {
  readonly positional: ReadonlyArray<string>;
  readonly dataDir: string;
  readonly mode: Option.Option<"smoke" | "full">;
  readonly model: Option.Option<string>;
  readonly jsonOut: Option.Option<string>;
  readonly pdfOut: Option.Option<string>;
}

const parseFlags = (input: ReadonlyArray<string>): Flags => {
  const positional: string[] = [];
  let dataDir = ".warbench";
  let mode: Option.Option<"smoke" | "full"> = Option.none();
  let model: Option.Option<string> = Option.none();
  let jsonOut: Option.Option<string> = Option.none();
  let pdfOut: Option.Option<string> = Option.none();

  for (let index = 0; index < input.length; index += 1) {
    const value = input[index];
    if (value === undefined) continue;
    const next = input[index + 1];
    switch (value) {
      case "--data-dir": {
        if (next) {
          dataDir = next;
          index += 1;
        }
        break;
      }
      case "--mode": {
        if (next === "smoke" || next === "full") {
          mode = Option.some(next);
          index += 1;
        }
        break;
      }
      case "--model": {
        if (next) {
          model = Option.some(next);
          index += 1;
        }
        break;
      }
      case "--json": {
        if (next) {
          jsonOut = Option.some(next);
          index += 1;
        }
        break;
      }
      case "--pdf": {
        if (next) {
          pdfOut = Option.some(next);
          index += 1;
        }
        break;
      }
      default:
        positional.push(value);
    }
  }
  return { positional, dataDir, mode, model, jsonOut, pdfOut };
};

const printEvidence = (evidence: StudyEvidenceObject): Effect.Effect<void> =>
  Console.log(
    JSON.stringify(
      {
        studyId: evidence.manifest.id,
        status: evidence.manifest.status,
        hypothesis: evidence.hypothesis,
        baselineRuns: evidence.baseline.runs,
        candidateRuns: evidence.candidate?.runs ?? 0,
        results: evidence.results.length,
        digest: evidence.digest,
      },
      null,
      2,
    ),
  );

/** Collapse typed store/provider failures into plain CLI errors with messages. */
const asError = <E extends { readonly message: string }>(error: E): Error =>
  error instanceof Error ? error : new Error(error.message);

const program = (): Effect.Effect<void, unknown> =>
  Effect.gen(function* () {
    const flags = parseFlags(argv.slice(2));
    const [command = "help", studyId] = flags.positional;
    const store = new FileStudyStore(resolve(flags.dataDir));

    if (command === "help" || command === undefined) {
      yield* Console.log(usage);
      return;
    }

    if (command === "connect") {
      const result = yield* runDeviceConnect(resolve(flags.dataDir)).pipe(Effect.mapError(asError));
      yield* Console.log(`Codex connected for code ${result.userCode}.`);
      return;
    }

    if (command === "probe") {
      const outcome = yield* probeCodex(resolve(flags.dataDir));
      yield* Console.log(JSON.stringify(outcome, null, 2));
      if (!outcome.ok) yield* Effect.fail(new Error("Codex probe failed"));
      return;
    }

    if (!studyId) {
      return yield* Effect.fail(new Error(`Missing study id for ${command}`));
    }

    switch (command) {
      case "create": {
        const requestedMode = Option.getOrElse(flags.mode, (): "smoke" | "full" => "full");
        const manifest = createStudyInputToManifest({
          id: studyId,
          mode: requestedMode,
          protocolVersion: PROTOCOL_VERSION,
          gitSha: yield* gitSha(),
          piVersion: PI_VERSION,
          modelId: Option.getOrElse(flags.model, () => "gpt-5.1-codex-mini"),
          promptHash: yield* Effect.promise(() => digestSha256(decisionSystemPrompt("blue"))),
        });
        yield* store.createStudy(manifest).pipe(Effect.mapError(asError));
        yield* Console.log(
          `Created ${requestedMode} study ${studyId}: ${manifest.families.length} families x ${manifest.seeds.length} seeds x 2 arms.`,
        );
        return;
      }
      case "run-rule": {
        const results = yield* runRuleArm(store, studyId).pipe(Effect.mapError(asError));
        yield* Console.log(`Recorded ${results.length} rule slots for ${studyId}.`);
        return;
      }
      case "run-candidate": {
        const provider = liveCodexProvider(resolve(flags.dataDir));
        const results = yield* runCandidateArm(store, studyId, provider).pipe(
          Effect.mapError(asError),
        );
        yield* Console.log(`Recorded ${results.length} candidate slots for ${studyId}.`);
        return;
      }
      case "complete": {
        const digest = yield* store.completeStudy(studyId).pipe(Effect.mapError(asError));
        yield* Console.log(`Study ${studyId} completed. Digest ${digest}`);
        return;
      }
      case "evidence": {
        const evidence = yield* assembleEvidence(store, studyId).pipe(Effect.mapError(asError));
        yield* printEvidence(evidence);

        const jsonOut = flags.jsonOut;
        if (Option.isSome(jsonOut)) {
          // JSON export derives from the assembled evidence object.
          yield* Effect.promise(() =>
            writeFile(jsonOut.value, `${JSON.stringify(evidence, null, 2)}\n`, "utf8"),
          );
          yield* Console.log(`Wrote JSON evidence to ${jsonOut.value}`);
        }
        const pdfOut = flags.pdfOut;
        if (Option.isSome(pdfOut)) {
          // The PDF report derives from the same evaluation object.
          const hypothesis = evaluateHypothesis(evidence.baseline, evidence.candidate);
          yield* Effect.promise(() => writeFile(pdfOut.value, renderHypothesisPdf(hypothesis)));
          yield* Console.log(`Wrote PDF report to ${pdfOut.value}`);
        }
        return;
      }
      default:
        yield* Effect.fail(new Error(`Unknown command ${command}\n\n${usage}`));
    }
  });

NodeRuntime.runMain(program());
