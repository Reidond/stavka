# Warbench confirmatory study runbook

## Narrow theory

H1: on the frozen deterministic Warbench protocol, one pinned Codex model
controlling blue materially outperforms the greedy rule controller controlling
the same side against the same deterministic red opponent, without unacceptable
latency, malformed decisions, or provider failures.

H0: the candidate does not satisfy every predeclared gate.

This is a test of the value of an LLM in Stavka's simulated command loop. It is
not evidence of Arma Reforger integration or real-world tactical competence.

## Frozen gates

- mean score improvement at least 5%;
- win-rate improvement at least 5 percentage points;
- invalid model-decision rate no more than 2%;
- provider request-failure rate no more than 2%;
- successful-response p95 latency no more than 5 seconds;
- no scenario-family mean-score regression worse than 10%;
- ten current-schema pairs in each family and at least one real model response
  in every family.

The mechanical verdict is `PASS`, `FAIL`, or `INCONCLUSIVE`. It has no manual
override. Paired interpretation also reports mean/median deltas,
improved/tied/regressed counts, per-family deltas, and a deterministic 95%
bootstrap confidence interval.

## 1. Repository baseline

From a clean experiment branch:

```sh
pnpm install --frozen-lockfile
pnpm check
pnpm lint:tailwind
pnpm test
pnpm typecheck
pnpm build
pnpm eval -- --replay
pnpm ai:smoke
```

Do not deploy during Warbench work.

## 2. Offline qualification

```sh
pnpm warbench calibrate
```

This runs rule-versus-random twice over 100 non-holdout seeds in each scenario
family. It must prove byte-identical replay, finite/non-constant scores,
different family distributions, and a reliable rule advantage. Stop if
`ok` is false.

The protocol-v2 holdout list is deterministically derived from
`warbench-study-v2-holdout` and does not overlap calibration seeds 1-100.

## 3. Exact model and local authorization

Use an owner-only state directory outside the repository:

```sh
export WB_DATA_DIR="${XDG_STATE_HOME:-$HOME/.local/state}/stavka/warbench-v2"
install -d -m 700 "$WB_DATA_DIR"
pnpm warbench models
export WB_MODEL="<exact-model-id>"
pnpm warbench connect --data-dir "$WB_DATA_DIR"
pnpm warbench probe --model "$WB_MODEL" --data-dir "$WB_DATA_DIR"
```

The operator completes device authorization in the browser; no credential is
pasted into chat or the terminal. Continue only when the probe returns `ok:
true` and the exact requested model. Credentials remain local at mode `0600`.

## 4. Disjoint three-family smoke

```sh
SMOKE_ID="warbench-smoke-v2"
pnpm warbench create "$SMOKE_ID" --mode smoke --model "$WB_MODEL" --data-dir "$WB_DATA_DIR"
pnpm warbench run-rule "$SMOKE_ID" --data-dir "$WB_DATA_DIR"
pnpm warbench run-candidate "$SMOKE_ID" --data-dir "$WB_DATA_DIR"
pnpm warbench status "$SMOKE_ID" --data-dir "$WB_DATA_DIR"
pnpm warbench complete "$SMOKE_ID" --data-dir "$WB_DATA_DIR"
pnpm warbench verify-evidence "$SMOKE_ID" --data-dir "$WB_DATA_DIR"
pnpm warbench evidence "$SMOKE_ID" \
  --json "out/$SMOKE_ID/evidence.json" \
  --pdf "out/$SMOKE_ID/report.pdf" \
  --csv "out/$SMOKE_ID/results.csv" \
  --markdown "docs/results/$SMOKE_ID.md" \
  --data-dir "$WB_DATA_DIR"
```

Relative evidence output paths are resolved from the repository root even
though the root command delegates to the workspace CLI package.

The correct smoke verdict is `INCONCLUSIVE`: its purpose is full-path
integration, not hypothesis acceptance. Integration defects may be repaired
after smoke, but smoke/calibration outcomes must not tune the held-out protocol.

## 5. Freeze and pre-register

Run every repository gate again. Require a clean tree, commit the protocol, and
create an annotated `warbench-study-v2` tag. Before any held-out candidate slot,
create `docs/results/warbench-study-v2-plan.md` containing H1/H0, exact model,
Git SHA, Pi version, prompt hash, held-out seeds, families, simulator/evidence
versions, cadence, thresholds, interpretation, and known limitations.

## 6. Held-out confirmatory execution

```sh
STUDY_ID="warbench-study-v2"
pnpm warbench create "$STUDY_ID" --mode full --model "$WB_MODEL" --data-dir "$WB_DATA_DIR"
pnpm warbench run-rule "$STUDY_ID" --data-dir "$WB_DATA_DIR"
pnpm warbench status "$STUDY_ID" --data-dir "$WB_DATA_DIR"
pnpm warbench run-candidate "$STUDY_ID" --data-dir "$WB_DATA_DIR"
pnpm warbench status "$STUDY_ID" --data-dir "$WB_DATA_DIR"
pnpm warbench complete "$STUDY_ID" --data-dir "$WB_DATA_DIR"
pnpm warbench verify-evidence "$STUDY_ID" --data-dir "$WB_DATA_DIR"
pnpm warbench evidence "$STUDY_ID" \
  --json "out/$STUDY_ID/evidence.json" \
  --pdf "out/$STUDY_ID/report.pdf" \
  --csv "out/$STUDY_ID/results.csv" \
  --markdown "docs/results/$STUDY_ID.md" \
  --data-dir "$WB_DATA_DIR"
```

During candidate execution:

- never delete or overwrite a slot;
- never retry an individual provider or invalid-output failure;
- resume an interrupted command by executing missing slots only;
- do not inspect partial tactical scores;
- do not change model, prompt, simulator, scoring, protocol, commit, or working
  tree; and
- do not deploy.

Any defect requiring such a change must use `pnpm warbench invalidate
<studyId>` and a new study ID.

## 7. Evidence and interpretation

JSON, PDF, CSV, and Markdown must derive from the same digest-verified evidence
object. Record SHA-256 hashes for JSON and PDF, then attach them to the GitHub
release for the frozen tag without credentials or raw authorization diagnostics.

- `PASS` with paired CI above zero: the narrow theory is supported.
- `PASS` with CI crossing zero: product gates pass, but a larger confirmatory
  study is warranted.
- `FAIL`: this pinned model/prompt did not beat the fallback under the protocol.
- `INCONCLUSIVE`: incomplete or unreliable integration prevents a tactical
  conclusion.
