# Deploy and run the Warbench study

## GitHub production secrets

The `production` environment in `Reidond/warbench` must contain four stable secrets:

- `CLOUDFLARE_API_TOKEN` — token with permission to deploy Workers and manage Worker secrets for the target account.
- `CLOUDFLARE_ACCOUNT_ID` — target Cloudflare account id.
- `WAR_BENCH_ADMIN_KEY` — private operator key accepted by the hosted dashboard API.
- `WAR_BENCH_ENCRYPTION_KEY` — base64 encoding of exactly 32 random bytes. This must remain stable because it encrypts the stored Codex OAuth credentials.

Generate the two Warbench values locally without committing them:

```bash
openssl rand -base64 24
openssl rand -base64 32
```

Use the first output as `WAR_BENCH_ADMIN_KEY` and the second as `WAR_BENCH_ENCRYPTION_KEY`.

A successful `main` verification deploys the Worker, creates/migrates the two Durable Object classes, then installs both stable Worker secrets with Wrangler.

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

For local credential encryption, replace `WAR_BENCH_ENCRYPTION_KEY` with a real base64-encoded 32-byte value.

## Connect the ChatGPT/Codex subscription

1. Open the Warbench Worker URL.
2. Enter `WAR_BENCH_ADMIN_KEY` into the operator field.
3. Choose **Connect ChatGPT**.
4. Warbench starts OpenAI's Codex device authorization and shows the verification URL and user code.
5. Complete authorization in the OpenAI page.
6. Warbench polls the device flow, exchanges the authorization code, extracts the ChatGPT account id, encrypts the access/refresh credentials with AES-GCM, and stores them in the `AuthVault` Durable Object.
7. Expired access credentials are refreshed server-side before an experiment run.

The dashboard never stores the Codex OAuth credential in browser storage. Only the operator key is kept in `sessionStorage` for the current browser tab.

## Study procedure

A smoke run can use one seed per family, but it can only produce `INCONCLUSIVE`.

The minimum hypothesis sample is 10 seeds in each of three families for both arms:

- `balanced`
- `north-pressure`
- `south-pressure`

For every `(family, seed)` pair:

1. Run the **rule baseline**.
2. Run the **Codex candidate** using the same deterministic initial state.
3. Both sides update strategic orders at the same five-tick cadence.
4. Red is always the deterministic rule opponent.
5. Codex output is parsed as strict JSON and semantically validated. Malformed or illegal decisions count as invalid; Warbench does not repair them.

The final result is computed mechanically. It is `PASS` only when all of these gates hold after the minimum sample is reached:

- mean score is at least 5% above the rule baseline;
- win rate is at least 5 percentage points above the rule baseline;
- invalid decision rate is at most 2%;
- p95 model decision latency is at most 5 seconds;
- no scenario family's mean score regresses by more than 10%.

Otherwise the result is `FAIL`. Before the minimum sample is complete, it remains `INCONCLUSIVE`.

## Evidence report

The dashboard's **PDF report** button downloads `/api/benchmark/report.pdf`.

The PDF is generated from the same durable rows and the same `evaluateHypothesis` result used by the dashboard. It cannot independently override the benchmark conclusion.
