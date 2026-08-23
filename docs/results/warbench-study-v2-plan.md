# Warbench study v2 preregistration

This plan was frozen before any held-out candidate slot was executed. The
three-pair smoke study used calibration seed 1 only, returned `INCONCLUSIVE`,
and was used solely to verify the integration path. Its tactical results were
not used to change this protocol.

## Hypotheses

- **H1:** On the frozen deterministic Warbench protocol, `gpt-5.6-sol`
  controlling blue materially outperforms the greedy rule controller
  controlling the same side against the same deterministic red opponent,
  while satisfying every reliability and latency gate below.
- **H0:** The candidate does not satisfy every predeclared gate.

The mechanical verdict has no manual override.

## Frozen identity

- Study ID: `warbench-study-v2`
- Protocol implementation Git SHA:
  `867d5d65a985b88c783a835db0e708fd3e9e2f4c`
- Frozen execution ref: annotated tag `warbench-study-v2`; the tag commit adds
  only this preregistration and the frozen smoke summary on top of the protocol
  implementation commit above.
- Protocol version: `2`
- Evidence schema version: `3`
- Pi version: `0.84.2`
- Exact model ID: `gpt-5.6-sol`
- Blue system-prompt SHA-256:
  `b2357bfecc158fccdbc2da14c0f55d9a072709243a4fe0d300fad03d6835da46`
- Scenario families: `balanced`, `north-pressure`, `south-pressure`
- Match duration: 40 deterministic simulation ticks
- Decision cadence: every 5 ticks, for 8 candidate decisions per scenario
- Candidate retries per decision: 0
- Pairing: the rule and candidate control blue for the same family and seed;
  both face the same deterministic red rule controller.

## Held-out seeds

These seeds were derived before execution from the fixed label
`warbench-study-v2-holdout` and are disjoint from calibration seeds 1-100:

1. `1448804357`
2. `1636626848`
3. `1904015487`
4. `254880722`
5. `1625676041`
6. `1853198036`
7. `570666019`
8. `1017094950`
9. `1514233933`
10. `1168409928`

The final grid contains 30 paired scenarios and exactly 60 immutable result
slots. Completion rejects missing, duplicate, extra, wrong-model, or
wrong-schema slots.

## Acceptance gates

All gates must pass:

- mean score improvement at least 5%;
- win-rate improvement at least 5 percentage points;
- invalid model-decision rate no more than 2%;
- provider request-failure rate no more than 2%;
- successful-response p95 latency no more than 5 seconds;
- no scenario-family mean-score regression worse than 10%;
- exactly ten current-schema pairs in every family; and
- at least one genuine pinned-model response in every family.

The paired analysis also reports mean and median score deltas,
improved/tied/regressed counts, per-family deltas, and a deterministic 10,000
resample 95% bootstrap confidence interval.

## Execution and interpretation

Run the full rule arm first, inspect only slot counts, then execute only missing
candidate slots. Do not inspect partial tactical scores. Never overwrite or
retry an individual slot. The candidate command requires the frozen Git SHA
and a clean working tree. Any defect requiring a code, prompt, model, seed,
threshold, or protocol change invalidates the study and requires a new ID.

- `PASS` with the paired interval above zero supports H1 within this simulator.
- `PASS` with the interval crossing zero passes product gates but warrants a
  larger confirmatory study.
- `FAIL` means this pinned model and prompt did not beat the fallback under the
  protocol.
- `INCONCLUSIVE` means incomplete or unreliable integration prevents a tactical
  conclusion.

## Known limitations

- This is a deterministic synthetic simulator, not Arma Reforger or evidence of
  real-world tactical competence.
- Only one model, one prompt, one blue-side controller role, and one
  deterministic opponent are tested.
- The model ID and client package are pinned, but hosted model weights and
  provider infrastructure are opaque and may change independently.
- Thirty pairs provide a bounded product evaluation, not a broad scientific
  claim; the bootstrap interval is descriptive of this frozen scenario set.
- Latency is measured from this operator machine and includes provider/network
  conditions during execution.
- Rule results are generated before candidate results, so execution order is
  fixed rather than counterbalanced.
