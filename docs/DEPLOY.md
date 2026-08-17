# Deploy and run the Warbench study

## GitHub production secrets

The `production` environment in `Reidond/warbench` must contain four stable secrets:

- `CLOUDFLARE_API_TOKEN` — token with permission to deploy Workers and manage Worker secrets for the target account.
- `CLOUDFLARE_ACCOUNT_ID` — target Cloudflare account id.
- `WAR_BENCH_ENCRYPTION_KEY` — base64 encoding of exactly 32 random bytes. This must remain stable because it encrypts the stored Codex OAuth credentials.
- `WAR_BENCH_OWNER_USER_UUID` — the unique Zero Trust user UUID returned for the only authorized owner.

Generate the Warbench encryption key locally without committing it:

```bash
openssl rand -base64 32
```

Use the output as `WAR_BENCH_ENCRYPTION_KEY`.

A successful `main` verification deploys the Worker to `warbench.sands.red`, creates or migrates the two Durable Object classes, then installs both stable Worker secrets with Wrangler. The deployment disables `workers.dev` and preview URLs so they cannot bypass Cloudflare Access.

## Local development

```bash
cp .dev.vars.example .dev.vars
vp install
vp check
vp exec tsc --noEmit
vp test --run
vp run build
vp exec wrangler dev
```

For local credential encryption, replace `WAR_BENCH_ENCRYPTION_KEY` with a real base64-encoded 32-byte value and set `WAR_BENCH_OWNER_USER_UUID` to the simulated Access identity UUID.

## Connect and validate the ChatGPT/Codex subscription

1. Open `https://warbench.sands.red` and sign in through Cloudflare Access.
2. Choose **Connect ChatGPT**.
3. Warbench starts OpenAI's Codex device authorization and shows the verification URL and user code.
4. Complete authorization in the OpenAI page.
5. Warbench polls the device flow, exchanges the authorization code, extracts the ChatGPT account id, encrypts the access/refresh credentials with AES-GCM, and stores them in the owner's identity-bound `AuthVault` Durable Object.
6. Expired access credentials are refreshed server-side before an experiment run. The previously verified account id is retained when a refreshed token does not repeat that claim.
7. Choose **Test Codex connection**. Do not run a study until the probe reports a real model, legal order count, and nontrivial request latency.
8. If the dashboard asks for reauthorization, disconnect and connect ChatGPT again.

The dashboard never stores the Codex OAuth credential in browser storage. Cloudflare Access is the outer gate; the Worker also requires the expected Access audience and owner user UUID. Both the OAuth vault and benchmark evidence store are selected with `access-user:<user_uuid>`.

## Study procedure

A smoke run can use one seed per family, but it can only produce `INCONCLUSIVE`.

Before every study performed after a benchmark protocol or provider-integration change, choose **Clear**. Stored rows carry an evidence-schema version; legacy rows deliberately keep the report `INCONCLUSIVE` rather than being mixed into a new conclusion.

The minimum hypothesis sample is 10 seeds in each of three families for both arms:

- `balanced`
- `north-pressure`
- `south-pressure`

For every `(family, seed)` pair:

1. Run the **rule baseline**.
2. Run the **Codex candidate** using the same deterministic initial state.
3. Both sides update strategic orders at the same five-tick cadence.
4. Red is always the deterministic rule opponent.
5. Codex output is parsed as strict JSON and semantically validated. Malformed or illegal model responses count as invalid decisions; Warbench does not repair them.
6. Authentication, timeout, transport, and provider failures are counted separately as request failures. They do not masquerade as invalid tactical decisions.

The final result is computed mechanically. It is `PASS` only when all of these gates hold after the minimum sample and valid evidence are reached:

- mean score is at least 5% above the rule baseline;
- win rate is at least 5 percentage points above the rule baseline;
- invalid model-decision rate is at most 2%;
- provider request-failure rate is at most 2%;
- p95 successful model-response latency is at most 5 seconds;
- no scenario family's mean score regresses by more than 10%.

A conclusion also requires current-schema evidence and at least one actual model response in every scenario family. A provider outage, missing account id, stale evidence, or zero live model responses produces `INCONCLUSIVE`, even if the run counters meet the minimum sample.

## Evidence report

The dashboard's **PDF report** button downloads `/api/benchmark/report.pdf`.

The PDF is generated from the same durable rows and the same `evaluateHypothesis` result used by the dashboard. It cannot independently override the benchmark conclusion. It includes actual model-response count, request-failure rate, legacy-row count, per-family evidence readiness, and sanitized failure messages.
